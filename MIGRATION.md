# Python port

This fork keeps the TypeScript cockpit and adds a Python one beside it:
[Stario](https://github.com/Bobowski/stario) for HTTP, [Datastar](https://data-star.dev)
for the live page, SQLite through [litewriter](https://github.com/Bobowski/litewriter).
Layout and commands follow [stario-create](https://github.com/Bobowski/stario-create)
(`app/features/<page>/`, `just check`, `PROJECT_DATA_DIR`).

The TypeScript tree is still the full product. The Python tree is a slice of it.
Nothing below is marked done unless a test or a manual run exercised it.

## Run it

```bash
uv sync
CEZ_DRY_RUN=1 uv run python -m app.main
```

The cockpit listens on `127.0.0.1:4321` (Stario's own default is 8000).
State goes to `./data/app.sqlite3`, or `$PROJECT_DATA_DIR` (Yard uses `/data`).

```bash
uv run python -m app.cli run "describe the change"    # review exits 0
uv run python -m app.cli init
uv run python -m app.cli projects
just check    # ruff, ruff format, pyright, pytest
```

`CEZ_DRY_RUN` defaults to **on** here. Unset, a task uses the mock agent.
`CEZ_DRY_RUN=0` without `CEZ_REAL_AGENTS=1` fails the run on purpose.
`CEZ_REAL_AGENTS=1` starts the named binary with the prompt on stdin and no
protocol flags. That is not Claude, Codex, OpenCode, Cursor, pi, Junie, or
Copilot session parity.

Docker:

```bash
docker compose up --build
```

Compose publishes `4321`, stores SQLite in the `cezar-data` volume, and mounts
the repo at `/repo`. It sets `CEZ_DRY_RUN=1`. `docker compose up --build` was
run here: the image built, the container became healthy, and a dry-run task
reached `review` on `cez/<id8>` inside the mounted repo. Git is invoked with
`safe.directory=*` for that process only, because the container user does not
own the mounted checkout and would otherwise treat it as a non-git directory.

## Decisions

| Question | Choice |
| --- | --- |
| Where does state live? | SQLite. The TypeScript app's `runs.json` / NDJSON files are not imported. Workflows and skills stay files under `.ai/cezar/` so they can still be committed. |
| What does a finished workflow become? | `review`. Finish sets `done`. Neither merges. Headless `run` treats `review` as exit 0. |
| What happens to a `running` row after restart? | It becomes `failed` with "interrupted by restart". The subprocess is gone. `queued` stays queued. `waiting` stays, so the question is still on screen. The TypeScript `recover()` path resumes the session; this does not. |
| Does `waiting` hold a parallelism slot? | No. The agent process has exited. `max_parallel` still defaults to 2 and caps `running` work. |
| Dry run | Default on, unlike TypeScript, because the real CLI protocols are not ported. |
| Graph workflows (`version: 2`) | Refused at load with an error. They are not lowered into steps. |
| `onFail` on an agent step | A load error. TypeScript's schema allows the key and ignores it. |
| Secrets on a check | The check does not run. There is no vault. |
| `allowedTools` / `bashAllowlist` | Accepted on load, not enforced. A note is written when a bash allowlist is present. |
| Diff base | The commit the worktree was branched from. Not `resolveTaskDiffBase` (freshest `origin/<base>` versus `<branch>@{start}`). |
| Fetch | Skipped when dry-run is on. Otherwise one best-effort `git fetch` of the base branch. |
| Dispatch | Cap of 4 in-flight children and the budget carve are ported. A settled child stores a report on the parent. It is not pushed into a live parent session. `CEZ_DISPATCH=0` refuses new children. |
| Automations | Interval only, paused until enabled. An enabled row idle longer than its own interval is moved forward at startup and does not fire a backlog. No GitHub, Jira, or Linear triggers. |
| URL shape | `?project=` on workspace pages, not `/p/:projectId/...`. |
| Host guard | `same_origin()` on mutating requests. The TypeScript loopback `Host` check is not copied, so a container can be opened by its published host. There is no login. |
| CSS | Hand-written from the cockpit tokens in `packages/web/src/styles/index.css`. Not DaisyUI. The React screens are not reproduced. |

## Size

Measured with cloc 1.98. TypeScript counts are `packages/**/*.{ts,tsx}`.
Python counts are `app/**/*.py` and `tests/**/*.py`. Vendored `static/js/datastar.js`
is 33,553 bytes and is not application code. The TypeScript tree is still in the repo.

| | files | code lines |
| --- | ---: | ---: |
| TypeScript application (no `*test*` / `*spec*` files) | 807 | 146,242 |
| TypeScript tests | 810 | 157,213 |
| Python application (`app/`) | 47 | 4,763 |
| Python tests | 6 | 976 |
| Python CSS | 1 | 221 |

The Python application is about 3% of the TypeScript application by code lines.
That matches the checklist: a working core, not a port of the cockpit.

## Checks

`uv run ruff check`, `uv run ruff format --check`, `uv run pyright`, and
`uv run pytest -q` were run on this branch. **53 tests passed.**

A manual `CEZ_DRY_RUN=1 uv run python -m app.main` answered `/health`,
`POST /api/v1/runs` returned 201, and the run reached `review` with a worktree
on `cez/<id8>`. Headless Chrome screenshots of `/tasks` and the task page showed
the dark shell, the lime "New task" button, the review row, and the transcript.
Clicking Finish in the browser was not repeated; the button is in the HTML and
`POST` finish is covered by pytest (it does not create a merge commit).

## Checklist

Status is `done`, `partial`, or `not done`. "Verified" is the check that was
actually run, not a claim that the TypeScript behavior matches line for line.

### Persistence and model

| Item | Status | Verified |
| --- | --- | --- |
| SQLite for projects, runs, events, settings, automations | done | `tests/test_engine.py`, `tests/test_cockpit.py` |
| Import of `.ai/cezar/runs.json` and NDJSON | not done | — |
| Workflow and skill files remain the authored source | done | `tests/test_workflows.py`, cockpit workflow/skill test |
| Workspace settings: parallel (default 2), runner, theme, accent | done | settings stream test |
| Per-project base branch stored at registration | partial | used by the engine; no editor in the UI |
| Secrets vault | not done | a check that names secrets fails closed (`test_engine`) |
| Agent accounts / profiles | not done | — |
| UI state, attachments, layouts | not done | — |

### Workflows

| Item | Status | Verified |
| --- | --- | --- |
| `steps` XOR `skills` | done | `tests/test_workflows.py` |
| Agent step XOR check step | done | same |
| `onFail.retry` must name an earlier step; `max` defaults to 2 | done | same |
| `retryOn` rejects 0; empty list retries any failure | done | parser test and engine test |
| `{{task}}` substitution | done | chain-step engine test |
| Chain note when there are 2+ agent steps; `CEZ:DONE` does not skip | done | `test_cez_done_does_not_skip_the_next_agent_step` |
| Built-in `quick-task`; a valid file overrides it; a bad file does not | done | `tests/test_workflows.py` |
| Queued file snapshot is not replaced by the built-in when the file disappears | done | `test_a_deleted_file_does_not_replace_a_queued_snapshot_with_the_builtin` |
| Version 2 graph workflows | not done | load returns an error; not executed |
| Node editor, loops, gates, PR and CI nodes | not done | — |
| `init` example `fix-and-verify.yaml` and `project-conventions.md`, never overwrite | done | `tests/test_cli.py` |
| `.ai/cezar/.gitignore` entry list | done | `test_gitignore_appends_missing_entries_and_keeps_user_lines` |

### Runs

| Item | Status | Verified |
| --- | --- | --- |
| Queue, `max_parallel` (default 2) | done | `test_only_one_run_occupies_a_slot_when_max_parallel_is_one` |
| Statuses `queued` `running` `waiting` `review` `done` `failed` `cancelled` | done | engine and cockpit tests |
| Success stops at `review`; finish does not merge | done | `test_success_stops_at_review_and_finish_does_not_merge`, cockpit test |
| `CEZ:ASK` parks in `waiting`; an answer continues | done | engine test and cockpit test |
| Follow-up from `review` is one more agent turn | partial | `Engine.deliver`; not asserted as a full resume of the TypeScript session |
| Cancel, including killing a check | done | `test_cancel_stops_a_check_without_waiting_for_it`, API cancel test |
| Restart marks `running` failed and leaves `queued` | done | `test_a_restart_fails_a_running_agent_and_leaves_the_queue` |
| Resume of a live CLI session after restart | not done | — |
| Monitoring / autonomous nudge loop | not done | autonomous only adds a system-prompt line |
| Usage-limit auto-resume | not done | — |
| Variants (×2 / ×3) and compare | not done | — |
| Retention, archive, pin, read/unread | not done | delete removes a settled run and its `cez/` worktree |
| Queued message stack editable before dequeue | not done | — |
| Child dispatch cap 4, budget carve, settle report | done | `tests/test_dispatch.py`, `test_dispatch_caps_children_and_reports_when_one_settles` |
| Report injected into the parent's live session | not done | the report is stored and prepended on a later prompt |
| `cez task` CLI inside the worktree | not done | — |
| In-place / trunk landing | partial | a non-git directory runs in place; no auto-land |

### Git

| Item | Status | Verified |
| --- | --- | --- |
| Worktree per task at `.ai/cezar/worktrees/<id>`, branch `cez/<id8>` | done | engine success test, manual run |
| Option-like refs refused before git sees them | done | `test_option_like_refs_are_refused`, bad-base test |
| A failed worktree create does not run in the main tree | done | `test_a_bad_base_does_not_run_in_the_main_tree` |
| Diff includes untracked files and is capped | partial | untracked file asserted; cap helper exists, cap edge not separately tested |
| Freshest `origin/<base>` vs fork-point attribution | not done | fork SHA only |
| Remotes via `gh repo set-default` / fork parent | not done | — |
| Branch naming instructions | not done | — |
| Orphan worktree directories whose run id is gone | done | `test_orphan_worktrees_go_and_known_runs_stay` |
| Draft PRs, merge, GitHub review | not done | — |

### Agents

| Item | Status | Verified |
| --- | --- | --- |
| Dry-run mock (`mock:fail`, `mock:ask`, `mock:write`) | done | engine and cockpit tests. Not `scripts/mock-claude.mjs` |
| Claude stream-json session | not done | — |
| Codex app-server | not done | — |
| OpenCode serve | not done | — |
| Cursor agent | not done | — |
| pi RPC | not done | — |
| Junie ACP | not done | — |
| Copilot ACP | not done | — |
| Experimental stdin subprocess | partial | `test_experimental_stdin_runner_records_usage` with a fake binary |
| Refuse to spawn when dry-run is off and real agents are off | done | `test_a_missing_backend_fails_the_run_instead_of_spawning` |
| Model catalog, provider login, accounts | not done | a model string is stored and ignored by the mock |
| MCP, images, tool allowlists | not done | — |
| Skills as extra system prompt, local directories only | partial | engine loads `.ai/cezar/skills`, `.ai/skills`, `.agents/skills`. No global or team repo |

### Automations

| Item | Status | Verified |
| --- | --- | --- |
| Create paused, enable, pause, run now, delete | partial | create/enable/pause/delete handlers exist; the backlog rule is what the test locks |
| Stale schedule does not launch a backlog | done | `test_a_stale_schedule_does_not_launch_a_backlog` |
| Due interval launches one run | done | same test |
| Calendar UI | not done | a list and a form |
| GitHub / Jira / Linear triggers, receipts, webhook ingress | not done | — |

### CLI

| Command | Status | Verified |
| --- | --- | --- |
| `serve` (default) | done | manual `python -m app.main` |
| `run` — `review` is exit 0, failure is exit 1 | done | `tests/test_cli.py` |
| `init` | done | same |
| `projects list` / `add` | done | same |
| `projects remove` | partial | implemented, not covered by a test |
| `task`, `automation`, `runs`, `secrets`, `telemetry` | not done | — |
| `server-install` / `deploy` / `uninstall` | not done | compose is the deploy path, and it was not booted |
| self-update `install` / `update` / `use` / `link` | not done | — |

### HTTP

The Python process does not implement the TypeScript `/api/v1` contract.
These routes exist and are not a compatible subset of field names beyond the
ones the tests read:

| Route | Status | Verified |
| --- | --- | --- |
| `GET /health`, `GET /api/v1/health` | done | cockpit test and manual curl |
| `GET/POST /api/v1/runs`, `GET /api/v1/runs/{id}`, events, cancel, finish | done | cockpit tests |
| `GET /api/v1/workflows`, `GET /api/v1/projects` | partial | handlers exist; not asserted field-by-field |
| Everything else in `packages/cezar/src/server/server.ts` (git, GitHub, terminal, fs, webhooks, trackers, providers, models, skills update, star count, preview, self-update, workspace branding, uploads, UI state, launch key, plan, deferred start, WebSocket) | not done | — |

HTML routes that are live (Datastar SSE, not the old NDJSON event stream):
`/tasks`, `/tasks/new`, `/tasks/{id}`, `/workflows`, `/skills`, `/automations`,
`/dashboard`, `/projects`, `/settings`.

### Screens

| Screen | Status | Verified |
| --- | --- | --- |
| Task list with status filter | partial | pytest plus a headless Chrome screenshot. Not the TypeScript overview |
| New task | partial | pytest. Workflow, runner, model, autonomous |
| Task session transcript | partial | pytest and screenshot |
| Changes | partial | plain diff text, not the review UI |
| Finish / Cancel / Delete | done | buttons rendered; finish and cancel tested. Browser click not repeated |
| Files, commits, graph, notes, browser, terminal, preview | not done | — |
| Workflow list and two templates | partial | file round-trip test. No graph editor |
| Skills list and create | partial | cockpit test |
| Automations list | partial | page exists. Schedule logic tested in the engine |
| Dashboard counts and token/cost sums | partial | page render. The mock reports no usage. No charts |
| Projects add / remove | partial | add tested, including refusing `$HOME` |
| Settings: parallel, runner, theme, accent | done | stream test. Not the rest of Settings |
| Inbox, GitHub, tracker, usage windows, design mode | not done | — |
| Light / violet theme tokens | partial | the HTML class and `data-accent` update. Not compared pixel-for-pixel |
| Phone layout | partial | a CSS breakpoint only. Not checked in a phone browser |

### Background work and integrations

| Item | Status | Verified |
| --- | --- | --- |
| Scheduler loop | done | engine parallel test and the live server |
| Automation ticker | done | engine test |
| Telemetry | not done | nothing is sent. There is no opt-in client |
| Star count, skills auto-update | not done | — |
| Desktop shell | not done | — |
| `gh` issues and draft PRs | not done | — |
| Webhooks | not done | — |

## What is still TypeScript

`packages/`, the React cockpit, the CLI in `packages/cezar/src/index.ts`, and
the agent runners stay. They are the behavior this port does not cover.
Deleting them would drop the product.

## Risks

- Calling this parity would be false. Most of the cockpit, every real agent
  protocol, GitHub, and the trackers are absent.
- `CEZ_REAL_AGENTS=1` can start whatever binary is on `PATH`. It does not speak
  that CLI's protocol and it does not ask before tools. Leave it off.
- The server has no login. Compose publishes port 4321. `same_origin()` blocks
  cross-site mutations; it is not an access control.
- One process owns the SQLite file. A second `run` or `projects` command exits
  if the cockpit holds the claim.
- A check step is `sh -c` in the worktree, same trust model as a workflow the
  user wrote, with no secret injection and no `bashAllowlist`.
- Dry-run is the default. People coming from the TypeScript app will not hit
  their logged-in agent unless they opt in, and opting in is not the real runner.
- Worktrees are created inside the project repo. Finish does not merge and does
  not push. Cleaning them up is manual except for delete and orphan prune.
- The diff anchor is the fork commit recorded at start, so a base branch that
  moves during the run is not re-attributed.
