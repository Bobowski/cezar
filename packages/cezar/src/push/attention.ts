import type { RunRecord } from '@open-mercato/cezar-contract';

/**
 * Which runs are worth a push (spec 2026-10-24-mobile-cockpit §3.5): the ones the cockpit's
 * `wantsAttention` names (`packages/web/src/lib/attention.ts`), with the same label. Node-free on
 * purpose, so the cockpit's suite can hold the two to the same answers
 * (`packages/web/src/lib/push-attention-parity.test.ts`).
 */

export type AttentionRun = Pick<RunRecord, 'status' | 'autoResumeAt' | 'awaitingAnswerSince' | 'dispatch' | 'worktreeLifecycle'>;

/** The attention label of a run that wants a human, or null when it does not. */
export function pushLabelOf(run: AttentionRun): string | null {
  const lifecycle = run.worktreeLifecycle;
  if (lifecycle?.needsAttention) return lifecycle.phase === 'setup' ? 'setup needs attention' : 'cleanup needs attention';
  if (lifecycle?.activeOperationId) return null;
  if (run.status === 'failed' && run.autoResumeAt) return null;
  if (run.status === 'failed') return run.awaitingAnswerSince !== undefined ? 'needs you' : 'failed';
  if (run.status === 'waiting') return run.dispatch?.overBudget && run.dispatch.budgetUsd !== undefined ? 'budget reached' : 'needs you';
  if (run.status === 'review') return 'needs review';
  return null;
}
