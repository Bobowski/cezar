# Telemetry: session-resume fallbacks and task failures

## 📝 TLDR
Maintainers cannot see how often a Continue hits a conversation Claude has pruned (#1435), whether the fresh-session fallback recovers the task, or how often tasks fail per backend. Proposed: two consent-gated events with one closed-set label each — `session_resume_fallback` (`recovered` / `fresh_failed` / `cancelled`) and `task_failed` (`<backend>:<kind>`). No ids, no error text.

## 📝 Problem Statement
- A Continue is counted only as `message_sent` (`existing_session`), indistinguishable from any follow-up.
- No event fires when a run settles `failed`; the registry has `task_archived` / `task_deleted` / `task_pinned` / `task_unpinned` only.
- A "No conversation found" resume ends cleanly as `failed`, so it never reaches error reports (a 30-day error search finds no group).

## 📝 Proposed Solution
Follow the `skills_provisioned` / `skill_missing_in_session` pattern (#1429): `track(event, { label })` from `packages/cezar/src/telemetry.ts`, a closed-set label, nothing else.

1. **`session_resume_fallback`** — sent once per fallback, from both sites that call `ResumeFallback.takeFallback()` (`runContinuation` and `runAgentStep` in `workflows/run.ts`), after the fresh session settles:
   - `recovered` — the fresh session's `result` settled without a session error.
   - `fresh_failed` — the fresh session threw or reported a session error.
   - `cancelled` — the run was cancelled (or superseded) while the fresh session ran.
2. **`task_failed`** — sent when a run transitions to `failed`. Label `<backend>:<kind>`:
   - backend = the record's `runner` (a `RunnerId`), else `unknown`.
   - kind (first match wins): `missing_session` (`isClaudeMissingSessionError`), `usage_limit` (`parseUsageLimit(...) !== null` or the patch sets `autoResumeAt`), `auth` (`isRuntimeProviderAuthFailure` / `isCopilotAuthFailure`), `timeout` (a runner's `timed out after …m and was killed`, or the inactivity-close message), else `other`.

**Alternatives considered.** Instrumenting each of the ~22 `status: 'failed'` writes in `run.ts` (plus server-side writers) — rejected: AGENTS.md § "find every construction site"; a new failure path would silently go uncounted. Sending the error text or a hash — rejected by the telemetry policy (docs/telemetry.md: closed-set labels only).

## 📝 Architecture
- **`task_failed` chokepoint: `RunStore.updateRun`** (`runs/store.ts`). It already normalizes status transitions centrally; it fires `task_failed` when `patch.status === 'failed'` and the record's previous status was not `failed` (a re-write of an already-failed run, e.g. an `error` patch, does not double count).
- **Classifier: new `runs/failure-kind.ts`** — `failureKind(error: string | undefined, patch): FailureKind` and `taskFailedLabel(runner, kind)`. Pure, unit-tested; reuses the existing detectors rather than new regexes, except the timeout pattern.
- **Fallback outcome**: both sites already wrap the fresh launch in the same `catch` branch; each records the outcome in a `try/finally` around the fresh `await session.result` and calls one helper (`trackResumeFallback(outcome)`) so the two sites cannot drift (AGENTS.md § near-identical handlers).
- `track` already gates on consent, `CEZ_TELEMETRY=0` and `DO_NOT_TRACK=1`; nothing new is sent without a yes.

## 📝 Data Model
None. No persisted field changes; labels are computed and sent, never stored.

## 📝 API Contracts
No HTTP change. Telemetry surface: two new event names added to `TELEMETRY_EVENTS` and docs/telemetry.md, and registered in the telemetry registry via `add_event` before shipping.

## 📝 Edge Cases & Failure Scenarios
- **Boot recovery marks orphaned runs `failed`** — counted as `<backend>:other`; acceptable, it is a real failure the user sees.
- **Auto-resume after a usage limit** — the run fails once (`usage_limit`), is resumed, and may fail again later; each transition into `failed` counts once.
- **Fallback recovers but the task later fails for another reason** — `session_resume_fallback:recovered` and `task_failed:<backend>:other` both fire; the fallback event measures the resume, not the task.
- **Fresh session also hits a missing conversation** — impossible by construction (`takeFallback` fires once, the fresh session is never a resume); it would report `fresh_failed`.
- **Label sanitation** — `track` already rewrites non-label characters; backend ids and kinds are `[a-z-]` so nothing is altered.

## 📝 Risks & Impact Review
Low. Additive, consent-gated, no schema/API change. Coupling `RunStore` to telemetry is a new import in the persistence layer; it is a fire-and-forget call that cannot throw into the write path (`track` returns void and swallows network failures).

## Resolved assumptions (autonomous defaults)

| # | Question | Default | Rationale |
| --- | --- | --- | --- |
| Q1 | Where does `task_failed` fire — each failure site or one chokepoint? | One chokepoint in `RunStore.updateRun`, on the transition into `failed`. | Covers every current and future failure path; no per-site drift. |
| Q2 | What does "the fresh session showed signs of life" mean for `recovered`? | The fresh session settled without a session error (and the run was not cancelled). | Reuses the existing success test at both sites; no new liveness heuristic. |
| Q3 | Is the inactivity close (`the session closed after inactivity…`) a `timeout`? | Yes. | It is a time-bound close; keeps the closed set at the issue's five kinds. |
| Q4 | Should other backends get their own missing-session kind now (#1193)? | No — defer to #1193. | Only Claude has a missing-session detector today. |
| Q5 | The two events are independently deployable — split into two specs? | No; one spec, two phases. | The issue scopes them together, each is a few lines, and phases ship independently. |

## 📋 Implementation Plan

### Phase 1 — `task_failed`
1. Add `runs/failure-kind.ts` (`failureKind`, `taskFailedLabel`) with unit tests pinning each kind, the `unknown` backend, and that the label never contains error text or ids.
2. Fire `track('task_failed', { label })` from `RunStore.updateRun` on the transition into `failed`; store tests (with `track` mocked) pin: fires once on transition, not on a re-write of a failed run, label shape for a usage-limit patch.

### Phase 2 — `session_resume_fallback`
3. Add the outcome tracking at both `takeFallback` sites in `workflows/run.ts` through one helper; `run.test.ts` cases (mocked runner emitting the missing-session error, then a fresh session that succeeds / fails / is cancelled) pin `recovered` / `fresh_failed` / `cancelled` on `runContinuation`, and at least `recovered` on the graph `runAgentStep` site.

### Phase 3 — Registry and docs
4. Add both names to `TELEMETRY_EVENTS`; document them in docs/telemetry.md beside `skills_provisioned`; register both via `add_event`.
