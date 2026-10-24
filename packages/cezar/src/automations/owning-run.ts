import type { RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';

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
 * The newest run that made or works on pull request `number` of `repo`: its created PR, a PR it
 * declared or was associated with (`prRefs`), or the PR/issue number it is about (`prNumber` —
 * numbers are one sequence per repository, so a number names one item). A reference whose URL
 * names another repository does not count. Never a `pr-head` verifier (it tested the PR; it cannot
 * change it) and never a run whose worktree is gone — the code it would fix is not there.
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
    if (run.prHead) return false;
    if (run.worktree !== false && !run.worktreePath) return false;
    const created = pullOf(run.pullRequestUrl);
    if (created) return created.repo === repo && created.number === number;
    if (run.prRefs?.some((ref) => ref.number === number && sameRepo(ref.url))) return true;
    return run.prNumber === number;
  };
  let newest: RunRecord | undefined;
  for (const run of runs) {
    if (owns(run) && (!newest || run.createdAt > newest.createdAt)) newest = run;
  }
  return newest;
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
