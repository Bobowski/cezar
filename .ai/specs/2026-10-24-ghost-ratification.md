# Ghost — owner decisions of 2026-10-24, and the path onto brutus

> Status: decisions recorded (2026-10-24). Branch: `brutus`.
> Amends: `2026-10-19-ghost-speculative-tasks.md`, which lives on `feat/ghost-speculative-tasks`
> together with the G0 engine (not on `brutus` as of this note). Builds on:
> `2026-10-23-github-events.md` (comment events, the loop guard), `2026-10-24-cockpit-chat.md`.
> Backlog item: "Ghost mode".

## 1. What Ghost is

Speculative tasks: cezar predicts the next few tasks the user will type from local signals,
runs the most likely ones in the background in ordinary worktrees under a tight budget, keeps
them hidden, and offers a finished one when the user types a matching task. The draft spec
has the full design; G0 (the engine: the `ghost` block on `RunRecord`, the lowest-priority lane
in `pump()` with preemption, the budget brake, claim/discard, `/ghost` routes, `cez ghost`) is
built on its branch. G1 (signals + predictor + the project toggle), G2 (composer matching),
G3 (learning) are not.

## 2. Decisions taken

| # | Gate in the draft | Decision |
| --- | --- | --- |
| 1 | Default | **Approved as drafted**: available by default, does nothing until the project's toggle is on; `CEZ_GHOST=0` removes it (capability off, routes 409, no UI). Recorded in AGENTS.md § Zero config as an owner-approved exception the day G1 lands. |
| 2 | Budget | **Approved as drafted**: USD per project per day, default $2.00; per ghost $0.25; a backend without cost reporting falls back to 150k tokens per ghost. Editable in the project's Ghost settings. |
| 5 (amended) | Signals | **Local signals stay the base** (dirty diff, markers incl. `@ghost`, run follow-ups, red checks). **Added: pull-request comments, in a plan-only mode** — a comment on a PR a cezar task opened (delivered through the github-events spec's poller, after its loop guard) may produce a ghost that runs **without write tools** (`allowedTools` read-only; Bash denied) and ends with a plan, never a diff. Claiming such a ghost starts the real task with that plan as its first message. Untrusted text therefore never executes anything; it only drafts. Issues and tracker bodies remain excluded. |

## 3. Branch

The owner was asked whether to merge `feat/ghost-speculative-tasks` into `brutus` now (spec +
G0), cherry-pick the spec only, or leave the branch until G1's turn. **No answer was recorded
in this session**; the branch stays where it is until the owner says. When it is merged, this
note's §2 is folded into the draft's "Resolved decisions" table and this file is deleted.

## 4. Order of work after the merge

G1 first, with the plan-only comment ghost as its last signal (it depends on the
github-events spec landing); G2; G3. The Ghost view, tray and composer chip follow the draft's
UI section unchanged.
