import type { ApiTokenScope } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { scopesSeeTranscript } from './api-tokens.ts';
import type { Principal } from './guard.ts';

/**
 * A task record as a principal may see it (spec 2026-10-24-cezar-mcp-server §4). A token without
 * `runs.transcript` gets status, timing, counters, branch and PR — never what the agent wrote,
 * which can quote anything a command printed. Every route and stream that hands out a run record
 * goes through {@link redactRunForScope}; the contract names the result (`apiRunSchema.projected`).
 */

/** The scopes a request's principal is bounded by; undefined for the owner (session, host, auth off). */
export function runViewScopes(principal: Principal | undefined): readonly ApiTokenScope[] | undefined {
  return principal?.kind === 'token' ? principal.scopes : undefined;
}

export function redactRunForScope<T extends RunRecord>(
  run: T,
  scopes: readonly ApiTokenScope[] | undefined,
): T & { projected?: true } {
  if (scopes === undefined || scopesSeeTranscript(scopes)) return run;
  const { titleSummary: _summary, graphState, dispatch, ...rest } = run;
  const projected: Record<string, unknown> = { ...rest, projected: true };
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
