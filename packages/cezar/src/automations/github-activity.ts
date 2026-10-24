import { z } from 'zod';
import type { GithubActivityState, GithubCandidate } from './github-poller.ts';
import type { AutomationEvent, GithubAutomationDefinition } from './types.ts';
import { INVISIBLE_RE, isOwnCommentBody, type GithubTraces } from '../runs/github-traces.ts';

/**
 * The seven activity sources of spec 2026-10-23-github-events §3 — what happens INSIDE an issue or
 * PR rather than its lifecycle. Every source is one bounded REST read (plus bounded per-item
 * reads), never a search: comments since the cursor, check suites of the newest open PR heads,
 * releases, and two diffs against stored state (open PR heads for `synchronize`, branch heads for
 * `push`). A diff-found candidate is `cursorless`: the stored heads, not a timestamp, say it is new.
 */
export const ACTIVITY_EVENTS: ReadonlySet<AutomationEvent> = new Set<AutomationEvent>([
  'pull_request.synchronize', 'pull_request.commented', 'pull_request.review_commented',
  'issue.commented', 'check_suite.completed', 'push', 'release.published',
]);

/** The events whose sources keep heads: open PR heads (`synchronize`, check suites) and branch
 *  heads (`push`). */
const HEAD_EVENTS = new Set(['push', 'pull_request.synchronize', 'check_suite.completed']);

/**
 * Whether an edit changes WHICH heads the diff sources track: adding or removing a head-keeping
 * event (a source that stopped running left its heads to go stale) or the branch patterns (a
 * widened pattern would see every existing branch it now matches as a push). Such an edit
 * re-baselines the heads, as enabling does; any other edit of the events keeps them.
 */
export function activityHeadsChanged(
  before: { events?: readonly string[]; filters?: { branches?: readonly string[] } },
  after: { events?: readonly string[]; filters?: { branches?: readonly string[] } },
): boolean {
  const events = (definition: typeof before) => JSON.stringify([...new Set(definition.events ?? [])].filter((event) => HEAD_EVENTS.has(event)).sort());
  const branches = (definition: typeof before) => JSON.stringify(definition.filters?.branches ?? []);
  return events(before) !== events(after) || branches(before) !== branches(after);
}

const PAGE = 100;
const RELEASE_PAGE = 30;
const BRANCH_PAGES = 3;
const MAX_FAILING_JOBS = 20;
const MAX_SUBJECTS = 20;
const MAX_BODY = 4_000;
/** Heads kept for PRs and branches that slid out of the capped lists, so one sliding back in is
 *  diffed against what was last seen instead of being new. Newest first, then dropped. */
export const HEADS_CAP = 1_000;
const FAILING = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
/** Who may speak into an existing run by default (`deliver: 'owning-run'`), as GitHub's
 *  `author_association` names them: the owner outright. `MEMBER` is only ORG membership and
 *  `COLLABORATOR` includes read and triage access, so both are admitted only when the repo's own
 *  permission lookup says write, maintain or admin (`WritePermissions`). */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER']);
const ASKED_ASSOCIATIONS = new Set(['MEMBER', 'COLLABORATOR']);
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

/** `/collaborators/:login/permission` answers per repo and login, kept ten minutes, bounded. A
 *  failed lookup is never kept: the next poll asks again. */
export class WritePermissions {
  private readonly entries = new Map<string, { write: boolean; at: number }>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly now = () => Date.now()) {}

  get(key: string): boolean | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at < this.ttlMs) return entry.write;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, write: boolean): void {
    this.entries.delete(key);
    this.entries.set(key, { write, at: this.now() });
    if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!);
  }
}

export type GhRun = (args: readonly string[]) => Promise<string>;

/** One observation; `etagKey` names the conditional read it came from, so a poll that does not
 *  evaluate it can drop that ETag and read the page again next time. */
export interface ActivityObservation {
  timestamp: string;
  tieBreaker: string;
  candidate?: GithubCandidate;
  etagKey?: string;
}

export interface ActivityResult {
  /** One group per source, each in the shape `poll()` slices to `maxRecords`. */
  groups: ActivityObservation[][];
  cursorless: GithubCandidate[];
  state: GithubActivityState;
  truncated: boolean;
}

const login = z.object({ login: z.string() }).nullable().optional();
const labelsSchema = z.array(z.object({ name: z.string() })).nullable().optional();
const pullSchema = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  state: z.string().optional(),
  title: z.string(),
  html_url: z.string(),
  updated_at: z.string(),
  user: login,
  labels: labelsSchema,
  assignees: z.array(z.object({ login: z.string() })).nullable().optional(),
  head: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable().optional() }),
});
const issueSchema = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  title: z.string(),
  html_url: z.string(),
  user: login,
  labels: labelsSchema,
  assignees: z.array(z.object({ login: z.string() })).nullable().optional(),
});
const commentSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  user: login,
  author_association: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  issue_url: z.string().optional(),
  pull_request_url: z.string().optional(),
});
const suiteSchema = z.object({
  id: z.number().int().positive(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  updated_at: z.string().nullable(),
  app: z.object({ name: z.string() }).nullable().optional(),
  latest_check_runs_count: z.number().optional(),
});
const checkRunSchema = z.object({ name: z.string(), conclusion: z.string().nullable(), html_url: z.string().nullable().optional() });
const branchSchema = z.object({ name: z.string(), commit: z.object({ sha: z.string() }) });
const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string().optional(),
  author: login,
  commit: z.object({ message: z.string(), author: z.object({ name: z.string() }).nullable().optional() }),
});
const releaseSchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string(),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  html_url: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  author: login,
});

interface Item {
  number: number;
  nodeId: string;
  title: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
  fork?: boolean;
  headSha?: string;
  headRef?: string;
  /** Pull requests read one by one (`/pulls/:n`): their state and last update. */
  open?: boolean;
  updatedAt?: string;
}

type PrHeads = NonNullable<GithubActivityState['prHeads']>;

/** `fresh` (the window this poll read) over `previous`, whose other entries are kept as `left`;
 *  newest `updatedAt` first, capped at `HEADS_CAP`. */
function retainPrHeads(previous: PrHeads | undefined, fresh: PrHeads): PrHeads {
  const merged: PrHeads = { ...fresh };
  for (const [number, head] of Object.entries(previous ?? {})) {
    if (!(number in fresh)) merged[number] = { sha: head.sha, ref: head.ref, updatedAt: head.updatedAt, left: true };
  }
  const entries = Object.entries(merged);
  if (entries.length <= HEADS_CAP) return merged;
  return Object.fromEntries(entries.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, HEADS_CAP));
}

/** Elements that do not fit are dropped, never the page — the `/timeline` lesson (#914). */
function parseEach<T extends z.ZodTypeAny>(raw: unknown, schema: T): z.infer<T>[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data as z.infer<T>] : [];
  });
}

/** The status code of a `gh api --include` response; 0 when there is no status line. */
export function httpStatusOf(raw: string): number {
  const match = /^HTTP\/[\d.]+\s+(\d{3})/.exec(raw.trimStart());
  return match ? Number(match[1]) : 0;
}

function splitHttp(raw: string): { headers: string; body: string } {
  const text = raw.trimStart();
  const at = text.search(/\r?\n\r?\n/);
  if (at < 0) return { headers: text, body: '' };
  const gap = /\r?\n\r?\n/.exec(text.slice(at))![0].length;
  return { headers: text.slice(0, at), body: text.slice(at + gap) };
}

function headerOf(headers: string, name: string): string | undefined {
  const line = headers.split(/\r?\n/).find((row) => row.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(line.indexOf(':') + 1).trim() || undefined;
}

function isNotFound(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : String(error)} ${String((error as { stderr?: unknown })?.stderr ?? '')} ${String((error as { stdout?: unknown })?.stdout ?? '')}`;
  return /\b404\b|Not Found/.test(text);
}

/**
 * A GET that sends the stored ETag. `gh` exits non-zero on a `304` (its status is above 299), so
 * the `304` is read off the failed call's stdout as well as off a successful one.
 */
async function getConditional(run: GhRun, path: string, params: string[], etag: string | undefined):
Promise<{ notModified: true } | { notModified: false; body: unknown; etag?: string }> {
  const args = [
    'api', '--include', '--method', 'GET', path, '-H', 'Accept: application/vnd.github+json',
    ...(etag ? ['-H', `If-None-Match: ${etag}`] : []),
    ...params.flatMap((param) => ['-f', param]),
  ];
  let raw: string;
  try {
    raw = await run(args);
  } catch (error) {
    const stdout = (error as { stdout?: unknown })?.stdout;
    if (typeof stdout === 'string' && httpStatusOf(stdout) === 304) return { notModified: true };
    throw error;
  }
  if (httpStatusOf(raw) === 304) return { notModified: true };
  const { headers, body } = splitHttp(raw);
  return { notModified: false, body: body.trim() ? JSON.parse(body) : null, etag: headerOf(headers, 'etag') };
}

async function getJson(run: GhRun, path: string, params: string[] = []): Promise<unknown> {
  return JSON.parse(await run(['api', '--method', 'GET', path, ...params.flatMap((param) => ['-f', param])]));
}

/** `*` matches any run of characters; everything else is literal, case-sensitive like git refs. */
export function globMatches(pattern: string, value: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`).test(value);
}

/** `@login` as a whole mention: not part of an e-mail address or a longer login. */
export function mentions(body: string, who: string): boolean {
  const name = who.replace(/^@/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@.-])@${name}(?![\\w-])`, 'i').test(body);
}

function conclusionMatches(conclusion: string, wanted: 'success' | 'failure' | 'any' | undefined): boolean {
  if (!wanted || wanted === 'any') return true;
  return wanted === 'success' ? conclusion === 'success' : FAILING.has(conclusion);
}

/** Whether only a trusted author's comment may pass: the owning-run default, with no `authors`
 *  list and no `allowAnyAuthor` (spec 2026-10-23-github-events §7). */
function needsTrustedAuthor(candidate: GithubCandidate, definition: GithubAutomationDefinition): boolean {
  return !!candidate.comment && definition.deliver === 'owning-run' && !definition.filters.authors?.length
    && definition.filters.allowAnyAuthor !== true;
}

/** The filters only an activity event carries; `matchesFilters` checks the shared ones. */
export function matchesActivityFilters(candidate: GithubCandidate, definition: GithubAutomationDefinition): boolean {
  const filters = definition.filters;
  if (candidate.branch && filters.branches?.length
    && (candidate.event === 'pull_request.synchronize' || candidate.event === 'push')
    && !filters.branches.some((pattern) => globMatches(pattern, candidate.branch!))) return false;
  if (candidate.comment && filters.mentions?.length
    && !filters.mentions.some((who) => mentions(candidate.comment!.body ?? '', who))) return false;
  // A comment delivered INTO a running task is a message to an agent holding a worktree and the
  // user's credentials: by default only the owner and writers may send one (spec 2026-10-23-github-events §7).
  if (needsTrustedAuthor(candidate, definition) && !TRUSTED_ASSOCIATIONS.has(candidate.comment!.association ?? '')
    && !(ASKED_ASSOCIATIONS.has(candidate.comment!.association ?? '') && candidate.comment!.writeAccess === true)) return false;
  if (candidate.check && !conclusionMatches(candidate.check.conclusion, filters.conclusion)) return false;
  if (candidate.release) {
    if (filters.prerelease !== undefined && candidate.release.prerelease !== filters.prerelease) return false;
    if (filters.tags?.length && !filters.tags.some((pattern) => globMatches(pattern, candidate.release!.tag))) return false;
  }
  return true;
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

/** Every line terminator a renderer might honour, so a line-by-line quote can never miss one. */
const LINE_BREAK_RE = /\r\n|[\r\u000b\u000c\u0085\u2028\u2029]/g;

/** A body as plain LF-separated lines: every terminator becomes LF, every other C0/C1 control
 *  a space, and bidi/zero-width characters go, so what is quoted reads as what it says (spec
 *  2026-10-23-github-events §7). */
export function normalizeCommentBody(value: string): string {
  return value.replace(LINE_BREAK_RE, '\n').replace(INVISIBLE_RE, '').replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, ' ');
}

function cleanBody(value: string | null | undefined): string {
  return normalizeCommentBody(value ?? '').slice(0, MAX_BODY);
}

function atOrAfter(timestamp: string, since: string): boolean {
  return timestamp >= since;
}

export async function pollActivity(input: {
  owner: string;
  repo: string;
  definition: GithubAutomationDefinition;
  since?: string;
  maxRecords: number;
  state: GithubActivityState;
  traces?: GithubTraces;
  run: GhRun;
  /** The shared filters (`matchesFilters`), passed in so nothing is imported back from the poller. */
  matches: (candidate: GithubCandidate) => boolean;
  /** `https://github.com`, or the Enterprise host's web origin. */
  htmlBase: string;
  /** Kept across polls by the poller, so a member is looked up once per ten minutes. */
  permissions?: WritePermissions;
}): Promise<ActivityResult> {
  const { owner, repo, definition, maxRecords, run } = input;
  const full = `${owner}/${repo}`;
  // Heads recorded for another repository (the origin changed) are no diff base: re-baseline,
  // ETags included. State from before `headsRepo` existed is taken as this repository's.
  const headsRepo = full.toLowerCase();
  const state: GithubActivityState = !input.state.headsRepo || input.state.headsRepo.toLowerCase() === headsRepo ? input.state : {};
  const api = `repos/${owner}/${repo}`;
  const events = new Set(definition.events);
  const filters = definition.filters;
  const since = input.since ?? new Date(Date.now() - filters.lookbackDays * 86_400_000).toISOString();
  const ownSha = (sha: string) => input.traces?.shas.has(sha.toLowerCase()) ?? false;
  const ownComment = (id: number, body: string | null | undefined, number: number) => !!input.traces
    && (input.traces.comments.has(id) || (!!body && isOwnCommentBody(input.traces, body, number)));
  const allowForks = definition.task.allowForkHeads === true;
  const etagsIn = state.etags ?? {};
  // Keys this module owns are rebuilt every poll, so a sha that left the open-PR set takes its
  // ETag with it; any other key passes through untouched.
  const managed = (key: string) => key === 'pulls' || key === 'releases' || key.startsWith('suites:');
  const etags: Record<string, string> = Object.fromEntries(Object.entries(etagsIn).filter(([key]) => !managed(key)));
  const groups: ActivityObservation[][] = [];
  const cursorless: GithubCandidate[] = [];
  const next: GithubActivityState = {};
  let truncated = false;

  const items = new Map<number, Item | null>();
  const fromPull = (pull: z.infer<typeof pullSchema>): Item => ({
    number: pull.number,
    nodeId: pull.node_id,
    title: pull.title,
    url: pull.html_url,
    author: pull.user?.login ?? 'ghost',
    assignees: (pull.assignees ?? []).map((who) => who.login),
    labels: (pull.labels ?? []).map((label) => label.name),
    fork: pull.head.repo?.full_name.toLowerCase() !== full.toLowerCase(),
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    open: pull.state === undefined || pull.state === 'open',
    updatedAt: pull.updated_at,
  });
  /** PRs read one by one this poll — outside the open-PR window, when its own read missed them. */
  const readAlone = new Set<number>();
  /** One read per distinct item per poll; a deleted item (404) is `null`, anything else throws. */
  const itemOf = async (number: number, pull: boolean): Promise<Item | null> => {
    if (items.has(number)) return items.get(number)!;
    let item: Item | null = null;
    try {
      if (pull) {
        const parsed = pullSchema.safeParse(await getJson(run, `${api}/pulls/${number}`));
        item = parsed.success ? fromPull(parsed.data) : null;
        if (item) readAlone.add(number);
      } else {
        const parsed = issueSchema.safeParse(await getJson(run, `${api}/issues/${number}`));
        item = parsed.success ? {
          number, nodeId: parsed.data.node_id, title: parsed.data.title, url: parsed.data.html_url,
          author: parsed.data.user?.login ?? 'ghost',
          assignees: (parsed.data.assignees ?? []).map((who) => who.login),
          labels: (parsed.data.labels ?? []).map((label) => label.name),
        } : null;
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    items.set(number, item);
    return item;
  };
  const base = (item: Item, event: AutomationEvent, eventId: string, timestamp: string, tieBreaker: string): GithubCandidate => ({
    eventId, event, timestamp, tieBreaker, repo: full, nodeId: item.nodeId, number: item.number,
    title: clean(item.title, 500), url: item.url, author: clean(item.author, 200), assignees: item.assignees, labels: item.labels,
    ...(item.headSha ? { headSha: item.headSha } : {}),
    ...(item.headRef ? { branch: item.headRef } : {}),
  });
  const admit = (candidate: GithubCandidate) => input.matches(candidate) && matchesActivityFilters(candidate, definition);
  const permissions = input.permissions ?? new WritePermissions();
  /** Whether `login` may push to this repo; a lookup that fails is a no, and is asked again. */
  const canWrite = async (login: string): Promise<boolean> => {
    const key = `${full.toLowerCase()}:${login.toLowerCase()}`;
    const cached = permissions.get(key);
    if (cached !== undefined) return cached;
    let write = false;
    try {
      const raw = await getJson(run, `${api}/collaborators/${encodeURIComponent(login)}/permission`) as { permission?: unknown; role_name?: unknown } | null;
      write = WRITE_PERMISSIONS.has(String(raw?.permission)) || WRITE_PERMISSIONS.has(String(raw?.role_name));
    } catch (error) {
      if (!isNotFound(error)) return false;
    }
    permissions.set(key, write);
    return write;
  };
  /** `admit` for a comment, asking the repo about a member or collaborator only when it decides. */
  const admitComment = async (candidate: GithubCandidate): Promise<boolean> => {
    if (!input.matches(candidate)) return false;
    const comment = candidate.comment!;
    if (ASKED_ASSOCIATIONS.has(comment.association ?? '') && needsTrustedAuthor(candidate, definition)) comment.writeAccess = await canWrite(comment.author);
    return matchesActivityFilters(candidate, definition);
  };

  // ---- open PR heads: `synchronize` and the heads `check_suite.completed` reads -------------
  const tracksPrHeads = events.has('pull_request.synchronize') || events.has('check_suite.completed');
  /** The PRs the open-PR list itself returned this poll; every other stored head is `left`. */
  let windowed = new Set<string>();
  const synchronizeOf = (item: Item, sha: string, updatedAt: string): GithubCandidate => ({
    ...base(item, 'pull_request.synchronize', `${full}:${item.nodeId}:pull_request.synchronize:${sha}`,
      updatedAt, `${item.nodeId}:synchronize:${sha}`),
    cursorless: true,
  });
  /** At most `maxRecords` `synchronize` launches per poll, like `push`: false = over budget, and
   *  the caller keeps the old head so the next poll still sees the move. */
  let synchronized = 0;
  const takeSynchronize = (candidate: GithubCandidate): boolean => {
    if (!admit(candidate)) return true;
    if (synchronized >= maxRecords) {
      truncated = true;
      return false;
    }
    synchronized += 1;
    cursorless.push(candidate);
    return true;
  };
  if (tracksPrHeads) {
    // Without stored heads a 304 would leave nothing to diff against, so no ETag is sent then.
    const read = await getConditional(run, `${api}/pulls`, ['state=open', 'sort=updated', 'direction=desc', `per_page=${PAGE}`],
      state.prHeads ? etagsIn.pulls : undefined);
    let heads: PrHeads;
    /** What check suites are read for: the heads the list really has now. */
    let suiteHeads: PrHeads;
    if (read.notModified) {
      heads = { ...(state.prHeads ?? {}) };
      windowed = new Set(Object.entries(heads).filter(([, head]) => !head.left).map(([number]) => number));
      suiteHeads = heads;
      if (etagsIn.pulls) etags.pulls = etagsIn.pulls;
    } else {
      const pulls = parseEach(read.body, pullSchema);
      truncated ||= pulls.length >= PAGE;
      if (read.etag) etags.pulls = read.etag;
      const fresh: PrHeads = Object.fromEntries(pulls.map((pull) => [String(pull.number), { sha: pull.head.sha, ref: pull.head.ref, updatedAt: pull.updated_at }]));
      windowed = new Set(Object.keys(fresh));
      suiteHeads = fresh;
      heads = retainPrHeads(state.prHeads, fresh);
      for (const pull of pulls) items.set(pull.number, fromPull(pull));
      // First sight records the heads and fires nothing: a head is "changed" only against one seen
      // — including one kept from before the PR slid out of this capped list.
      if (events.has('pull_request.synchronize') && state.prHeads) {
        for (const pull of pulls) {
          const previous = state.prHeads[String(pull.number)];
          if (!previous || previous.sha === pull.head.sha || ownSha(pull.head.sha)) continue;
          const candidate = synchronizeOf(fromPull(pull), pull.head.sha, pull.updated_at);
          if (takeSynchronize(candidate)) continue;
          heads[String(pull.number)] = { sha: previous.sha, ref: pull.head.ref, updatedAt: pull.updated_at };
          // A 304 next time would hand back these held heads with nothing left to diff.
          delete etags.pulls;
        }
      }
    }
    next.prHeads = heads;

    if (events.has('check_suite.completed')) {
      const group: ActivityObservation[] = [];
      const newest = Object.entries(suiteHeads)
        .filter(([number]) => windowed.has(number))
        .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
        .slice(0, maxRecords);
      for (const [number, head] of newest) {
        const key = `suites:${head.sha}`;
        const suites = await getConditional(run, `${api}/commits/${head.sha}/check-suites`, [`per_page=${PAGE}`], etagsIn[key]);
        if (suites.notModified) {
          if (etagsIn[key]) etags[key] = etagsIn[key];
          continue;
        }
        if (suites.etag) etags[key] = suites.etag;
        const body = suites.body as { check_suites?: unknown } | null;
        for (const suite of parseEach(body?.check_suites, suiteSchema)) {
          // A suite with no runs is an app that installed itself and checks nothing.
          if (suite.status !== 'completed' || !suite.conclusion || !suite.updated_at || suite.latest_check_runs_count === 0) continue;
          if (!atOrAfter(suite.updated_at, since)) continue;
          const observation: ActivityObservation = { timestamp: suite.updated_at, tieBreaker: `suite:${suite.id}`, etagKey: key };
          group.push(observation);
          if (ownSha(head.sha) && !filters.includeOwnPushes) continue;
          if (!conclusionMatches(suite.conclusion, filters.conclusion)) continue;
          const item = await itemOf(Number(number), true);
          if (!item) continue;
          const candidate: GithubCandidate = {
            ...base(item, 'check_suite.completed', `${full}:check_suite:${suite.id}:${suite.updated_at}`, suite.updated_at, observation.tieBreaker),
            headSha: head.sha,
            check: { id: suite.id, name: clean(suite.app?.name ?? 'checks', 200), conclusion: suite.conclusion, url: `${item.url}/checks`, failingJobs: [] },
          };
          if (!admit(candidate)) continue;
          if (FAILING.has(suite.conclusion)) {
            const runs = await getJson(run, `${api}/check-suites/${suite.id}/check-runs`, ['filter=latest', `per_page=${PAGE}`]);
            const failing = parseEach((runs as { check_runs?: unknown } | null)?.check_runs, checkRunSchema)
              .filter((row) => row.conclusion !== null && FAILING.has(row.conclusion));
            candidate.check!.failingJobs = failing.slice(0, MAX_FAILING_JOBS).map((row) => clean(row.name, 200));
            const firstUrl = failing.find((row) => row.html_url)?.html_url;
            if (firstUrl) candidate.check!.url = firstUrl;
          }
          observation.candidate = candidate;
        }
      }
      groups.push(group);
    }
  }

  // ---- conversation comments: one repo-wide read covers PRs and issues ---------------------
  if (events.has('pull_request.commented') || events.has('issue.commented')) {
    const rows = parseEach(await getJson(run, `${api}/issues/comments`, ['sort=updated', 'direction=asc', `since=${since}`, `per_page=${PAGE}`]), commentSchema);
    // The record budget bounds the per-item reads too: rows past it wait for the next poll.
    truncated ||= rows.length >= PAGE || rows.length > maxRecords;
    const group: ActivityObservation[] = [];
    for (const row of rows.slice(0, maxRecords)) {
      // Observed at `updated_at` so an edit-only page still moves the cursor; launched only as
      // the comment it was when it was CREATED after the cursor.
      const observation: ActivityObservation = { timestamp: row.updated_at, tieBreaker: `comment:${row.id}` };
      group.push(observation);
      const pull = /\/pull\/\d+/.test(row.html_url);
      const event: AutomationEvent = pull ? 'pull_request.commented' : 'issue.commented';
      const number = Number(row.issue_url?.match(/\/issues\/(\d+)$/)?.[1]);
      if (!events.has(event) || !Number.isInteger(number) || number <= 0) continue;
      if (!atOrAfter(row.created_at, since) || ownComment(row.id, row.body, number)) continue;
      const item = await itemOf(number, pull);
      if (!item || (item.fork && !allowForks)) continue;
      const candidate: GithubCandidate = {
        ...base(item, event, `${full}:comment:${row.id}`, row.created_at, observation.tieBreaker),
        comment: {
          id: row.id, kind: 'issue', author: row.user?.login ?? 'ghost', url: row.html_url, body: cleanBody(row.body),
          ...(row.author_association ? { association: clean(row.author_association, 50) } : {}),
        },
      };
      if (await admitComment(candidate)) observation.candidate = candidate;
    }
    groups.push(group);
  }

  // ---- review (diff) comments ---------------------------------------------------------------
  if (events.has('pull_request.review_commented')) {
    const rows = parseEach(await getJson(run, `${api}/pulls/comments`, ['sort=updated', 'direction=asc', `since=${since}`, `per_page=${PAGE}`]), commentSchema);
    // The record budget bounds the per-item reads too: rows past it wait for the next poll.
    truncated ||= rows.length >= PAGE || rows.length > maxRecords;
    const group: ActivityObservation[] = [];
    for (const row of rows.slice(0, maxRecords)) {
      const observation: ActivityObservation = { timestamp: row.updated_at, tieBreaker: `review-comment:${row.id}` };
      group.push(observation);
      const number = Number(row.pull_request_url?.match(/\/pulls\/(\d+)$/)?.[1]);
      if (!Number.isInteger(number) || number <= 0) continue;
      if (!atOrAfter(row.created_at, since) || ownComment(row.id, row.body, number)) continue;
      const item = await itemOf(number, true);
      if (!item || (item.fork && !allowForks)) continue;
      const candidate: GithubCandidate = {
        ...base(item, 'pull_request.review_commented', `${full}:review-comment:${row.id}`, row.created_at, observation.tieBreaker),
        comment: {
          id: row.id, kind: 'review', author: row.user?.login ?? 'ghost', url: row.html_url, body: cleanBody(row.body),
          ...(row.author_association ? { association: clean(row.author_association, 50) } : {}),
        },
      };
      if (await admitComment(candidate)) observation.candidate = candidate;
    }
    // A submitted review is N comments at once: one launch per PR per poll, carrying them all.
    const byPull = new Map<number, ActivityObservation[]>();
    for (const observation of group) {
      const number = observation.candidate?.number;
      if (number !== undefined) byPull.set(number, [...(byPull.get(number) ?? []), observation]);
    }
    for (const batch of byPull.values()) {
      if (batch.length < 2) continue;
      const last = batch.at(-1)!;
      last.candidate!.comment!.body = cleanBody(batch.map((observation) => observation.candidate!.comment!.body ?? '').join('\n\n---\n\n'));
      for (const observation of batch.slice(0, -1)) observation.candidate = undefined;
    }
    groups.push(group);
  }

  // ---- PRs outside the open-PR window that a comment named: their head as `/pulls/:n` read it --
  if (tracksPrHeads && next.prHeads) {
    for (const number of readAlone) {
      const key = String(number);
      const item = items.get(number);
      if (windowed.has(key) || !item?.headSha || !item.headRef || !item.updatedAt) continue;
      const previous = state.prHeads?.[key];
      if (events.has('pull_request.synchronize') && previous && previous.sha !== item.headSha && item.open && !ownSha(item.headSha)
        && !takeSynchronize(synchronizeOf(item, item.headSha, item.updatedAt))) {
        next.prHeads[key] = { ...previous, left: true };
        continue;
      }
      next.prHeads[key] = { sha: item.headSha, ref: item.headRef, updatedAt: item.updatedAt, left: true };
    }
    next.prHeads = retainPrHeads(undefined, next.prHeads);
  }

  // ---- releases ------------------------------------------------------------------------------
  if (events.has('release.published')) {
    const read = await getConditional(run, `${api}/releases`, [`per_page=${RELEASE_PAGE}`], etagsIn.releases);
    const group: ActivityObservation[] = [];
    if (read.notModified) {
      if (etagsIn.releases) etags.releases = etagsIn.releases;
    } else {
      if (read.etag) etags.releases = read.etag;
      const releases = parseEach(read.body, releaseSchema);
      truncated ||= releases.length >= RELEASE_PAGE && releases.every((row) => !row.published_at || atOrAfter(row.published_at, since));
      for (const row of releases) {
        if (row.draft || !row.published_at || !atOrAfter(row.published_at, since)) continue;
        const observation: ActivityObservation = { timestamp: row.published_at, tieBreaker: `release:${row.id}`, etagKey: 'releases' };
        group.push(observation);
        const candidate: GithubCandidate = {
          eventId: `${full}:release:${row.id}`, event: 'release.published', timestamp: row.published_at,
          tieBreaker: observation.tieBreaker, repo: full, nodeId: row.node_id,
          title: clean(row.name || row.tag_name, 500), url: row.html_url, author: row.author?.login ?? 'ghost',
          assignees: [], labels: [],
          release: { tag: clean(row.tag_name, 200), name: clean(row.name ?? '', 500), prerelease: row.prerelease },
        };
        if (admit(candidate)) observation.candidate = candidate;
      }
    }
    groups.push(group);
  }

  // ---- pushes: branch heads diffed against the stored ones -----------------------------------
  if (events.has('push')) {
    const patterns = filters.branches ?? [];
    const heads: Record<string, string> = {};
    for (const name of patterns.filter((pattern) => !pattern.includes('*'))) {
      try {
        const parsed = branchSchema.safeParse(await getJson(run, `${api}/branches/${encodeURIComponent(name)}`));
        if (parsed.success) heads[parsed.data.name] = parsed.data.commit.sha;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    if (!patterns.length || patterns.some((pattern) => pattern.includes('*'))) {
      for (let page = 1; page <= BRANCH_PAGES; page += 1) {
        const rows = parseEach(await getJson(run, `${api}/branches`, [`per_page=${PAGE}`, `page=${page}`]), branchSchema);
        for (const row of rows) {
          if (!patterns.length || patterns.some((pattern) => globMatches(pattern, row.name))) heads[row.name] = row.commit.sha;
        }
        if (rows.length < PAGE) break;
        if (page === BRANCH_PAGES) truncated = true;
      }
    }
    if (state.branchHeads) {
      let compared = 0;
      for (const [name, sha] of Object.entries(heads)) {
        const previous = state.branchHeads[name];
        // No previous head is a baseline, never a push: a branch sliding into the capped listing
        // looks exactly like a new one. Its first move after that fires.
        if (previous === undefined || previous === sha) continue;
        if (ownSha(sha)) continue;
        if (compared >= maxRecords) {
          // Over budget: keep the old head so the next poll still sees this push.
          truncated = true;
          heads[name] = previous;
          continue;
        }
        compared += 1;
        let commits: z.infer<typeof commitSchema>[] = [];
        let url = `${input.htmlBase}/${full}/commit/${sha}`;
        try {
          const compare = await getJson(run, `${api}/compare/${previous}...${sha}`) as { html_url?: unknown; commits?: unknown } | null;
          commits = parseEach(compare?.commits, commitSchema);
          if (typeof compare?.html_url === 'string') url = compare.html_url;
        } catch (error) {
          // A force-push can leave the old head unreachable; the push still happened.
          if (!isNotFound(error)) throw error;
        }
        const last = commits.at(-1);
        const candidate: GithubCandidate = {
          eventId: `${full}:push:${name}:${sha}`, event: 'push', timestamp: new Date().toISOString(),
          tieBreaker: `push:${name}:${sha}`, repo: full, nodeId: `refs/heads/${name}`,
          title: clean(`push to ${name}`, 500), url,
          author: clean(last?.author?.login ?? last?.commit.author?.name ?? 'unknown', 200),
          assignees: [], labels: [], headSha: sha, branch: name, cursorless: true,
          push: {
            branch: name, before: previous, after: sha,
            subjects: commits.slice(-MAX_SUBJECTS).map((commit) => clean(commit.commit.message.split('\n', 1)[0] ?? '', 200)),
          },
        };
        if (admit(candidate)) cursorless.push(candidate);
      }
    }
    // Heads that left the listing are kept (newest first), so one sliding back is diffed, not new.
    const kept = Object.entries(state.branchHeads ?? {}).filter(([name]) => !(name in heads));
    next.branchHeads = Object.fromEntries([...Object.entries(heads), ...kept].slice(0, HEADS_CAP));
  }

  next.etags = etags;
  next.headsRepo = headsRepo;
  return { groups, cursorless, state: next, truncated };
}
