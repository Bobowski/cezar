import { statSync } from 'node:fs';
import { join } from 'node:path';
import { GITHUB_COM, ghConfigDir, isSafeHostname } from '../github-hosts.ts';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { GithubCandidate } from './github-poller.ts';
import { remoteForRepo, runCommand, type CommandRunner } from './pr-head.ts';
import type { GithubAutomationDefinition } from './types.ts';

/**
 * `deliver: 'owning-run'` (spec 2026-10-23-github-events §5): an event on a pull request a cezar
 * task owns goes into THAT task as a message, in the worktree that made the PR, instead of
 * starting a stranger with none of the context.
 */

/** `owner/repo` and the number of a `…/owner/repo/pull/N` URL. */
function pullOf(url: string | undefined): { repo: string; number: number } | undefined {
  const match = url ? /\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return match ? { repo: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]) } : undefined;
}

/** `pullOf` for a pull request OR an issue URL (`…/issues/N`). */
function itemOf(url: string | undefined): { repo: string; number: number } | undefined {
  const match = url ? /\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return match ? { repo: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]) } : undefined;
}

/**
 * Every run on item `number` of `repo`, whatever its part — the one that made it, a reviewer, a
 * `pr-head` verifier, a dispatched child, one an automation launched for it: any of them may
 * have written a comment there in its turn. Wider than `findOwningRun` on purpose; what it feeds
 * only ever defers.
 */
export function runsOnItem(runs: Iterable<RunRecord>, candidate: { repo: string; number?: number }): RunRecord[] {
  const number = candidate.number;
  if (number === undefined) return [];
  const repo = candidate.repo.toLowerCase();
  const same = (item: { repo: string; number: number } | undefined) => item?.repo === repo && item.number === number;
  return [...runs].filter((run) => {
    if (same(pullOf(run.pullRequestUrl)) || same(itemOf(run.automation?.githubUrl))) return true;
    if (run.prHead && run.prHead.number === number && run.prHead.repo.toLowerCase() === repo) return true;
    if (run.prRefs?.some((ref) => ref.number === number && (!ref.url || same(pullOf(ref.url))))) return true;
    return run.prNumber === number || run.issueNumber === number;
  });
}

/**
 * The run that owns pull request `number` of `repo`: the newest one that CREATED it (its
 * `pullRequestUrl`, or a `created` PR ref), else the newest that declared or was associated with
 * it (`prRefs`) or is about it (`prNumber` — numbers are one sequence per repository, so a number
 * names one item). A reference whose URL names another repository does not count. Never a
 * dispatched child (its parent owns the work), never a `pr-head` verifier (it tested the PR; it
 * cannot change it) and never a run whose worktree is gone — the code it would fix is not there.
 */
export function findOwningRun(runs: Iterable<RunRecord>, candidate: { repo: string; number?: number }): RunRecord | undefined {
  const number = candidate.number;
  if (number === undefined) return undefined;
  const repo = candidate.repo.toLowerCase();
  const sameRepo = (url: string | undefined) => {
    const pull = pullOf(url);
    return !pull || pull.repo === repo;
  };
  const owns = (run: RunRecord): boolean => {
    if (run.prHead || run.dispatch?.parentRunId) return false;
    if (run.worktree !== false && !run.worktreePath) return false;
    const created = pullOf(run.pullRequestUrl);
    if (created) return created.repo === repo && created.number === number;
    if (run.prRefs?.some((ref) => ref.number === number && sameRepo(ref.url))) return true;
    return run.prNumber === number;
  };
  const created = (run: RunRecord): boolean => {
    const made = pullOf(run.pullRequestUrl);
    if (made) return made.repo === repo && made.number === number;
    return run.prRefs?.some((ref) => ref.origin === 'created' && ref.number === number && sameRepo(ref.url)) ?? false;
  };
  let creator: RunRecord | undefined;
  let newest: RunRecord | undefined;
  for (const run of runs) {
    if (!owns(run)) continue;
    if (created(run) && (!creator || run.createdAt > creator.createdAt)) creator = run;
    if (!newest || run.createdAt > newest.createdAt) newest = run;
  }
  return creator ?? newest;
}

export type DeliveryOutcome =
  | { ok: true; how: 'live' | 'queued' | 'continued' }
  | { ok: false; error: string };

/**
 * The same ladder a person's message takes, as a user-visible message: folded into a run that
 * has not started, delivered into a session at rest or lined up behind the turn it is running
 * (the prompt queue), buffered while it starts — and, with no session left, a Continue.
 */
export function deliverAutomationMessage(manager: RunManager, runId: string, text: string): DeliveryOutcome {
  const content = [{ type: 'text' as const, text }];
  if (manager.enqueueMessage(runId, content)) return { ok: true, how: 'queued' };
  if (manager.hasLiveSession(runId)) {
    const prompt = manager.enqueuePrompt(runId, text);
    if (prompt.ok) return { ok: true, how: prompt.delivered ? 'live' : 'queued' };
  }
  if (manager.deferMessage(runId, content)) return { ok: true, how: 'queued' };
  const continued = manager.continueRun(runId, { text });
  return continued.ok ? { ok: true, how: 'continued' } : { ok: false, error: continued.error ?? 'the run could not be continued' };
}

/** The window the per-PR delivery cap counts over; the cap is the automation's `maxRecords`. */
export const DELIVERY_CAP_WINDOW_MS = 60 * 60_000;
/** GitHub's clock against this machine's: a comment this close before a turn began counts as in it. */
const CLOCK_SKEW_MS = 60_000;

/** When the run's current turn began, while it is working: the last `turn.started` with no
 *  `turn.completed`/`session.ended` after it, on a live run. A live run whose backend never says
 *  `turn.*` is working since it started. `undefined` when the run is at rest. */
export function openTurnSince(run: Pick<RunRecord, 'startedAt' | 'createdAt'>, events: readonly RunEvent[], live: boolean): number | undefined {
  if (!live) return undefined;
  let start: number | undefined;
  let sawTurn = false;
  for (const event of events) {
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) continue;
    if (event.type === 'turn.started') {
      sawTurn = true;
      start ??= at;
    } else if (event.type === 'turn.completed' || event.type === 'session.ended') start = undefined;
  }
  return sawTurn ? start : Date.parse(run.startedAt ?? run.createdAt);
}

const loginCache = new Map<string, { login?: string; at: number }>();
const hostCache = new Map<string, { host: string; at: number }>();
const LOGIN_TTL_MS = 10 * 60_000;
const LOGIN_RETRY_MS = 60_000;

/** When `gh`'s own config last changed — `gh auth switch`/`login`/`logout` rewrite `hosts.yml`. */
export function ghConfigStamp(): string {
  const dir = ghConfigDir();
  const mtime = (path: string) => { try { return String(statSync(path).mtimeMs); } catch { return '-'; } };
  return `${mtime(dir)}:${mtime(join(dir, 'hosts.yml'))}`;
}

/** The login cezar's `gh` speaks as on `repo`'s host (`gh api user`), cached ten minutes per host and
 *  `gh` config state, so a `gh auth switch` is seen on the next ask; a failed lookup is `undefined`
 *  and is asked again a minute later. Never under `CEZ_DRY_RUN=1`. */
export async function githubSelfLogin(
  root: string, repo: string, exec: CommandRunner = runCommand, now = Date.now(), stamp: () => string = ghConfigStamp,
): Promise<string | undefined> {
  if (process.env.CEZ_DRY_RUN === '1') return undefined;
  const repoKey = repo.toLowerCase();
  let host = hostCache.get(repoKey);
  if (!host || now - host.at >= LOGIN_TTL_MS) {
    const remote = await remoteForRepo(exec, root, repo).catch(() => ({ host: undefined }));
    host = { host: remote.host && isSafeHostname(remote.host) ? remote.host.toLowerCase() : GITHUB_COM, at: now };
    hostCache.set(repoKey, host);
  }
  const key = `${host.host}\n${stamp()}`;
  const cached = loginCache.get(key);
  if (cached && now - cached.at < (cached.login ? LOGIN_TTL_MS : LOGIN_RETRY_MS)) return cached.login;
  const answer = await exec('gh', ['api', ...(host.host === GITHUB_COM ? [] : ['--hostname', host.host]), 'user', '--jq', '.login'], root);
  const login = answer.ok && /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(answer.stdout.trim()) ? answer.stdout.trim() : undefined;
  loginCache.set(key, { ...(login ? { login } : {}), at: now });
  return login;
}

/** Test seam: forget every cached login. */
export function forgetGithubSelfLogins(): void {
  loginCache.clear();
  hostCache.clear();
}

/** What a delivery note carries so the per-PR cap can count it back. */
export type DeliveryMark = { automationId: string; repo: string; number: number };

/** Why an event does not go out now (`held`, re-decided on every poll), or what the log row must
 *  say about an event that does (`warning`). */
export type AutomationHold = { result: 'held' | 'warning'; reason: string };

/** The log row's word when `gh api user` cannot answer (#4 of the 2026-10-24 review). */
export const SELF_LOGIN_UNREADABLE = 'warning: cannot read the gh login; self-comment guard inactive (only the traces decide).';

/**
 * Why an event must NOT go out now, or `undefined` (spec 2026-10-23-github-events §11) — into its
 * owning run (`owner`), or, for a comment, as a new run. The traces decide first (the scheduler
 * drops what they claim); this is the tie-breaker for a comment no trace claimed. On a local
 * cockpit the `gh` login IS the human, so a comment by it is never dropped: one CREATED during
 * the still-open turn of a run on that PR or issue (`runsOnItem`) may be that run's own reply
 * posted by a means no trace saw (curl, an alias, a tool cezar does not parse), and is `held`
 * until the turn ends — then delivered, unless a trace has claimed it meanwhile. One written after
 * the turn ended goes at once. `allowSelfComments` turns that hold off. A login that cannot be
 * read holds nothing — only the traces decide then — and the event carries a `warning` for its
 * log row, so the guard's absence is visible. And an automation sends at most `maxRecords`
 * events an hour into one PR's run — or, for comments, launches that many runs for one item;
 * the rest are held until the window frees. Only what went out counts.
 */
export async function automationHold(input: {
  definition: GithubAutomationDefinition;
  candidate: GithubCandidate;
  owner?: RunRecord;
  runs: readonly RunRecord[];
  readEvents: (runId: string) => readonly RunEvent[];
  isLive: (runId: string) => boolean;
  selfLogin: () => Promise<string | undefined>;
  now?: number;
}): Promise<AutomationHold | undefined> {
  const { definition, candidate, owner } = input;
  const now = input.now ?? Date.now();
  const cap = definition.filters.maxRecords;
  const recent = (at: string) => now - Date.parse(at) < DELIVERY_CAP_WINDOW_MS;
  const item = { repo: candidate.repo.toLowerCase(), number: candidate.number };
  if (owner) {
    const delivered = input.readEvents(owner.id).filter((event) => {
      const mark = event.automationDelivery as Partial<DeliveryMark> | undefined;
      return event.type === 'note' && mark?.automationId === definition.id && mark.number === candidate.number
        && mark.repo?.toLowerCase() === item.repo && recent(event.ts);
    }).length;
    if (delivered >= cap) return { result: 'held', reason: `delivery-cap: ${delivered} events of this automation already went into run ${owner.id} for #${candidate.number} in the last hour (cap ${cap}, the automation's maxRecords) — held until the window frees.` };
  } else if (candidate.comment) {
    const launches = new Set(input.runs.filter((run) => {
      const about = itemOf(run.automation?.githubUrl);
      return run.automation?.automationId === definition.id && about?.repo === item.repo && about.number === item.number && recent(run.createdAt);
    }).map((run) => run.automation!.receiptId)).size;
    if (launches >= cap) return { result: 'held', reason: `launch-cap: this automation already launched ${launches} runs for comments on #${candidate.number} in the last hour (cap ${cap}, the automation's maxRecords) — held until the window frees.` };
  }
  const comment = candidate.comment;
  if (!comment || definition.filters.allowSelfComments === true) return undefined;
  // A collapsed review is decided per comment: any one of them written in the turn holds it.
  const times = (comment.parts?.map((part) => part.at) ?? [candidate.timestamp]).map((value) => Date.parse(value)).filter(Number.isFinite);
  const onItem = runsOnItem(input.runs, candidate);
  if (owner && !onItem.some((run) => run.id === owner.id)) onItem.push(owner);
  const working = onItem.find((run) => {
    const since = openTurnSince(run, input.readEvents(run.id), input.isLive(run.id));
    return since !== undefined && times.some((at) => at >= since - CLOCK_SKEW_MS);
  });
  if (!working) return undefined;
  const login = await input.selfLogin();
  if (login === undefined) return { result: 'warning', reason: SELF_LOGIN_UNREADABLE };
  if (login.toLowerCase() !== comment.author.toLowerCase()) return undefined;
  return {
    result: 'held',
    reason: `own-comment: by ${login}, the login cezar runs as, during run ${working.id}'s current turn — held until the turn ends, then sent unless a trace claims it as the run's own reply.`,
  };
}
