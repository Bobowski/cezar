# Indexed dispatch lookups

Issue: #1216

## Goal

Replace full `RunStore.listRuns()` scans on dispatch hot paths with store-owned indexes by
`dispatch.rootRunId` and `dispatch.parentRunId`, without changing wake delivery, inbox watermark
or file-mtime semantics.

## Scope

- `packages/cezar/src/runs/store.ts`: maintain and expose secondary indexes.
- `packages/cezar/src/workflows/run.ts`: use indexed root/parent lookups for dispatch wakeups,
  child caps, budget accounting, max-subtask limits, and descendant cancellation.
- Tests covering index loading/mutation/order and dispatch lookup behavior.

Non-goals: automation or attachment routes, changes to `listInbox`, directory-mtime checks,
`Dirent`-based inbox scanning, wake timing, eligibility filters, or persisted record format.

## Implementation plan

### Phase 1: Store indexes

- [x] 1.1 Add root/parent secondary indexes with stable existing ordering and lifecycle updates. — 7097e895
- [x] 1.2 Add regression tests for load, insertion, reassignment, removal/pruning, and ordering. — 7097e895

### Phase 2: Dispatch consumers

- [x] 2.1 Replace dispatch wake, cap, budget, max-subtask, and cancellation scans with indexes. — 7097e895
- [ ] 2.2 Add/adjust dispatch regression coverage for tree isolation and preserved delivery behavior.

### Phase 3: Verification

- [ ] 3.1 Run the configured full validation gate and authoritative PR review.

## Risks

Index maintenance must stay synchronized with every dispatch mutation and deletion; a stale index
could miss a wake or miscount a child. Indexes are rebuilt from `runs.json` at open and are not a
new persisted format.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Store indexes

- [x] 1.1 Add root/parent secondary indexes with stable existing ordering and lifecycle updates. — 7097e895
- [x] 1.2 Add regression tests for load, insertion, reassignment, removal/pruning, and ordering. — 7097e895

### Phase 2: Dispatch consumers

- [x] 2.1 Replace dispatch wake, cap, budget, max-subtask, and cancellation scans with indexes. — 7097e895
- [ ] 2.2 Add/adjust dispatch regression coverage for tree isolation and preserved delivery behavior.

### Phase 3: Verification

- [ ] 3.1 Run the configured full validation gate and authoritative PR review.
