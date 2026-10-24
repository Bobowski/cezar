import type { ApiTokenScope } from '@open-mercato/cezar-contract';
import { failureLine } from '../runs/failure-kind.ts';
import type { RunRecord, StepState } from '../runs/store.ts';
import { scopesSeeTranscript } from './api-tokens.ts';
import type { Principal } from './guard.ts';

/**
 * A task record as a principal may see it (spec 2026-10-24-cezar-mcp-server §4). A token without
 * `runs.transcript` gets status, timing, counters, branch and PR — never what the agent wrote or a
 * command printed, which can quote any secret. Every route and stream that hands out a run record
 * goes through {@link redactRunForScope}; the contract names the result (`apiRunSchema.projected`).
 */

/** The scopes a request's principal is bounded by; undefined for the owner (session, host, auth off). */
export function runViewScopes(principal: Principal | undefined): readonly ApiTokenScope[] | undefined {
  return principal?.kind === 'token' ? principal.scopes : undefined;
}

/** Whether these scopes get the projected view of a task. */
export function projectsRuns(scopes: readonly ApiTokenScope[] | undefined): scopes is readonly ApiTokenScope[] {
  return scopes !== undefined && !scopesSeeTranscript(scopes);
}

/** `landing.error` carries a required check's whole output (`workflows/landing.ts`). */
export function landingFailureLine(stage: string | undefined): string {
  if (stage === 'checks') return 'required check failed';
  return stage ? `landing failed at ${stage}` : 'landing failed';
}

/** A slim task row (runs index, dashboard) as a projected principal sees it: no `titleSummary`. */
export function projectTaskRow<T extends { titleSummary?: string }>(row: T): T {
  const { titleSummary: _summary, ...rest } = row;
  return rest as T;
}

function projectStep(step: StepState): StepState {
  if (step.error === undefined) return step;
  return { ...step, error: step.kind === 'check' ? 'check failed' : failureLine(step.error) };
}

export function redactRunForScope<T extends RunRecord>(
  run: T,
  scopes: readonly ApiTokenScope[] | undefined,
): T & { projected?: true } {
  if (!projectsRuns(scopes)) return run;
  const { titleSummary: _summary, graphState, dispatch, ...rest } = run;
  const projected: Record<string, unknown> = { ...rest, steps: run.steps.map(projectStep), projected: true };
  if (run.error !== undefined) projected.error = failureLine(run.error);
  if (run.landing?.error !== undefined) projected.landing = { ...run.landing, error: landingFailureLine(run.landing.stage) };
  if (graphState) {
    const { outputs: _outputs, ...walk } = graphState;
    projected.graphState = walk;
  }
  if (dispatch) {
    const { report: _report, pendingReports: _pending, pendingAsk: _ask, ...tree } = dispatch;
    projected.dispatch = tree;
  }
  return projected as T & { projected: true };
}
