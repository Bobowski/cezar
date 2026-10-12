# Compact subtasks header (#1237)

## Goal

Resolve the remaining scoped behavior from issue #1237 without duplicating the already-landed
subtasks-header fix: preserve an explicitly expanded Agents dock when its fan-out settles.

## Scope

- Verify the existing bounded `DispatchChildrenLine` implementation and regression coverage.
- Update `packages/web/src/routes/task-thread/agents-dock.tsx` so automatic completion collapse does
  not override a user's explicit expansion.
- Update the Agents dock regression tests.

## Non-goals

- Rework the already-fixed subtasks header.
- Change workflow step-rail semantics; the issue's phrase "subagents pane" is treated as the Agents
  dock only.

## Implementation Plan

### Phase 1: Verify and preserve user intent

- [ ] 1.1 Record the existing header fix and tests, and create the task PR.
- [ ] 1.2 Preserve explicit Agents dock expansion across completion and update regression coverage.
- [ ] 1.3 Run targeted and full validation, review the PR, and finalize evidence.

## Risks

The dock's auto-collapse transition is local UI state. Tracking only an explicit expand keeps the
existing default collapse and automatic cleanup for untouched docks while avoiding a surprising
collapse after a deliberate user action.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Verify and preserve user intent

- [ ] 1.1 Record the existing header fix and tests, and create the task PR.
- [ ] 1.2 Preserve explicit Agents dock expansion across completion and update regression coverage.
- [ ] 1.3 Run targeted and full validation, review the PR, and finalize evidence.
