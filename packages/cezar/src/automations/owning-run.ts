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

/** Why an event does not go into its owning run now: `held` is re-decided on every poll. */
export type OwningRunHold = { result: 'held'; reason: string };

/**
 * Why an event must NOT go into its owning run now, or `undefined` (spec 2026-10-23-github-events
 * §11). The traces decide first (the scheduler drops what they claim); this is the tie-breaker for
 * a comment no trace claimed. On a local cockpit the `gh` login IS the human, so a comment by it
 * is never dropped: one CREATED during the run's current, still-open turn may be the run's own
 * reply posted by a means no trace saw (curl, an alias, a tool cezar does not parse), and is
 * `held` until that turn ends — then delivered, unless a trace has claimed it meanwhile. One
 * written after the turn ended is the human's and goes at once. `allowSelfComments` turns the
 * hold off. An unknown login holds like ours: a loop costs more than a held comment.
 */
export async function owningRunHold(input: {
  definition: GithubAutomationDefinition;
  candidate: GithubCandidate;
  owner: RunRecord;
  events: readonly RunEvent[];
  live: boolean;
  selfLogin: () => Promise<string | undefined>;
  now?: number;
}): Promise<OwningRunHold | undefined> {
  const { definition, candidate, owner, events } = input;
  const now = input.now ?? Date.now();
  const delivered = events.filter((event) => {
    const mark = event.automationDelivery as Partial<DeliveryMark> | undefined;
    return event.type === 'note' && mark?.automationId === definition.id && mark.number === candidate.number
      && mark.repo?.toLowerCase() === candidate.repo.toLowerCase() && now - Date.parse(event.ts) < DELIVERY_CAP_WINDOW_MS;
  }).length;
  const cap = definition.filters.maxRecords;
  // Only deliveries count; an event over the cap is held, and goes in when the window frees.
  if (delivered >= cap) return { result: 'held', reason: `delivery-cap: ${delivered} events of this automation already went into run ${owner.id} for #${candidate.number} in the last hour (cap ${cap}, the automation's maxRecords) — held until the window frees.` };
  const comment = candidate.comment;
  if (!comment || definition.filters.allowSelfComments === true) return undefined;
  const since = openTurnSince(owner, events, input.live);
  if (since === undefined) return undefined;
  // A collapsed review is decided per comment: any one of them written in the turn holds it.
  const times = (comment.parts?.map((part) => part.at) ?? [candidate.timestamp]).map((value) => Date.parse(value));
  if (!times.some((at) => Number.isFinite(at) && at >= since - CLOCK_SKEW_MS)) return undefined;
  const login = await input.selfLogin();
  if (login !== undefined && login.toLowerCase() !== comment.author.toLowerCase()) return undefined;
  return {
    result: 'held',
    reason: login === undefined
      ? `own-comment: written during run ${owner.id}'s current turn, and cezar's GitHub login could not be read to tell it from the run's own reply — held until the turn ends.`
      : `own-comment: by ${login}, the login cezar runs as, during run ${owner.id}'s current turn — held until the turn ends, then delivered unless a trace claims it as the run's own reply.`,
  };
}
