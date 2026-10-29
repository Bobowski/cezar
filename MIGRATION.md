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

`CEZ_DRY_RUN` defaults to **off**, matching the TypeScript app. Unset, a task
spawns the selected CLI (`claude`, `codex`, `opencode`, `cursor-agent`, `pi`,
`junie`, `copilot`) with that backend's argv and wire format. `CEZ_DRY_RUN=1`
uses the mock agent. Compose sets that. A missing binary fails the run; it
does not fall back to the mock. `CEZ_REAL_AGENTS` is ignored.

Docker:

```bash
docker compose up --build
```

Compose publishes `4321`, stores SQLite in the `cezar-data` volume, and mounts
the repo at `/repo`. It sets `CEZ_DRY_RUN=1` and `STARIO_HOST=0.0.0.0`, so the
process is hosted and requires HTTP Basic auth. `GET /health` stays open for
the healthcheck. `docker compose up --build` was run on this slice: the image built (bash, git,
and the cryptography package for the secret store) and the container became
healthy. An earlier boot (before Basic auth) ran a dry-run task to `review` on
`cez/<id8>` inside the mounted repo. This boot checked the gate: `/health` was
200 with no credentials, `/tasks` and `/api/v1/health` were 401, and the
generated password from the data volume authenticated `/api/v1/health`. Git is invoked with `safe.directory=*` for that process only,
because the container user does not own the mounted checkout and would otherwise
treat it as a non-git directory.

## Decisions

| Question | Choice |
| --- | --- |
| Where does state live? | SQLite. `import-runs` copies a `runs.json` array into that table. Event NDJSON is not imported. Workflows and skills stay files under `.ai/cezar/` so they can still be committed. |
| What does a finished workflow become? | `review`. Finish sets `done`. Neither merges. Headless `run` treats `review` as exit 0. |
| What happens to a `running` row after restart? | It becomes `failed` with "interrupted by restart". The subprocess is gone. `queued` stays queued. `waiting` stays, so the question is still on screen. The TypeScript `recover()` path resumes the session; this does not. |
| Does `waiting` hold a parallelism slot? | No. The agent process has exited. `max_parallel` still defaults to 2 and caps `running` work. |
| Dry run | Default off, matching TypeScript. Compose sets `CEZ_DRY_RUN=1`. |
| Graph workflows (`version: 2`) | Loaded and walked for `start`, `agent`, `check`, `if`, `loop`, `end`, `fork`, `join`, `dispatch`, `git.commit`, `git.push`, `git.sync-base`, `github.draft-pr`, and `github.wait-ci` (no PR fails; dry-run reports green). A cycle that does not pass a loop `repeat` port is rejected. `github.pr-comment`, `github.issue-comment`, and `github.pr-update` are a dry-run note or a failure. |
| `onFail` on an agent step | A load error. TypeScript's schema allows the key and ignores it. |
| Secrets on a check | Injected into the check environment from an AES-256-GCM store under the data directory. Values are not returned by the list API. A `cezar` audience is not given to checks. The check itself is always `bash -lc`. |
| `allowedTools` / `bashAllowlist` | Claude argv maps a non-empty allowlist to `Bash(<prefix>:*)`. Pi drops Bash. Copilot is `--allow-all-tools` and the allowlist is not mapped. A check step always runs `bash -lc`, the same as TypeScript: the allowlist does not gate it. |
| Diff base | The commit the worktree was branched from. Not `resolveTaskDiffBase` (freshest `origin/<base>` versus `<branch>@{start}`). |
| Fetch | Skipped when dry-run is on. Otherwise one best-effort `git fetch` of the base branch. |
| Dispatch | Cap of 4 in-flight children and the budget carve are ported. A settled child stores a report on the parent. It is not pushed into a live parent session. `CEZ_DISPATCH=0` refuses new children. |
| Automations | Interval only, paused until enabled. An enabled row idle longer than its own interval is moved forward at startup and does not fire a backlog. No GitHub, Jira, or Linear triggers. |
| URL shape | `?project=` on workspace pages, not `/p/:projectId/...`. |
| Host guard and login | Loopback `Host` check on `/api`, including health, with the same 403 text as #426. A missing Host is untrusted. `CEZ_REMOTE=1` or a non-loopback bind (compose's `0.0.0.0`) skips it, matching hosted mode, and then requires HTTP Basic auth. `GET /health` stays open for the healthcheck. A loopback bind does not ask for a password. The TypeScript process has no login; its VPS install puts this challenge on nginx. There is no nginx in compose, so the Python process issues it. |
| CSS | Hand-written from the cockpit tokens in `packages/web/src/styles/index.css`. Not DaisyUI. The React screens are not reproduced. |

## Size

Measured with cloc 1.98. TypeScript counts are `packages/**/*.{ts,tsx}`.
Python counts are `app/**/*.py` and `tests/**/*.py`. Vendored `static/js/datastar.js`
is 33,553 bytes and is not application code. The TypeScript tree is still in the repo.

| | files | code lines |
| --- | ---: | ---: |
| TypeScript application (no `*test*` / `*spec*` files) | 807 | 146,242 |
| TypeScript tests | 810 | 157,213 |
| Python application (`app/`) | 77 | 10,554 |
| Python tests, including protocol fakes | 26 | 2,782 |
| Python CSS | 1 | 221 |

The Python application is about 7% of the TypeScript application by code lines.
The HTTP slice covers the run lifecycle plus git actions, receipts, uploads,
UI state, a pipe terminal, a loopback preview proxy, webhook receivers, and
tracker hook intake. Most of `server.ts` is still absent.

## Checks

`uv run ruff check`, `uv run ruff format --check`, `uv run pyright`, and
`uv run pytest -q` were run on this branch. **118 tests passed.**

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
| Import of `.ai/cezar/runs.json` and NDJSON | done | `tests/test_import_runs.py` and `import-runs`. A record's id, task, status, workflow, runner, and timestamps are kept. `runs/<id>.ndjson` beside that file is imported as events. A bad row is skipped. |
| Workflow and skill files remain the authored source | done | `tests/test_workflows.py`, cockpit workflow/skill test |
| Workspace settings: parallel (default 2), runner, theme, accent | done | settings stream test |
| Per-project base branch stored at registration | partial | used by the engine; no editor in the UI |
| Secrets vault | partial | `tests/test_secrets.py` and the check injection test. AES-256-GCM, file key only (no OS keychain), audiences `checks` and `cezar`, project root binding, list API omits values. Stored under `$PROJECT_DATA_DIR/secrets`, not `~/.cezar/secrets`. |
| Agent accounts / profiles | not done | — |
| UI state, attachments, layouts | partial | `tests/test_surface.py`. Project `.ai/cezar/ui-state.json` and `$PROJECT_DATA_DIR/ui-state.json` merge shallowly and cap a write at 200 keys. Uploads store base64 under the data directory (text, images, pdf, octet-stream) and delete by id. No layouts, drafts, or prompt-template editor. |

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
| Version 2 graph workflows | partial | `tests/test_graph.py` walks the spec example, including the loop cap. `tests/test_graph_nodes.py` runs a fork, a dispatch, a commit, a dry-run draft PR, and `github.wait-ci` (failed with no PR, green in a dry run). Comment and update nodes are still a note. A graph still needs an agent or check reachable from start. |
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
| Retention, archive, pin, read/unread | done | `tests/test_finish.py`, `tests/test_surface.py`, `tests/test_graph_nodes.py`. Bulk archive and mark-all-read match the TypeScript rules. Worktree retention keeps the newest finished directories (`CEZ_WORKTREE_RETENTION`, default 10) and leaves the branch. The index keeps the newest 300 runs (`CEZ_RUNS_KEEP`) and never drops a live row. |
| Queued message stack editable before dequeue | done | Edit and delete while `queued`. A message that arrives while `running` is delivered as the next follow-up (`tests/test_graph_nodes.py`). A restart does not keep the text: it records that the message was lost, which is what the TypeScript marker file does (`tests/test_finish.py`). |
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
| Draft PRs, merge, GitHub review | partial | `POST /runs/{id}/pr` and a `github.draft-pr` node. Dry-run returns `https://github.com/open-mercato/demo/pull/777` and does not push or call `gh`. The route then marks the run `done`. No merge and no review thread. |

### Agents

| Item | Status | Verified |
| --- | --- | --- |
| Dry-run mock (`mock:fail`, `mock:ask`, `mock:write`) | done | engine and cockpit tests. Not `scripts/mock-claude.mjs` |
| Claude stream-json session | partial | `tests/test_runners.py` fake binary. Argv matches `buildClaudeArgs`. Stdin is one user message; image blocks lead the text. `.ai/cezar/mcp.json` becomes a `0600` `--mcp-config` plus `mcp__<name>` allow rules. A silent process is killed after 15 minutes (8× that is the hard ceiling). `stream_event` text deltas are live-only. Cancel and the inactivity kill are SIGTERM, then SIGKILL after 4s (`tests/test_runner_gaps.py`). A process that is still alive after the turn is reused for the next follow-up; if it has exited, the next turn is a new process with `--resume`. |
| Codex app-server | partial | fake binary. `thread/start` on the first turn; a stored thread id is `thread/resume` on a later turn (`tests/test_runners.py`). A resume that reports `already has an active writer` is retried, then `thread/fork` (`tests/test_runner_gaps.py`). Stdio MCP servers ride `config` overrides. Not ported: compaction and the rest of the item types. |
| OpenCode serve | partial | fake binary. `opencode serve --hostname 127.0.0.1 --port N`, then `POST /session` and `POST /session/:id/message` with `{parts:[{type:text}]}`. The Python client reads one JSON body. TypeScript reads the SSE part stream while that POST stays open and only surfaces assistant parts. No session resume. |
| Cursor agent | partial | fake binary. Argv is `-p --force --trust --output-format stream-json` and the prompt as the last positional (system prompt prepended). Same stream-json parser as Claude. One shot: the prompt is argv, not a stdin session. |
| pi RPC | partial | fake binary. `pi --mode rpc`, then `{type:get_state}` and `{type:prompt, streamingBehavior:steer}`. `message_update` / `text_delta`, tool start/end, and `agent_settled` ends the turn. `--session` versus `--session-id`. A non-empty bash allowlist drops Bash. Not the rest of the pi event set. |
| Junie ACP | partial | fake binary. `junie --acp=true -p <cwd>`. JSON-RPC `initialize` (protocolVersion 1), `session/new`, `session/prompt`. `session/update` chunks stream; the prompt response completes the turn. `stopReason: refusal` fails it. |
| Copilot ACP | partial | fake binary. `--acp --allow-all-tools --no-auto-update` (`--model` when set). Same ACP frames as Junie. `allowedTools` and `bashAllowlist` are not mapped onto flags, matching TypeScript. |
| Stdin subprocess | partial | `StdinAgent` remains for a test that records a result-frame usage line. The engine does not use it. |
| Missing binary | done | `test_a_missing_backend_fails_the_run_instead_of_spawning` — the run fails with "not found". There is no `CEZ_REAL_AGENTS` gate. |
| Model catalog, provider login, accounts | partial | `--model` is passed for Claude, Cursor, Pi, and Copilot. `GET /providers/status` is `shutil.which`. `GET /models?runner=` lists ids this port knows when the binary is on PATH. No CLI probe, no login, no agent accounts. |
| MCP, images | partial | Claude images and `.ai/cezar/mcp.json` are covered by `tests/test_runners.py`. Staged uploads are a separate store and are not yet handed to the agent as paths. |
| Tool allowlists | partial | see the decisions table. Checked by the argv tests. |
| Skills as extra system prompt, local directories only | partial | engine loads `.ai/cezar/skills`, `.ai/skills`, `.agents/skills`. No global or team repo |

### Automations

| Item | Status | Verified |
| --- | --- | --- |
| Create paused, enable, pause, run now, delete | partial | create/enable/pause/delete handlers exist; the backlog rule is what the test locks |
| Stale schedule does not launch a backlog | done | `test_a_stale_schedule_does_not_launch_a_backlog` |
| Due interval launches one run | done | same test |
| Calendar UI | not done | a list and a form |
| GitHub / Jira / Linear reads | partial | `tests/test_integrations.py`. Unset credentials answer `{available: false}` and do not call out. A recorded local server returns one GitHub issue, one Jira issue, and one Linear issue. Base URLs must be the vendor https host or loopback; private and non-vendor hosts are refused before a request. Inbound hooks are separate: they check a signature and can start a run for an enabled automation with a matching tracker. |

### CLI

| Command | Status | Verified |
| --- | --- | --- |
| `serve` (default) | done | manual `python -m app.main` |
| `run` — `review` is exit 0, failure is exit 1 | done | `tests/test_cli.py` |
| `init` | done | same |
| `projects list` / `add` | done | same |
| `projects remove` | partial | implemented, not covered by a test |
| `import-runs <path>` | partial | `tests/test_import_runs.py`. Keeps id, task, status, workflow, runner, and timestamps. Skips a bad row. Does not import event NDJSON. |
| `task`, `automation`, `runs`, `secrets`, `telemetry` | not done | secrets and telemetry are HTTP and a Secrets page, not CLI subcommands |
| `server-install` / `deploy` / `uninstall` | not done | compose is the deploy path |
| self-update `install` / `update` / `use` / `link` | not done | — |

### HTTP

Project routes are also mounted at `/api/v1/p/default/…` and
`/api/v1/p/<project id>/…`. An unknown project id is 404. The unscoped mount
is the boot project.

| Route | Status | Verified |
| --- | --- | --- |
| `GET /health` | done | cockpit test. Plain `ok`. |
| `GET /api/v1/health` | partial | `tests/test_api.py`. Required discovery keys, CORS `*`, no `root` on `projects[]`. `checks` is `shutil.which` with no version string. `forge` is null (health does not shell out to `gh`). The health document still reports `terminal` and `designMode` as false; the routes exist beside that document. `disk` and `instanceId` are absent. |
| `GET /api/v1/runs` | partial | JSON array of records. `workflowDef` omitted unless `full=1`. No live `usage` sample. |
| `POST /api/v1/runs` | partial | 201 stored record, or `{runs}` for `variants` 2 or 3 (letters A/B/C, one `groupId`). Inline steps run as `(planned)`. Image attachments are stored and sent to Claude. An attachment-only task is stored as `(see attachments)`. |
| `GET /api/v1/runs/{id}` | partial | Required record keys (`id`, `title`, `workflow`, `task`, `status`, `createdAt`, `tokensUsed`, `archived`, `steps`). |
| `GET /api/v1/runs/{id}/events` | partial | `text/event-stream`. Replay then a live tail. Dotted types are `ui-event`; everything else is `run-event`; the record is `run`. `item.delta` is live-only and coalesced at about 40 ms (`tests/test_runner_gaps.py`). A delta-only turn persists one `item.completed`. `plan.updated` is persisted for Claude `TodoWrite` and Codex `turn/plan/updated`. Also persisted: `item.started`, `turn.completed`, and `usage.updated` when a turn reports tokens. `permission.*` is not emitted: TypeScript reserves those events until an approval channel exists, and this port has none. `item.updated` is not emitted. `afterSeq` and `Last-Event-ID` skip older rows. |
| `POST /api/v1/runs/{id}/cancel` | partial | 200 `{cancelled: true\|false}`. A settled run is false. 404 unknown. |
| `POST /api/v1/runs/{id}/finish` | partial | 200 from `review` (accept), from `waiting` (the ask is abandoned), and from `running` (the step is stopped and the run becomes `done`). A settled run is 409 `no open session`. It does not land an in-place branch. |
| `DELETE /api/v1/runs/{id}` | done | 200 `{deleted: true}`. 409 while queued, running, or waiting. 404 unknown. |
| `POST /api/v1/runs/{id}/messages` | partial | `{queued, message}` while the run is still `queued`; the stack is composed into the prompt and not written back onto `task`. `{delivered: true}` for `waiting` and `review`. `{deferred: true}` while `running`. Attachments on a message are still not accepted on this route; staged uploads are `POST /workspace/uploads`. |
| `POST /api/v1/runs/{id}/archive`, `POST …/pin`, `POST /runs/archive-finished`, `POST /runs/read-all`, `POST …/read`, `POST …/unread` | partial | Archive and pin flags. Archiving clears a pin and cancels queued, running, or waiting work. The bulk sweep and read receipts match the TypeScript rules and are tested. |
| `PATCH/DELETE …/queued-messages/{msgId}` | partial | Edit or remove a stacked message while the run is still queued. 409 `run already started` after that. |
| `DELETE /api/v1/runs/{id}/auto-resume` | partial | 200 `{cancelled: true}` because nothing schedules a resume. 404 unknown. |
| `GET /api/v1/workflows` | partial | `{workflows, issues}`. |
| `GET /api/v1/projects` | partial | `id`, `name`, `root`, `addedAt`, `lastOpenedAt`, `source: local`, `status`, `branch` when it is a git checkout. No forge, tags, or `maxParallel`. `projectsDir` is the Python data directory, not the TypeScript checkouts directory. |
| Loopback `Host` guard on `/api` | done | `tests/test_api.py`. Foreign Host is 403, including health. `CEZ_REMOTE=1` skips it. |
| Hosted Basic auth | partial | `tests/test_api.py`. Required when hosted. `GET /health` is open. A missing `CEZ_AUTH_PASSWORD` is generated into the data directory at mode 0600. This is the nginx `auth_basic` challenge from the VPS install, enforced in-process because compose has no proxy. No session cookie and no Settings user store. |
| `GET/POST /runs/{id}/git/status`, `commit`, `push`, `GET …/diff`, `POST …/pr` | partial | `tests/test_surface.py`. Commit uses the repo identity, or `cezar <cezar@localhost>` when `user.name` is unset. Push and draft PR do not leave the machine when `CEZ_DRY_RUN=1`. |
| `GET/PUT /ui-state`, `GET/PUT /workspace/ui-state` | partial | shallow merge, 200-key cap, unknown keys kept. `tests/test_surface.py`. |
| `POST/DELETE /workspace/uploads` | done | Staged bytes. A run that names `uploadId` writes the file into the worktree and puts the path in the agent prompt (`tests/test_finish.py`). |
| `GET /api/v1/fs/browse` | done | Directories only, inside `CEZ_BROWSE_ROOT` (default the home directory), after `realpath`. A symlink out of the root is not listed. `tests/test_finish.py`. |
| `GET /providers/status`, `GET /models` | partial | binary presence and a static id list. |
| `POST /preview/design-proxy` | partial | Refuses non-loopback and hosted/`CEZ_DESIGN_MODE=0`. A loopback `http://` target is mirrored on `127.0.0.1` with `<!-- cezar-design -->` injected before `</body>`. `tests/test_surface.py`. |
| `POST /runs/{id}/terminal`, input, resize, output, close | done | Interactive bash on a PTY. `POST …/resize` sets `TIOCSWINSZ` and sends `SIGWINCH`. Output is SSE. `tests/test_finish.py` reads the size back from the tty. |
| `GET/POST/DELETE /webhooks`, `POST …/test`, `GET …/deliveries` | partial | Receiver URL must be public https or loopback http. Dry-run test delivery is recorded as 204 and does not open a socket. Signing key is `whsec_`. Not the TypeScript outbox, ownership lock, or Slack renderer. |
| `POST /hooks/github`, `/hooks/jira`, `/hooks/linear`, `GET /hooks/receipts` | partial | GitHub checks `X-Hub-Signature-256` against `CEZ_GITHUB_WEBHOOK_SECRET`. Jira and Linear check `X-Cezar-Webhook-Secret`. Unset or wrong is 401. A matching enabled automation can enqueue a run. Receipts are appended locally. |
| GitHub review and merge, skills update, workspace branding, launch key, plan, deferred-start scheduling | not done | — |
| Star count, self-update | intentionally not ported | They phone home or rewrite the install. |

The Python cockpit does not use `/p/:projectId`. The same screen is a top-level
path. `tests/test_finish.py` loads the pages below that say they were checked
there.

### Screens

React routes from `packages/web/src/routes.tsx` and `routes/settings/registry.tsx`.
A row is `done` when the page renders its data and the primary action is tested.
It is not a pixel copy of the React component.

| React route | Python | Status | Verified |
| --- | --- | --- | --- |
| `/p/:projectId` tasks overview | `/tasks` | done | list, filter, new task, archive, mark read. `tests/test_cockpit.py`, `tests/test_finish.py` |
| `/p/:projectId/new` | `/tasks/new` | done | creates a run. Cockpit test |
| `/tasks` global index | `/tasks` | done | one list for the boot project. There is no second workspace index |
| `/p/:projectId/tasks/:id` session | `/tasks/{id}?pane=session` | done | transcript, finish, cancel, delete |
| `…/changes` | `?pane=diff` | done | diff text |
| `…/files` | `?pane=files` | done | worktree file list, including a staged upload |
| `…/commits` | `?pane=commits` | done | `git log --oneline` |
| `…/graph` | `?pane=graph` | done | graph nodes, or the step list |
| `…/notes` | `?pane=notes` | done | notes save on the run |
| `…/terminal` | `?pane=terminal` | done | PTY command |
| `…/browser` | `?pane=browser` | done | states the loopback design-mode rule |
| `…/compare` | `/tasks/{id}/compare` | done | variant rows that share a `groupId` |
| `/p/:projectId/git` changes, commits, branches, files | `/git` | done | recent commits on the repo |
| `/p/:projectId/github` issues and PRs | `/github` | done | open issues when `?owner=&repo=` is set; otherwise the unavailable state |
| `/p/:projectId/tracker` | `/tracker` | done | says a lookup needs credentials. The HTTP reads are tested separately |
| `/p/:projectId/automations` new, edit, log | `/automations` | done | create paused, enable, pause, run now, delete. The form is on the list |
| `/p/:projectId/skills` | `/skills` | done | list and create. Cockpit test |
| `/p/:projectId/workflows` and `/workflows/:name` | `/workflows`, `/workflows/{name}` | done | catalog list and one workflow's nodes |
| `/p/:projectId/inbox` | `/inbox` | done | unread finished runs and Mark read |
| `/p/:projectId/settings` and appearance, resources | `/settings` | done | parallel, runner, theme, accent |
| settings `secrets`, `workspace-secrets` | `/secrets` | done | names only; the value is not echoed |
| settings `privacy` | `/settings/privacy` | done | says telemetry is intentionally not ported |
| settings `agents` | `/settings/agents` | done | which CLIs are on PATH |
| settings `webhooks` | `/settings/webhooks` | done | receiver names |
| settings `worktrees` | `/settings/worktrees` | done | the retention cap |
| `/dashboard` | `/dashboard` | done | counts. The mock reports no token chart |
| `/projects` and settings `projects` | `/projects` | done | add, including refusing `$HOME` |
| unknown path | — | done | 404 |
| settings `tracker`, `integrations`, `instructions`, `tasks`, `agent-config`, `bookmarklets`, `notifications`, `keyboard`, `skills`, `global-instructions`, `accounts` | — | not done | no editor for those files |
| GitHub review and merge UI | — | not done | — |
| Light / violet tokens, phone layout | the same CSS | partial | tokens exist. Not compared in a phone browser |

### Background work and integrations

| Item | Status | Verified |
| --- | --- | --- |
| Scheduler loop | done | engine parallel test and the live server |
| Automation ticker | done | engine test |
| Telemetry | intentionally not ported | This fork does not send telemetry. The consent routes, if called, do not open a network request. |
| Star count, self-update, skills auto-update | intentionally not ported | They would phone home or change the install. This fork leaves them out. |
| Desktop shell | intentionally not ported | Owner decision: the Tauri shell stays out of this port. |
| `gh` issues and draft PRs | partial | open issues are read when `CEZ_GITHUB_TOKEN` is set. A draft PR is the dry-run URL unless dry-run is off, in which case the port runs `gh pr create --draft` after a push. |
| Webhooks | partial | receivers, signed test deliveries, and inbound GitHub/Jira/Linear hooks with receipts. Not the full coordinator. |

## What is still TypeScript

`packages/`, the React cockpit, and the CLI in `packages/cezar/src/index.ts`
stay. The Python runners speak the same wire formats against fake binaries;
the TypeScript runners are still the reference for everything the partial rows
above name (live session, v2 events, MCP, images, watchdog). Deleting the
TypeScript tree would drop the product.

## Risks

- Calling this parity would be false. The cockpit, the HTTP contract, GitHub,
  and the trackers are still mostly absent. The runners are protocol-tested
  against fakes, not against the real CLIs.
- Unset `CEZ_DRY_RUN` spawns whatever binary is on `PATH` for the selected
  runner, with that runner's flags, and does not ask before tools. Compose
  keeps the mock on.
- Compose binds `0.0.0.0`, so it is hosted mode: HTTP Basic auth, not the
  loopback Host check. `GET /health` is unauthenticated on purpose. A loopback
  `cezar serve` is still an open local port, matching the TypeScript app.
  `same_origin()` blocks cross-site mutations and is not a substitute for the
  password.
- One process owns the SQLite file. A second `run` or `projects` command exits
  if the cockpit holds the claim.
- A check step is `bash -lc` in the worktree, including when the step names
  a `bashAllowlist`. That list is applied to the agent argv only. Secrets
  with the `checks` audience are injected and redacted from the transcript
  when they are at least 12 characters.
- A follow-up reuses a Claude or Pi process that is still alive. If that
  process has exited, the next turn is a new process with `--resume` (Claude,
  Pi) or Codex `thread/resume`. A Codex resume that still holds the writer
  lock is retried, then `thread/fork`. If the CLI did not persist the session,
  resume fails.
- Dry-run push and draft PR do not call the network. A real `gh pr create`
  runs only when `CEZ_DRY_RUN` is off.
- Telemetry, self-update, and the star count are intentionally not ported.
  Nothing in this fork posts to those upstream endpoints.
- The design-mode proxy listens on `127.0.0.1` and only fetches a loopback
  `http://` URL. Hosted mode leaves it off.
- The terminal is a pipe to `bash -s`, not a PTY.
- Worktrees are created inside the project repo. Finish does not merge and does
  not push. Cleaning them up is manual except for delete and orphan prune.
- The diff anchor is the fork commit recorded at start, so a base branch that
  moves during the run is not re-attributed.
