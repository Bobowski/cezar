import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { globMatches, httpStatusOf, mentions } from './github-activity.ts';
import { GithubPoller } from './github-poller.ts';
import type { GithubAutomationDefinition } from './types.ts';

// Recorded from a public repository's REST answers, trimmed to the keys the poller reads and
// anonymised (`acme/demo`, invented logins and comment bodies).
const fixture = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/github-activity/${name}.json`, import.meta.url), 'utf8')) as T;

type Pull = { number: number; node_id: string; updated_at: string; head: { sha: string; ref: string; repo: { full_name: string } | null } };
type Comment = { id: number; html_url: string; issue_url?: string; created_at: string; updated_at: string; user: { login: string }; body: string };

const pulls = fixture<Pull[]>('pulls');
const own = pulls[0]!; // #13894, head in acme/demo
const fork = pulls[1]!; // #12942, head in a fork

function definition(
  events: GithubAutomationDefinition['events'],
  filters: Partial<GithubAutomationDefinition['filters']> = {},
  task: Partial<GithubAutomationDefinition['task']> = {},
): GithubAutomationDefinition {
  return {
    id: 'a', revision: 1, name: 'Activity', enabled: true, kind: 'github', events, intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25, ...filters },
    task: { prompt: 'Handle {{github.url}}', ...task },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const notModified = () => Object.assign(new Error('gh: HTTP 304'), { stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: W/"x"\r\n\r\n' });
const notFound = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });

/** A fake `gh api`: routes by the `repos/…` path; `--include` answers carry an ETag. */
function gh(routes: Record<string, unknown>) {
  return vi.fn(async (_executable: string, args: readonly string[]) => {
    const path = args.find((arg) => arg.startsWith('repos/'));
    if (!path || !(path in routes)) throw notFound();
    const route = routes[path];
    const value = typeof route === 'function' ? (route as (args: readonly string[]) => unknown)(args) : route;
    if (value instanceof Error) throw value;
    const body = JSON.stringify(value);
    return args.includes('--include') ? `HTTP/2.0 200 OK\r\nETag: W/"${path}"\r\n\r\n${body}` : body;
  });
}
const pathsOf = (run: ReturnType<typeof gh>) => run.mock.calls.map(([, args]) => args.find((arg) => arg.startsWith('repos/')));

describe('activity helpers', () => {
  it('reads the status of an --include answer', () => {
    expect(httpStatusOf('HTTP/2.0 304 Not Modified\r\n\r\n')).toBe(304);
    expect(httpStatusOf('HTTP/1.1 200 OK\nETag: x\n\n[]')).toBe(200);
    expect(httpStatusOf('[]')).toBe(0);
  });

  it('matches globs and whole @mentions', () => {
    expect(globMatches('release/*', 'release/v1.2')).toBe(true);
    expect(globMatches('main', 'main2')).toBe(false);
    expect(globMatches('v2.*', 'v2.103.0')).toBe(true);
    expect(mentions('ping @cezar-bot please', 'cezar-bot')).toBe(true);
    expect(mentions('mail me@cezar-bot.dev', 'cezar-bot')).toBe(false);
    expect(mentions('@cezar-bots', '@cezar-bot')).toBe(false);
  });
});

describe('comment events', () => {
  const comments = fixture<Comment[]>('issue-comments');
  const prComment: Comment = {
    ...comments[3]!, id: 777, html_url: `https://github.com/acme/demo/pull/${own.number}#issuecomment-777`,
    issue_url: `https://api.github.com/repos/acme/demo/issues/${own.number}`, body: 'Please rename this, @cezar.',
  };
  const forkComment: Comment = {
    ...comments[3]!, id: 778, html_url: `https://github.com/acme/demo/pull/${fork.number}#issuecomment-778`,
    issue_url: `https://api.github.com/repos/acme/demo/issues/${fork.number}`,
  };
  const issue = (number: number) => ({ number, node_id: `I_${number}`, title: `Issue ${number}`, html_url: `https://github.com/acme/demo/issues/${number}`, user: { login: 'erin' }, labels: [{ name: 'bug' }], assignees: [] });
  const routes = {
    'repos/acme/demo/issues/comments': [...comments, prComment, forkComment],
    [`repos/acme/demo/pulls/${own.number}`]: fixture('pull'),
    [`repos/acme/demo/pulls/${fork.number}`]: fork,
    'repos/acme/demo/issues/14449': issue(14449),
    'repos/acme/demo/issues/5924': issue(5924),
    'repos/acme/demo/issues/14785': issue(14785),
  };
  const since = '2026-10-21T00:00:00.000Z';

  it('tells PR comments from issue comments by their URL and reads each item once', async () => {
    const run = gh(routes);
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['pull_request.commented', 'issue.commented']), { since });
    const events = result.candidates.map((candidate) => [candidate.event, candidate.number, candidate.comment?.id]);
    expect(events).toContainEqual(['pull_request.commented', own.number, 777]);
    expect(events).toContainEqual(['issue.commented', 14449, comments[0]!.id]);
    // The fork PR's comment is not admitted without allowForkHeads (spec §7).
    expect(events.some(([, number]) => number === fork.number)).toBe(false);
    expect(pathsOf(run).filter((path) => path === 'repos/acme/demo/issues/14449')).toHaveLength(1);
    const pr = result.candidates.find((candidate) => candidate.comment?.id === 777)!;
    expect(pr).toMatchObject({ comment: { kind: 'issue', author: 'dave', body: 'Please rename this, @cezar.' }, branch: own.head.ref, headSha: own.head.sha });
    expect(result.cursor?.timestamp).toBe(prComment.updated_at);
  });

  it('admits a fork PR comment with allowForkHeads', async () => {
    const result = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo',
      definition(['pull_request.commented'], {}, { checkout: 'pr-head', allowForkHeads: true }), { since });
    expect(result.candidates.map((candidate) => candidate.number)).toContain(fork.number);
  });

  it('filters on the comment author and on mentions', async () => {
    const byAuthor = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo', definition(['issue.commented'], { authors: ['carol'] }), { since });
    expect(byAuthor.candidates.map((candidate) => candidate.comment?.author)).toEqual(['carol', 'carol', 'carol']);
    const mentioned = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo', definition(['pull_request.commented', 'issue.commented'], { mentions: ['cezar'] }), { since });
    expect(mentioned.candidates.map((candidate) => candidate.comment?.id)).toEqual([777]);
  });

  it('delivers into the owning run only comments from collaborators, unless authors or allowAnyAuthor say otherwise', async () => {
    const asIs = (association: string) => ({ ...prComment, author_association: association });
    const poll = (association: string, filters: Partial<GithubAutomationDefinition['filters']> = {}, deliver?: 'owning-run') =>
      new GithubPoller({ run: gh({ ...routes, 'repos/acme/demo/issues/comments': [asIs(association)] }) })
        .poll('acme', 'demo', { ...definition(['pull_request.commented'], filters), ...(deliver ? { deliver } : {}) }, { since });
    expect((await poll('NONE', {}, 'owning-run')).candidates).toEqual([]);
    expect((await poll('CONTRIBUTOR', {}, 'owning-run')).candidates).toEqual([]);
    for (const trusted of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect((await poll(trusted, {}, 'owning-run')).candidates.map((candidate) => candidate.comment?.association)).toEqual([trusted]);
    }
    expect((await poll('NONE', { authors: ['dave'] }, 'owning-run')).candidates).toHaveLength(1);
    expect((await poll('NONE', { allowAnyAuthor: true }, 'owning-run')).candidates).toHaveLength(1);
    // A new run per comment is unchanged: anyone's comment, as before.
    expect((await poll('NONE')).candidates).toHaveLength(1);
  });

  it('drops a comment cezar posted itself (loop guard)', async () => {
    const result = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo', definition(['pull_request.commented']),
      { since, traces: { shas: new Set(), comments: new Set([777]) } });
    expect(result.candidates).toEqual([]);
    // Still observed: the cursor moves past it.
    expect(result.cursor?.timestamp).toBe(prComment.updated_at);
  });

  it('observes an edit at its update time but never launches it', async () => {
    const edited = { ...comments[0]!, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' };
    const result = await new GithubPoller({ run: gh({ ...routes, 'repos/acme/demo/issues/comments': [edited] }) })
      .poll('acme', 'demo', definition(['issue.commented']), { since });
    expect(result.candidates).toEqual([]);
    expect(result.cursor).toEqual({ timestamp: '2026-10-22T00:00:00Z', tieBreaker: `comment:${edited.id}` });
  });

  it('collapses one submitted review into one candidate per PR carrying every body', async () => {
    const reviewComments = fixture<Comment[]>('review-comments');
    const run = gh({
      'repos/acme/demo/pulls/comments': [...reviewComments].reverse(),
      'repos/acme/demo/pulls/14798': { ...own, number: 14798, node_id: 'PR_14798', html_url: 'https://github.com/acme/demo/pull/14798', title: 'One', user: { login: 'alice' }, labels: [], assignees: [] },
      'repos/acme/demo/pulls/14804': { ...own, number: 14804, node_id: 'PR_14804', html_url: 'https://github.com/acme/demo/pull/14804', title: 'Two', user: { login: 'alice' }, labels: [], assignees: [] },
    });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['pull_request.review_commented']), { since: '2026-10-23T00:00:00.000Z' });
    expect(result.candidates.map((candidate) => candidate.number).sort()).toEqual([14798, 14804]);
    const batch = result.candidates.find((candidate) => candidate.number === 14798)!;
    expect(batch.comment?.kind).toBe('review');
    expect(batch.comment?.body).toContain('Synthetic comment body 1.');
    expect(batch.comment?.body).toContain('Synthetic comment body 3.');
  });
});

describe('pull_request.synchronize', () => {
  const heads = Object.fromEntries(pulls.map((pull) => [String(pull.number), { sha: pull.head.sha, ref: pull.head.ref, updatedAt: pull.updated_at }]));

  it('records the heads on first sight and fires nothing', async () => {
    const result = await new GithubPoller({ run: gh({ 'repos/acme/demo/pulls': pulls }) }).poll('acme', 'demo', definition(['pull_request.synchronize']));
    expect(result.candidates).toEqual([]);
    expect(result.activity?.prHeads).toEqual(heads);
    expect(result.activity?.etags?.pulls).toBe('W/"repos/acme/demo/pulls"');
  });

  it('fires for a head that moved, cursorless, and not for one cezar pushed', async () => {
    const before = { ...heads, [String(own.number)]: { ...heads[String(own.number)]!, sha: 'old-sha' }, [String(fork.number)]: { ...heads[String(fork.number)]!, sha: 'old-fork-sha' } };
    const run = gh({ 'repos/acme/demo/pulls': pulls });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['pull_request.synchronize']), {
      activity: { prHeads: before },
      traces: { shas: new Set([fork.head.sha]), comments: new Set() },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      event: 'pull_request.synchronize', number: own.number, headSha: own.head.sha, branch: own.head.ref, cursorless: true,
      eventId: `acme/demo:${own.node_id}:pull_request.synchronize:${own.head.sha}`,
    });
    // Cursorless candidates carry no cursor of their own.
    expect(result.cursor).toBeUndefined();
  });

  it('launches at most maxRecords per poll and holds the other moved heads for the next one', async () => {
    const before = Object.fromEntries(Object.entries(heads).map(([number, head]) => [number, { ...head, sha: 'old' }]));
    const poll = (activity: object) => new GithubPoller({ run: gh({ 'repos/acme/demo/pulls': pulls }) })
      .poll('acme', 'demo', definition(['pull_request.synchronize'], { maxRecords: 1 }), { activity });
    const first = await poll({ prHeads: before, etags: { pulls: 'W/"x"' } });
    expect(first.candidates).toHaveLength(1);
    expect(first.truncated).toBe(true);
    expect(Object.values(first.activity!.prHeads!).filter((head) => head.sha === 'old')).toHaveLength(pulls.length - 1);
    // A 304 would hand the held heads back with nothing to diff: the next poll reads in full.
    expect(first.activity?.etags?.pulls).toBeUndefined();
    const second = await poll(first.activity!);
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0]!.number).not.toBe(first.candidates[0]!.number);
  });

  it('narrows on the head branch glob', async () => {
    const before = Object.fromEntries(Object.entries(heads).map(([number, head]) => [number, { ...head, sha: 'old' }]));
    const result = await new GithubPoller({ run: gh({ 'repos/acme/demo/pulls': pulls }) }).poll('acme', 'demo',
      definition(['pull_request.synchronize'], { branches: ['fix/*'] }), { activity: { prHeads: before } });
    expect(result.candidates.map((candidate) => candidate.branch)).toEqual(['fix/project-close-filter-closed']);
  });

  it('reuses the stored heads on a 304 and sends the stored ETag', async () => {
    const run = gh({ 'repos/acme/demo/pulls': () => notModified() });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['pull_request.synchronize']), {
      activity: { prHeads: heads, etags: { pulls: 'W/"before"' } },
    });
    expect(run.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-H', 'If-None-Match: W/"before"']));
    expect(result.candidates).toEqual([]);
    expect(result.activity?.prHeads).toEqual(heads);
    expect(result.activity?.etags?.pulls).toBe('W/"before"');
  });
});

describe('check_suite.completed', () => {
  const suites = fixture<{ check_suites: Array<{ id: number; conclusion: string | null; status: string }> }>('check-suites');
  const failing = {
    ...suites,
    check_suites: suites.check_suites.map((suite) => suite.id === 83031609740 ? { ...suite, conclusion: 'failure' } : suite),
  };
  const runs = fixture<{ check_runs: Array<{ conclusion: string }> }>('check-runs');
  const failingRuns = { ...runs, check_runs: runs.check_runs.map((row, index) => index === 0 ? { ...row, conclusion: 'failure' } : row) };
  const onlyOwnHead = { [String(own.number)]: { sha: own.head.sha, ref: own.head.ref, updatedAt: own.updated_at } };
  const routes = {
    'repos/acme/demo/pulls': [own],
    [`repos/acme/demo/commits/${own.head.sha}/check-suites`]: failing,
    'repos/acme/demo/check-suites/83031609740/check-runs': failingRuns,
    [`repos/acme/demo/pulls/${own.number}`]: fixture('pull'),
  };
  const since = '2026-07-01T00:00:00.000Z';

  it('launches completed suites with runs, names the failing jobs, and skips empty app suites', async () => {
    const run = gh(routes);
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['check_suite.completed'], { conclusion: 'failure' }), { since });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      event: 'check_suite.completed', number: own.number, headSha: own.head.sha,
      check: {
        id: 83031609740, name: 'GitHub Actions', conclusion: 'failure',
        failingJobs: ['CodeQL-Build (go, manual, ./.github/codeql/codeql-config.yml)'],
        url: 'https://github.com/acme/demo/actions/runs/30619730300/job/91121153268',
      },
    });
    // Five completed suites with runs are observed; the two queued app suites are not.
    expect(result.cursor?.tieBreaker).toBe('suite:97280115623');
    expect(result.activity?.etags?.[`suites:${own.head.sha}`]).toBeDefined();
  });

  it('drops a suite on a sha cezar pushed unless includeOwnPushes', async () => {
    const traces = { shas: new Set([own.head.sha]), comments: new Set<number>() };
    const dropped = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo', definition(['check_suite.completed'], { conclusion: 'failure' }), { since, traces });
    expect(dropped.candidates).toEqual([]);
    const admitted = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo',
      definition(['check_suite.completed'], { conclusion: 'failure', includeOwnPushes: true }), { since, traces });
    expect(admitted.candidates).toHaveLength(1);
  });

  it('counts success only when asked for success', async () => {
    const result = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo', definition(['check_suite.completed'], { conclusion: 'success' }), { since });
    expect(result.candidates.map((candidate) => candidate.check?.conclusion)).toEqual(['success', 'success', 'success', 'success']);
  });

  it('skips a head whose suites answer 304', async () => {
    const run = gh({ ...routes, 'repos/acme/demo/pulls': () => notModified(), [`repos/acme/demo/commits/${own.head.sha}/check-suites`]: () => notModified() });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['check_suite.completed']), {
      since, activity: { prHeads: onlyOwnHead, etags: { pulls: 'p', [`suites:${own.head.sha}`]: 's', 'suites:gone': 'x' } },
    });
    expect(result.candidates).toEqual([]);
    expect(result.activity?.etags).toEqual({ pulls: 'p', [`suites:${own.head.sha}`]: 's' });
  });

  it('forgets the ETag of a page whose rows the record budget did not reach', async () => {
    const result = await new GithubPoller({ run: gh(routes) }).poll('acme', 'demo', definition(['check_suite.completed'], { maxRecords: 2 }), { since });
    expect(result.truncated).toBe(true);
    expect(result.activity?.etags?.[`suites:${own.head.sha}`]).toBeUndefined();
  });
});

describe('push', () => {
  const branches = fixture<Array<{ name: string; commit: { sha: string } }>>('branches');
  const compare = fixture<{ commits: Array<{ sha: string }> }>('compare');
  const after = compare.commits.at(-1)!.sha;
  const listed = [...branches, { name: 'main', commit: { sha: after } }];

  it('diffs branch heads, reads the commits between, and fires cursorless', async () => {
    const run = gh({
      'repos/acme/demo/branches': listed,
      [`repos/acme/demo/compare/old...${after}`]: compare,
    });
    const stored = { ...Object.fromEntries(branches.map((branch) => [branch.name, branch.commit.sha])), main: 'old' };
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['push']), { activity: { branchHeads: stored } });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      event: 'push', branch: 'main', headSha: after, author: 'grace', cursorless: true,
      push: { before: 'old', after, subjects: ['Defer --attach credential checks to the server', 'Merge pull request #14805 from cli/bagtoad/attach-with-installation-tokens'] },
    });
    expect(result.candidates[0]!.number).toBeUndefined();
    expect(result.activity?.branchHeads?.main).toBe(after);
  });

  it('reads an exact branch alone and ignores a push cezar made', async () => {
    const run = gh({ 'repos/acme/demo/branches/main': { name: 'main', commit: { sha: after } } });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['push'], { branches: ['main'] }), {
      activity: { branchHeads: { main: 'old' } }, traces: { shas: new Set([after]), comments: new Set() },
    });
    expect(pathsOf(run)).toEqual(['repos/acme/demo/branches/main']);
    expect(result.candidates).toEqual([]);
    expect(result.activity?.branchHeads).toEqual({ main: after });
  });

  it('records branch heads on first sight without firing', async () => {
    const result = await new GithubPoller({ run: gh({ 'repos/acme/demo/branches': listed }) }).poll('acme', 'demo', definition(['push']));
    expect(result.candidates).toEqual([]);
    expect(Object.keys(result.activity?.branchHeads ?? {})).toHaveLength(listed.length);
  });
});

describe('release.published', () => {
  const releases = fixture<Array<{ tag_name: string; prerelease: boolean; draft: boolean; published_at: string | null }>>('releases');
  const withPre = [
    { ...releases[0]!, id: 1, tag_name: 'v3.0.0-rc.1', prerelease: true },
    { ...releases[0]!, id: 2, tag_name: 'v3.0.0', draft: true, published_at: null },
    ...releases,
  ];

  it('launches published releases since the cursor, never drafts, and filters prerelease and tags', async () => {
    const run = gh({ 'repos/acme/demo/releases': withPre });
    const since = '2026-10-22T00:00:00.000Z';
    const all = await new GithubPoller({ run }).poll('acme', 'demo', definition(['release.published']), { since });
    expect(all.candidates.map((candidate) => candidate.release?.tag).sort()).toEqual(['v2.103.1', 'v2.103.2', 'v3.0.0-rc.1']);
    expect(all.candidates[0]!.number).toBeUndefined();
    const stable = await new GithubPoller({ run }).poll('acme', 'demo', definition(['release.published'], { prerelease: false, tags: ['v2.*'] }), { since });
    expect(stable.candidates.map((candidate) => candidate.release?.tag)).toEqual(['v2.103.1', 'v2.103.2']);
  });

  it('reads nothing new on a 304', async () => {
    const run = gh({ 'repos/acme/demo/releases': () => notModified() });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['release.published']), { activity: { etags: { releases: 'r' } } });
    expect(result.candidates).toEqual([]);
    expect(result.activity?.etags).toEqual({ releases: 'r' });
  });
});

describe('heads outside the capped windows (spec 2026-10-23-github-events §3)', () => {
  const heads = Object.fromEntries(pulls.map((pull) => [String(pull.number), { sha: pull.head.sha, ref: pull.head.ref, updatedAt: pull.updated_at }]));
  const stale = { sha: 'old-sha', ref: own.head.ref, updatedAt: '2026-09-01T00:00:00Z' };
  const others = pulls.filter((pull) => pull.number !== own.number);

  it('keeps the head of a PR that left the open-PR window, so its next head change still fires', async () => {
    const left = await new GithubPoller({ run: gh({ 'repos/acme/demo/pulls': others }) }).poll('acme', 'demo',
      definition(['pull_request.synchronize']), { activity: { prHeads: { ...heads, [String(own.number)]: stale } } });
    expect(left.candidates).toEqual([]);
    expect(left.activity?.prHeads?.[String(own.number)]).toMatchObject({ sha: 'old-sha', left: true });

    const back = await new GithubPoller({ run: gh({ 'repos/acme/demo/pulls': pulls }) }).poll('acme', 'demo',
      definition(['pull_request.synchronize']), { activity: { prHeads: left.activity!.prHeads } });
    expect(back.candidates.map((candidate) => [candidate.event, candidate.number])).toEqual([['pull_request.synchronize', own.number]]);
    expect(back.activity?.prHeads?.[String(own.number)]).toEqual(heads[String(own.number)]);
  });

  it('reads a PR outside the window through the comment that names it, and fires its moved head', async () => {
    const comment = {
      id: 901, html_url: `https://github.com/acme/demo/pull/${own.number}#issuecomment-901`,
      issue_url: `https://api.github.com/repos/acme/demo/issues/${own.number}`,
      created_at: '2026-10-23T20:00:00Z', updated_at: '2026-10-23T20:00:00Z', user: { login: 'dave' }, body: 'pushed a fix',
    };
    const run = gh({
      'repos/acme/demo/pulls': others,
      'repos/acme/demo/issues/comments': [comment],
      [`repos/acme/demo/pulls/${own.number}`]: fixture('pull'),
    });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['pull_request.synchronize', 'pull_request.commented']), {
      since: '2026-10-23T00:00:00.000Z',
      activity: { prHeads: { ...heads, [String(own.number)]: { ...stale, left: true } } },
    });
    expect(result.candidates.map((candidate) => candidate.event).sort()).toEqual(['pull_request.commented', 'pull_request.synchronize']);
    expect(result.activity?.prHeads?.[String(own.number)]).toMatchObject({ sha: own.head.sha, left: true });
    // A head outside the window is never a check-suite read.
    const suites = await new GithubPoller({ run: gh({ 'repos/acme/demo/pulls': () => notModified() }) }).poll('acme', 'demo',
      definition(['check_suite.completed']), { activity: { prHeads: { [String(own.number)]: { ...stale, left: true } }, etags: { pulls: 'W/"x"' } } });
    expect(suites.candidates).toEqual([]);
  });

  it('baselines a branch with no previous head instead of firing, and keeps heads that left the listing', async () => {
    const branches = fixture<Array<{ name: string; commit: { sha: string } }>>('branches');
    const [first, ...rest] = branches;
    const run = gh({ 'repos/acme/demo/branches': rest });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition(['push']), {
      activity: { branchHeads: { [first!.name]: first!.commit.sha } },
    });
    expect(result.candidates).toEqual([]);
    expect(result.activity?.branchHeads).toEqual(Object.fromEntries([...rest, first!].map((branch) => [branch.name, branch.commit.sha])));
  });
});
