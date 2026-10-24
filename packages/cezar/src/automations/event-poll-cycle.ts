import { AutomationLaunchOutcome } from './task-template.ts';
import type { AutomationDefinition, AutomationLogRecord, AutomationReceipt, AutomationRuntimeState } from './types.ts';
import type { AutomationStore } from './store.ts';

export class LeaseHeldError extends Error {
  constructor() { super('automation polling lease is held by another process'); }
}

/** One lease/eligibility/launch/checkpoint protocol for every event provider. */
export async function runEventPollCycle<C extends { timestamp: string }, R extends { candidates: C[] }>(input: {
  store: AutomationStore;
  definition: AutomationDefinition;
  mode: 'preview' | 'execute';
  scheduled?: boolean;
  poll: (state: AutomationRuntimeState) => Promise<R>;
  /** Runs under the snapshot mutation lease, only for a current execute cycle. */
  prepareState?: (state: AutomationRuntimeState) => void;
  eligible?: (candidate: C, state: AutomationRuntimeState) => boolean;
  isCurrent?: () => Promise<boolean>;
  launch?: (candidate: C) => Promise<void>;
  /** Decides this automation's held events again (`releaseHeldEvents`), before new candidates. */
  releaseHeld?: () => Promise<void>;
  persist: (result: R, current: AutomationRuntimeState) => AutomationRuntimeState;
  /** What a completed execute cycle's `no-match` row says; defaults to a plain completion. */
  reason?: (result: R) => string;
  onChange?: (id: string, revision: number) => void;
}): Promise<R> {
  const { store, definition, mode } = input;
  const lease = store.acquireLease();
  if (!lease) {
    const error = new LeaseHeldError();
    store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'skipped', reason: error.message });
    if (input.scheduled ?? mode === 'execute') {
      store.setState(definition.id, current => ({
        ...current, nextCheckAt: new Date(Date.now() + (definition.intervalSeconds ?? 60) * 1000).toISOString(),
      }));
      input.onChange?.(definition.id, definition.revision);
    }
    throw error;
  }
  const started = Date.now();
  let capturedState: AutomationRuntimeState | undefined;
  const current = () => {
    const found = store.get(definition.id);
    const latestState = store.state(definition.id) ?? {};
    return capturedState !== undefined
      && found?.revision === definition.revision
      && found.enabled === definition.enabled
      && latestState.baselineAt === capturedState.baselineAt
      && latestState.revision === capturedState.revision;
  };
  try {
    if (!lease.isValid()) throw new Error('automation polling lease was lost');
    const snapshotLease = store.acquireMutationLease();
    if (!snapshotLease) throw new Error('automation mutation conflict');
    try {
      capturedState = store.state(definition.id) ?? {};
      if (mode === 'execute' && current() && input.prepareState) {
        input.prepareState(capturedState);
        capturedState = store.state(definition.id) ?? {};
      }
    } finally {
      snapshotLease.release();
    }
    const state = capturedState;
    if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) {
      throw new Error(`automation is backed off until ${state.backoffUntil}`);
    }
    const result = await input.poll(state);
    if (!lease.isValid()) throw new Error('automation polling lease was lost');
    const eligible = result.candidates.filter(candidate =>
      (!state.baselineAt || candidate.timestamp > state.baselineAt)
      && (!input.eligible || input.eligible(candidate, state)),
    );
    if (mode === 'execute') {
      if (input.releaseHeld) {
        if (!lease.isValid()) throw new Error('automation polling lease was lost');
        const mutation = store.acquireMutationLease();
        if (!mutation) throw new Error('automation mutation conflict');
        try {
          if (!current() || (input.isCurrent && !await input.isCurrent())) {
            return { ...result, candidates: [] };
          }
          if (!mutation.isValid()) throw new Error('automation mutation lease was lost');
          await input.releaseHeld();
        } finally {
          mutation.release();
        }
      }
      for (const candidate of eligible) {
        if (!lease.isValid()) throw new Error('automation polling lease was lost');
        const mutation = store.acquireMutationLease();
        if (!mutation) throw new Error('automation mutation conflict');
        try {
          if (!current() || (input.isCurrent && !await input.isCurrent())) {
            return { ...result, candidates: [] };
          }
          if (!mutation.isValid()) throw new Error('automation mutation lease was lost');
          await input.launch?.(candidate);
        } finally {
          mutation.release();
        }
      }
      const mutation = store.acquireMutationLease();
      if (!mutation) throw new Error('automation mutation conflict');
      try {
        // The trailing `mutation.isValid()` is the deliberate re-check AFTER `isCurrent` is
        // awaited: the guard can be lost while that promise is pending, and a lost guard must
        // not publish state a successor already owns. Do not "simplify" it away.
        if (lease.isValid() && mutation.isValid() && current() && (!input.isCurrent || await input.isCurrent()) && mutation.isValid()) {
          store.setState(definition.id, state => input.persist(result, state));
        }
      } finally {
        mutation.release();
      }
    }
    store.appendLog({
      automationId: definition.id,
      revision: definition.revision,
      result: mode === 'preview' ? 'preview' : 'no-match',
      reason: mode === 'preview'
        ? `Bounded preview found ${eligible.length} match${eligible.length === 1 ? '' : 'es'}; no tasks were launched.`
        : input.reason?.(result) ?? 'Scheduled check completed.',
      durationMs: Date.now() - started,
    });
    input.onChange?.(definition.id, definition.revision);
    return { ...result, candidates: eligible };
  } catch (error) {
    // A compromised owner must not append backoff/error state after another
    // process has taken over this automation.
    if (!lease.isValid()) throw new Error('automation polling lease was lost');
    const mutation = store.acquireMutationLease();
    try {
      if (mutation && lease.isValid() && mode === 'execute' && current()) {
        store.setState(definition.id, state => {
          const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
          const delay = Math.min(21_600_000, 60_000 * 2 ** (consecutiveFailures - 1));
          const nextCheckAt = new Date(Date.now() + delay).toISOString();
          return { ...state, consecutiveFailures, nextCheckAt, backoffUntil: nextCheckAt };
        });
      }
    } finally {
      mutation?.release();
    }
    store.appendLog({
      automationId: definition.id,
      revision: definition.revision,
      result: 'error',
      reason: error instanceof Error ? error.message : String(error),
    });
    input.onChange?.(definition.id, definition.revision);
    throw error;
  } finally {
    try {
      store.maybeCompact();
    } catch {
      // Retry maintenance next cycle.
    }
    lease.release();
  }
}

type EventLogFields = Pick<AutomationLogRecord, 'event' | 'githubNumber' | 'githubTitle' | 'githubUrl' | 'trackerKey' | 'trackerTitle' | 'trackerUrl'>;
export type EventLaunched = { runId: string; delivered?: true; note?: string };

/** A launch's receipt and log row: `delivered-to` for a delivery into an owning run, else `launched`. */
export function recordLaunched(store: AutomationStore, definition: AutomationDefinition, receipt: AutomationReceipt, log: EventLogFields, launched: EventLaunched): void {
  const identity = { automationId: definition.id, revision: definition.revision };
  store.appendReceipt({
    ...receipt, status: 'launched', runId: launched.runId, error: undefined, updatedAt: new Date().toISOString(),
    ...(launched.delivered ? { delivered: true } : {}),
  });
  // spec 2026-10-23-github-events §5: `delivered-to: <runId>` instead of `launched: <runId>`.
  store.appendLog(launched.delivered
    ? { ...identity, ...log, result: 'delivered', reason: `delivered-to: ${launched.runId}${launched.note ? ` — ${launched.note}` : ''}`, receiptId: receipt.receiptId, runId: launched.runId }
    : { ...identity, ...log, result: 'launched', receiptId: receipt.receiptId, runId: launched.runId, ...(launched.note ? { reason: launched.note } : {}) });
}

/**
 * A launch that ended without a run on purpose (a closed PR, a fork head), on an unreachable PR
 * head, or deferred (`held`): recorded against this event, never thrown into the poll cycle —
 * one PR's state must not back off the whole automation. `failed` keeps the retryable
 * `launch-error` receipt, so Retry works once the network or `gh` auth is back.
 */
export function recordOutcome(store: AutomationStore, definition: AutomationDefinition, receipt: AutomationReceipt, log: EventLogFields, outcome: AutomationLaunchOutcome): void {
  store.appendReceipt({
    ...receipt,
    status: outcome.result === 'failed' ? 'launch-error' : outcome.result,
    error: outcome.result === 'failed' ? outcome.reason.slice(0, 2_000) : undefined,
    updatedAt: new Date().toISOString(),
  });
  store.appendLog({ automationId: definition.id, revision: definition.revision, ...log, result: outcome.result, reason: outcome.reason, receiptId: receipt.receiptId });
}

/** The candidate a held receipt was reserved from, body included — this process only, since a
 *  receipt never stores a body; after a restart the receipt's own (body-less) candidate decides. */
const heldCandidates = new Map<string, unknown>();
const HELD_MEMORY_CAP = 500;

function rememberHeld(receiptId: string, candidate: unknown): void {
  if (candidate === undefined) return;
  heldCandidates.delete(receiptId);
  heldCandidates.set(receiptId, candidate);
  while (heldCandidates.size > HELD_MEMORY_CAP) heldCandidates.delete(heldCandidates.keys().next().value!);
}

/** Durable event reservation is shared too; facades supply only provider payload/log fields. */
export async function launchEventCandidate(input: {
  store: AutomationStore;
  definition: AutomationDefinition;
  receipt: Omit<Parameters<AutomationStore['reserveReceipt']>[0], 'automationId' | 'revision'>;
  log: EventLogFields;
  launch: (receiptId: string) => Promise<EventLaunched>;
}): Promise<void> {
  const { store, definition } = input;
  const identity = { automationId: definition.id, revision: definition.revision };
  const receipt = store.reserveReceipt({ ...identity, ...input.receipt });
  if (!receipt) {
    store.appendLog({
      ...identity, ...input.log, result: 'duplicate',
      reason: 'A durable receipt already exists for this automation and event.',
    });
    return;
  }
  try {
    recordLaunched(store, definition, receipt, input.log, await input.launch(receipt.receiptId));
  } catch (error) {
    if (error instanceof AutomationLaunchOutcome) {
      if (error.result === 'held') rememberHeld(receipt.receiptId, input.receipt.candidate);
      recordOutcome(store, definition, receipt, input.log, error);
      return;
    }
    store.appendReceipt({
      ...receipt, status: 'launch-error',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

/**
 * Decide every `held` event of `definition` again, oldest first (spec 2026-10-23-github-events
 * §11): one held under another revision, of an event the definition no longer `tracks`, or
 * from before its current baseline is `skipped` as superseded — an edit, an enable or a
 * re-baseline owes it nothing; one a trace now claims is cezar's own and is `skipped`; one still
 * held stays as it is,
 * silently; any other is launched or delivered like a new event. `launch` calls `admit` once the
 * holds pass and before anything starts, so the receipt is `reserved` across the launch the way
 * a fresh event's is, and a crash mid-launch is reconciled rather than repeated.
 */
export async function releaseHeldEvents<C extends { timestamp: string }>(input: {
  store: AutomationStore;
  definition: AutomationDefinition;
  candidateOf: (receipt: AutomationReceipt) => C | undefined;
  log: (candidate: C) => EventLogFields;
  own?: (candidate: C) => Promise<boolean>;
  /** False for an event the definition no longer listens to. */
  tracks?: (candidate: C) => boolean;
  launch: (receiptId: string, candidate: C, admit: () => void) => Promise<EventLaunched>;
}): Promise<void> {
  const { store, definition } = input;
  const baselineAt = store.state(definition.id)?.baselineAt;
  const superseded = (receipt: AutomationReceipt, candidate: C): string | undefined => {
    if (receipt.revision !== definition.revision) return `superseded: held under revision ${receipt.revision}, the automation is at ${definition.revision} now; not sent.`;
    if (input.tracks && !input.tracks(candidate)) return 'superseded: the automation no longer tracks this event; not sent.';
    if (baselineAt && Date.parse(candidate.timestamp) < Date.parse(baselineAt)) return `superseded: older than the automation's baseline (${baselineAt}); not sent.`;
    return undefined;
  };
  const held = [...store.latestReceipts().values()]
    .filter((receipt) => receipt.automationId === definition.id && receipt.status === 'held')
    .flatMap((receipt) => {
      const candidate = (heldCandidates.get(receipt.receiptId) as C | undefined) ?? input.candidateOf(receipt);
      return candidate ? [{ receipt, candidate }] : [];
    })
    .sort((a, b) => a.candidate.timestamp.localeCompare(b.candidate.timestamp) || a.receipt.observedAt.localeCompare(b.receipt.observedAt));
  for (const { receipt, candidate } of held) {
    const log = input.log(candidate);
    const stale = superseded(receipt, candidate);
    if (stale) {
      heldCandidates.delete(receipt.receiptId);
      recordOutcome(store, definition, receipt, log, new AutomationLaunchOutcome('skipped', stale));
      continue;
    }
    if (await input.own?.(candidate)) {
      heldCandidates.delete(receipt.receiptId);
      recordOutcome(store, definition, receipt, log, new AutomationLaunchOutcome('skipped', 'own-trace: a push or comment cezar recorded as its own; never delivered.'));
      continue;
    }
    let admitted = receipt;
    try {
      const launched = await input.launch(receipt.receiptId, candidate, () => {
        admitted = { ...receipt, status: 'reserved', updatedAt: new Date().toISOString() };
        store.appendReceipt(admitted);
      });
      heldCandidates.delete(receipt.receiptId);
      recordLaunched(store, definition, admitted, log, launched);
    } catch (error) {
      if (error instanceof AutomationLaunchOutcome) {
        // Still held: the row already says so, and every poll would repeat it.
        if (error.result === 'held' && admitted === receipt) continue;
        heldCandidates.delete(receipt.receiptId);
        recordOutcome(store, definition, admitted, log, error);
        continue;
      }
      heldCandidates.delete(receipt.receiptId);
      store.appendReceipt({ ...admitted, status: 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
      throw error;
    }
  }
}
