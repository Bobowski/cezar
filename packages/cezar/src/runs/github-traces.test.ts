import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commentFingerprint, commentIdsIn, githubTracesOf, isOwnTrace, isPushCommand, mergeTraces, POSTED_BODIES_CAP, POSTED_COMMENTS_CAP, postingCommentBody, postingCommentTarget, pushedRefsIn, PUSHED_SHAS_CAP, settlePush, toolTraces } from './github-traces.ts';
import { RunStore } from './store.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('github traces (spec 2026-10-23-github-events §6)', () => {
  it('reads conversation and review comment ids out of URLs', () => {
    expect(commentIdsIn('https://github.com/a/b/pull/8#issuecomment-123\nhttps://github.com/a/b/pull/8#discussion_r456')).toEqual([123, 456]);
    expect(commentIdsIn('https://github.com/a/b/pull/8')).toEqual([]);
  });

  it('mines only commands that POST a comment, and spots a git push', () => {
    const output = 'https://github.com/a/b/pull/8#issuecomment-9';
    expect(toolTraces({ input: { command: 'gh pr comment 8 --body "done"' }, output, status: 'completed' })).toEqual({ pushed: false, comments: [9] });
    expect(toolTraces({ input: { command: 'gh api -X POST repos/a/b/pulls/8/comments -f body=x' }, output: '{"html_url":"https://github.com/a/b/pull/8#discussion_r11"}' }).comments).toEqual([11]);
    // Reading comments posts nothing: the URLs it prints are other people's.
    expect(toolTraces({ input: { command: 'gh api repos/a/b/issues/8/comments' }, output }).comments).toEqual([]);
    expect(toolTraces({ input: { command: 'gh pr view 8 --comments' }, output }).comments).toEqual([]);
    expect(toolTraces({ input: { command: 'git add -A && git commit -m x && git push' } }).pushed).toBe(true);
    expect(toolTraces({ input: { command: ['git', '-C', 'dir', 'push', 'origin', 'HEAD'] } }).pushed).toBe(true);
    expect(toolTraces({ input: { command: 'echo git-push-helper' } }).pushed).toBe(false);
    // A failed push left nothing behind.
    expect(toolTraces({ input: { command: 'git push' }, status: 'failed' }).pushed).toBe(false);
  });

  it('reads the body a comment-posting command is about to send, before it runs', async () => {
    const run = (command: string, cwd?: string) => postingCommentBody({ command }, cwd);
    expect(run('gh pr comment 8 --body "Fixed the \\"typo\\"." && git push')).toBe('Fixed the "typo".');
    expect(run("gh issue comment 3 -b 'single quoted'")).toBe('single quoted');
    expect(run('gh pr comment 8 --body=plain')).toBe('plain');
    expect(run("gh pr comment 8 --body \"$(cat <<'EOF'\nLine one.\n\nLine \"two\".\nEOF\n)\" && git push")).toBe('Line one.\n\nLine "two".');
    expect(run("gh pr comment 8 --body-file - <<'EOF'\nfrom stdin\nEOF")).toBe('from stdin');
    expect(run("gh api -X POST repos/a/b/issues/8/comments -f body='api body'")).toBe('api body');
    expect(run('gh api --method POST repos/a/b/pulls/8/comments --raw-field body="review note" -f path=x')).toBe('review note');
    const dir = await mkdtemp(join(tmpdir(), 'cezar-body-')); dirs.push(dir);
    await writeFile(join(dir, 'note.md'), 'from a file\n');
    expect(run('gh pr comment 8 -F note.md', dir)).toBe('from a file\n');
    expect(run('gh api -X POST repos/a/b/issues/8/comments -F body=@note.md', dir)).toBe('from a file\n');
    // Reading comments posts nothing.
    expect(run('gh api repos/a/b/issues/8/comments')).toBeUndefined();
    expect(run('gh pr view 8 --comments')).toBeUndefined();
    expect(run('git push')).toBeUndefined();
  });

  it('keeps the comment of a call that failed after posting it (gh comment && git push)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    const input = { command: 'gh pr comment 8 --body "Pushed the fix." && git push' };
    // Fingerprinted as the call STARTS, so a poll running meanwhile already knows it.
    store.notePostingComment(run.id, postingCommentBody(input)!);
    const failed = { input, status: 'failed', output: 'https://github.com/a/b/pull/8#issuecomment-9\nerror: failed to push some refs' };
    expect(toolTraces(failed)).toEqual({ pushed: false, comments: [9] });
    store.recordGithubTraces(run.id, { comments: toolTraces(failed).comments });
    const traces = store.githubTraces();
    expect(isOwnTrace({ event: 'pull_request.commented', comment: { id: 9, body: 'Pushed the fix.' } }, traces)).toBe(true);
    // Matched by body alone too: the id never printed (or the output was lost).
    expect(isOwnTrace({ event: 'pull_request.commented', comment: { id: 10, body: 'Pushed the fix.\r\n' } }, traces)).toBe(true);
  });

  it('reads what a push really pushed off its output', () => {
    const out = [
      'To github.com:acme/demo.git',
      '   1a2b3c4..5d6e7f8  main -> main',
      ' + 0a0b0c0...9f9e9d9 cez/abc -> cez/abc (forced update)',
      ' * [new branch]      cez/new -> cez/new',
      ' * [new tag]         v1 -> v1',
      ' ! [rejected]        other -> other (non-fast-forward)',
    ].join('\n');
    expect(pushedRefsIn(out)).toEqual({ refs: ['5d6e7f8', '9f9e9d9', 'cez/new'], upToDate: false });
    expect(pushedRefsIn('Everything up-to-date\n')).toEqual({ refs: [], upToDate: true });
    expect(pushedRefsIn('')).toEqual({ refs: [], upToDate: false });
  });

  it('settles a push: the shas it pushed, the start-time HEAD dropped when it was not one of them', async () => {
    const resolve = async (refs: readonly string[]) => refs.map((ref) => (ref === '5d6e7f8' ? sha(2) : sha(3)));
    const head = async () => sha(4);
    const committedThenPushed = { input: { command: 'git commit -am x && git push' }, status: 'completed', output: '   1a2b3c4..5d6e7f8  main -> main' };
    // HEAD at the call's start was the commit BEFORE `git commit`: not what was pushed.
    expect(await settlePush({ provisional: sha(1), item: committedThenPushed, resolve, head })).toEqual({ add: [sha(2)], drop: sha(1) });
    expect(await settlePush({ provisional: sha(2), item: committedThenPushed, resolve, head })).toEqual({ add: [sha(2)] });
    // A failed push, or one that pushed nothing, leaves no trace.
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, status: 'failed', output: 'error: failed to push some refs' }, resolve, head })).toEqual({ add: [], drop: sha(1) });
    // A push that worked inside a call that failed later (`git push && false`) still counts.
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, status: 'failed' }, resolve, head })).toEqual({ add: [sha(2)], drop: sha(1) });
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, output: 'Everything up-to-date' }, resolve, head })).toEqual({ add: [], drop: sha(1) });
    // An output that names nothing (a backend that drops stderr): HEAD as the call left it.
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, output: '' }, resolve, head })).toEqual({ add: [sha(4)], drop: sha(1) });
    expect(await settlePush({ item: { ...committedThenPushed, output: undefined }, resolve, head })).toEqual({ add: [sha(4)] });
  });

  it('drops a pushed sha from the record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.recordGithubTraces(run.id, { shas: [sha(1), sha(2)] });
    store.dropPushedSha(run.id, sha(1).toUpperCase());
    expect(store.getRun(run.id)?.pushedShas).toEqual([sha(2)]);
  });

  it('knows a push as it starts, and its own events by sha, id or the body being posted', () => {
    expect(isPushCommand({ command: 'git commit -am x && git push origin HEAD' })).toBe(true);
    expect(isPushCommand({ command: 'git status' })).toBe(false);
    expect(commentFingerprint('Done.\r\n\nSee  above ')).toBe(commentFingerprint('Done. See above'));
    // The poller keeps a body with these stripped; its fingerprint must still match the posted one.
    expect(commentFingerprint('Do​ne.‮ ﻿See')).toBe(commentFingerprint('Done. See'));
    const traces = { shas: new Set([sha(1)]), comments: new Set([5]), bodies: new Set([commentFingerprint('posting now')]) };
    expect(isOwnTrace({ event: 'push', headSha: sha(1).toUpperCase() }, traces)).toBe(true);
    expect(isOwnTrace({ event: 'check_suite.completed', headSha: sha(1) }, traces)).toBe(true);
    expect(isOwnTrace({ event: 'check_suite.completed', headSha: sha(1) }, traces, true)).toBe(false);
    expect(isOwnTrace({ event: 'pull_request.commented', headSha: sha(1), comment: { id: 6, body: 'a human' } }, traces)).toBe(false);
    expect(isOwnTrace({ event: 'pull_request.commented', comment: { id: 5 } }, traces)).toBe(true);
    expect(isOwnTrace({ event: 'issue.commented', comment: { id: 7, body: 'posting  now' } }, traces)).toBe(true);
  });

  it('deduplicates and caps, newest last', () => {
    const shas = Array.from({ length: PUSHED_SHAS_CAP + 5 }, (_, n) => sha(n + 1));
    const merged = mergeTraces({}, { shas: [...shas, shas[0]!], comments: [1, 1, 2] });
    expect(merged?.pushedShas).toHaveLength(PUSHED_SHAS_CAP);
    expect(merged?.pushedShas?.at(-1)).toBe(shas.at(-1));
    expect(merged?.postedComments).toEqual([1, 2]);
    expect(mergeTraces({ pushedShas: [sha(1)], postedComments: [1] }, { shas: [sha(1).toUpperCase()], comments: [1] })).toBeUndefined();
    expect(mergeTraces({}, { shas: ['not-a-sha'] })).toBeUndefined();
    const many = mergeTraces({}, { comments: Array.from({ length: POSTED_COMMENTS_CAP + 1 }, (_, n) => n + 1) });
    expect(many?.postedComments?.[0]).toBe(2);
  });

  it('collects every run of a project into one set', () => {
    const traces = githubTracesOf([{ pushedShas: [sha(1)] }, { postedComments: [5] }, {}]);
    expect([...traces.shas]).toEqual([sha(1)]);
    expect([...traces.comments]).toEqual([5]);
  });
});

describe('RunStore.recordGithubTraces', () => {
  it('persists the traces on the record, and a record without them still parses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    expect(store.getRun(run.id)?.pushedShas).toBeUndefined();
    store.recordGithubTraces(run.id, { shas: [sha(7)], comments: [42] });
    store.flush({ throwOnError: true });
    const reopened = RunStore.open(dir);
    expect(reopened.getRun(run.id)).toMatchObject({ pushedShas: [sha(7)], postedComments: [42] });
  });

  it('keeps the body of a comment being posted on the record for 24 hours, across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    store.notePostingComment(run.id, 'Fixed in the latest push.', undefined, now);
    store.flush({ throwOnError: true });
    const reopened = RunStore.open(dir);
    const own = { event: 'pull_request.commented', comment: { id: 9, body: 'Fixed in  the latest push.\r\n' } };
    expect(isOwnTrace(own, reopened.githubTraces(now + 60 * 60_000))).toBe(true);
    expect(isOwnTrace(own, reopened.githubTraces(now + 23 * 60 * 60_000))).toBe(true);
    // Past the day, the same words are a human's.
    expect(isOwnTrace(own, reopened.githubTraces(now + 25 * 60 * 60_000))).toBe(false);
  });

  it('bounds the kept bodies and drops expired ones when it adds', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    const old = { hash: 'a'.repeat(64), at: new Date(now - 25 * 60 * 60_000).toISOString() };
    const patch = mergeTraces({ postedCommentBodies: [old] }, { bodies: [{ hash: 'b'.repeat(64) }] }, now);
    expect(patch?.postedCommentBodies).toEqual([{ hash: 'b'.repeat(64), at: new Date(now).toISOString() }]);
    const many = mergeTraces({}, { bodies: Array.from({ length: POSTED_BODIES_CAP + 3 }, (_, n) => ({ hash: n.toString(16).padStart(64, '0') })) }, now);
    expect(many?.postedCommentBodies).toHaveLength(POSTED_BODIES_CAP);
  });

  it('scopes a body to the PR or issue it was posted on — project-wide only when that is unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    store.notePostingComment(run.id, 'Thanks, fixed.', 8, now);
    store.notePostingComment(run.id, 'Rebased.', undefined, now);
    store.flush({ throwOnError: true });
    const traces = RunStore.open(dir).githubTraces(now + 60_000);
    const said = (body: string, number?: number) => isOwnTrace({ event: 'pull_request.commented', ...(number === undefined ? {} : { number }), comment: { id: 1, body } }, traces);
    expect(said('Thanks, fixed.', 8)).toBe(true);
    // The same words from someone on another PR are theirs.
    expect(said('Thanks, fixed.', 9)).toBe(false);
    expect(said('Rebased.', 9)).toBe(true);
    // Re-noting the same body on the same item is no write; on another item it is.
    expect(mergeTraces(store.getRun(run.id)!, { bodies: [{ hash: commentFingerprint('Thanks, fixed.'), number: 8 }] }, now)).toBeUndefined();
    expect(mergeTraces(store.getRun(run.id)!, { bodies: [{ hash: commentFingerprint('Thanks, fixed.'), number: 9 }] }, now)?.postedCommentBodies).toHaveLength(3);
  });

  it('reads the PR or issue a comment-posting command targets', () => {
    expect(postingCommentTarget({ command: 'gh pr comment 12 --body "x"' })).toBe(12);
    expect(postingCommentTarget({ command: 'gh issue comment https://github.com/acme/demo/issues/7 -b x' })).toBe(7);
    expect(postingCommentTarget({ command: 'gh api repos/acme/demo/issues/31/comments -f body=x' })).toBe(31);
    expect(postingCommentTarget({ command: 'gh api -X POST repos/acme/demo/pulls/5/comments -f body=x' })).toBe(5);
    expect(postingCommentTarget({ command: 'gh pr comment --body "x"' })).toBeUndefined();
    expect(postingCommentTarget({ command: 'gh pr view 12' })).toBeUndefined();
  });
});

describe('comments posted by other means than `gh … comment`', () => {
  it('traces a GitHub MCP tool call with a body: its body, its item and the id it printed', () => {
    const name = 'mcp__github__add_issue_comment';
    const input = { owner: 'acme', repo: 'demo', issue_number: 8, body: 'Fixed in the latest push.' };
    expect(postingCommentBody(input, undefined, name)).toBe('Fixed in the latest push.');
    expect(postingCommentTarget(input, name)).toBe(8);
    expect(toolTraces({ name, input, output: '{"html_url":"https://github.com/acme/demo/pull/8#issuecomment-991"}', status: 'failed' }).comments).toEqual([991]);
    expect(postingCommentBody({ pull_number: 8, body: 'nit' }, undefined, 'github.create_pull_request_review')).toBe('nit');
    // Not a GitHub tool, or no body: nothing.
    expect(postingCommentBody(input, undefined, 'mcp__slack__post_message')).toBeUndefined();
    expect(postingCommentBody({ issue_number: 8 }, undefined, name)).toBeUndefined();
    expect(toolTraces({ name: 'mcp__github__get_issue', input: { issue_number: 8 }, output: '#issuecomment-5' }).comments).toEqual([]);
  });

  it('an MCP-posted comment is then cezar’s own, on that PR', () => {
    const name = 'mcp__github__add_issue_comment';
    const input = { owner: 'acme', repo: 'demo', issue_number: 8, body: 'On it.' };
    const record = mergeTraces({}, { bodies: [{ hash: commentFingerprint(postingCommentBody(input, undefined, name)!), number: postingCommentTarget(input, name)! }] })!;
    const traces = githubTracesOf([record]);
    expect(isOwnTrace({ event: 'pull_request.commented', number: 8, comment: { id: 1, body: 'On it.' } }, traces)).toBe(true);
  });

  it('traces a GraphQL comment mutation, inline body or a body variable', () => {
    const inline = `gh api graphql -f query='mutation { addComment(input: {subjectId: "PR_1", body: "Done \\"now\\"\\nthanks"}) { commentEdge { node { url } } } }'`;
    expect(postingCommentBody({ command: inline })).toBe('Done "now"\nthanks');
    expect(toolTraces({ input: { command: inline }, output: '{"url":"https://github.com/acme/demo/pull/8#issuecomment-77"}' }).comments).toEqual([77]);
    expect(postingCommentBody({ command: `gh api graphql -f body='hi there' -f query='mutation($body: String!) { addPullRequestReviewThreadReply(input: {body: $body}) { comment { url } } }'` })).toBe('hi there');
    // A query that only reads posts nothing.
    expect(postingCommentBody({ command: `gh api graphql -f query='{ repository(owner: "a", name: "b") { pullRequest(number: 1) { body } } }'` })).toBeUndefined();
  });

  it('traces a review body: gh pr review and a POST to /reviews', () => {
    expect(postingCommentBody({ command: 'gh pr review 8 --comment -b "nit: rename"' })).toBe('nit: rename');
    expect(postingCommentTarget({ command: 'gh pr review 8 --comment -b "nit: rename"' })).toBe(8);
    const api = 'gh api repos/acme/demo/pulls/8/reviews -f event=COMMENT -f body="Looks good"';
    expect(postingCommentBody({ command: api })).toBe('Looks good');
    expect(postingCommentTarget({ command: api })).toBe(8);
    expect(postingCommentBody({ command: 'gh api repos/acme/demo/pulls/8/reviews' })).toBeUndefined();
  });
});
