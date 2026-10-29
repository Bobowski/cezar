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
| Where does state live? | SQLite. `import-runs` copies a `runs.json` array into that table and, when a sibling `runs/<id>.ndjson` exists, copies those events too. The parser and `events_near` are tested. The CLI's write into SQLite is not. Workflows and skills stay files under `.ai/cezar/` so they can still be committed. |
| What does a finished workflow become? | `done`, unless `CEZ_REVIEW_GATE=1` (or `reviewGate: true` in `.ai/cezar/config.json`) and the worktree has a diff and the run is not autonomous. Then it parks at `review`. Finish accepts that park and does not merge. Headless `run` treats both `review` and `done` as exit 0. |
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
| TypeScript application (no `*test*` / `*spec*` files) | 800 | 145,968 |
| TypeScript tests | 817 | 157,487 |
| Python application (`app/`) | 90 | 12,330 |
| Python tests, including protocol fakes and `e2e/` | 29 | 3,523 |
| Python CSS | 1 | 221 |

The Python application is about 8% of the TypeScript application by code lines.
The HTTP slice covers the run lifecycle plus git actions, receipts, uploads,
UI state, a pipe terminal, a loopback preview proxy, webhook receivers, and
tracker hook intake. Most of `server.ts` is still absent.

## Checks

`uv run ruff check`, `uv run ruff format --check`, `uv run pyright`, and
`uv run pytest -q` were run on this branch. **138 tests passed.**
`uv run --group e2e pytest e2e -q` passed two Chromium walks: New task → done, and review → commit → push → fake-`gh` draft PR, then the instructions editor.

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
| Import of `.ai/cezar/runs.json` and NDJSON | partial | `tests/test_import_runs.py` keeps id, task, status, workflow, runner, and timestamps, skips a bad row, and reads `runs/<id>.ndjson` through `events_near`. The `import-runs` command writes those events into SQLite; that command is not called by a test. |
| Workflow and skill files remain the authored source | done | `tests/test_workflows.py`, cockpit workflow/skill test |
| Workspace settings: parallel (default 2), runner, theme, accent | done | settings stream test |
| Per-project base branch stored at registration | done | The project card and Settings → Tasks save it through `Engine.set_base_branch`. A task started after that forks from the saved branch (`tests/test_screens.py`). |
| Secrets vault | done | `tests/test_secrets.py` and the check injection test. AES-256-GCM, audiences `checks` and `cezar`, project root binding, list API omits values. Stored under `$PROJECT_DATA_DIR/secrets`, not `~/.cezar/secrets`. The data key is the keychain row. |
| Agent accounts / profiles | done | `/settings/accounts` stores `{id, name, runner, home}` in `$PROJECT_DATA_DIR/agent-accounts.json`. Claude gets `CLAUDE_CONFIG_DIR` and Codex gets `CODEX_HOME`; OpenCode, Cursor, pi, Junie, and Copilot stay on the default login. A turn whose run names the account is spawned with that home (`tests/test_agent_env.py`). `POST /runs` accepts `accountId`. Hosted mode is the `CEZ_REMOTE_AGENT_ACCOUNTS` row. |
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
| Node editor | not done | Loops, fork, dispatch, git, draft PR, and dry-run wait-ci are walked. See the graph row. There is no node editor. |
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
| Worktree and index retention | partial | `select_reclaimable` and `select_index_prune` in `tests/test_finish.py`. Newest finished directories, keep 0 means unlimited, live rows stay. `Engine.retain()` is not called by a test, so directory removal and index deletion are not exercised. |
| Archive, pin, read/unread | done | `tests/test_surface.py` and `tests/test_graph_nodes.py`. Bulk archive and mark-all-read match the TypeScript rules. |
| Queued message stack editable before dequeue | partial | `queue_message` is folded into the prompt and not written back onto `task` (`tests/test_engine.py`). Edit and delete of a stacked message are implemented and not called by a test. A message that arrives while `running` is delivered as the next follow-up (`tests/test_graph_nodes.py`). A restart does not keep the text: the marker helper records that it was lost (`tests/test_finish.py`). That helper is not driven by a second `Engine.startup`. |
| Child dispatch cap 4, budget carve, settle report | done | `tests/test_dispatch.py`, `test_dispatch_caps_children_and_reports_when_one_settles` |
| Report injected into the parent's live session | not done | the report is stored and prepended on a later prompt |
| `cez task` CLI inside the worktree | not done | — |
| Variants (×2 / ×3) and compare | done | The new-task form posts `variants` 2 and 3 and lands on `/tasks/{id}/compare`, which renders A/B and A/B/C (`tests/test_screens.py`). `POST /api/v1/runs` still returns `{runs}` (`tests/test_api.py`). |
| In-place / trunk landing | partial | a non-git directory runs in place; no auto-land |

### Git

| Item | Status | Verified |
| --- | --- | --- |
| Worktree per task at `.ai/cezar/worktrees/<id>`, branch `cez/<id8>` | done | engine success test, manual run |
| Option-like refs refused before git sees them | done | `test_option_like_refs_are_refused`, bad-base test |
| A failed worktree create does not run in the main tree | done | `test_a_bad_base_does_not_run_in_the_main_tree` |
| Diff includes untracked files and is capped | done | untracked file asserted; a body over the cap is truncated (`tests/test_git_base.py`) |
| Freshest `origin/<base>` vs fork-point attribution | done | `resolve_task_diff_base` in `app/engine/git_diff_base.py`. A stale local `main` measures against `origin/main`. A repointed HEAD uses the branch reflog at `started_at` unless the merge-base attributes fewer lines. No start time stays at `HEAD`. The task diff, the review-gate diff, and `GET /runs/{id}/diff` go through it (`tests/test_git_base.py`). |
| Remotes via `gh repo set-default` / fork parent | done | `resolve_task_remotes` in `app/engine/git_remotes.py`. `gh-resolved=base` wins, else a remote GitHub reports as `origin`'s fork parent, else `origin`. Push follows `remote.pushDefault`. The parent lookup is skipped under `CEZ_DRY_RUN=1` and for non-GitHub hosts. A fake `gh` is the only process spawned (`tests/test_git_base.py`). Fork and push use that remote. |
| Branch naming instructions | done | Dry-run naming stays off unless `CEZ_AUTONAME=1`, then the canned mock answer `feature/implementing-cr-fixes` is the branch and the title is `implementing cr fixes`. `CEZ_AUTONAME=0` keeps `cez/<id8>`. A live run asks the Claude binary with the same prompt and keeps the default when the answer is junk. `tests/test_engine.py`. |
| Orphan worktree directories whose run id is gone | done | `test_orphan_worktrees_go_and_known_runs_stay` |
| Draft PRs, merge, GitHub review | done | `POST /runs/{id}/pr` returns the dry-run URL and does not push. The task page merge box includes a review form (`#review-form`, Send review) that posts `comment`, `approve`, or `request-changes`. `expectedHeadSha` must match the head or the merge is 409 `head_moved` (`tests/test_surface.py`, `tests/test_stream_d_close.py`). |

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
| MCP, images | partial | Claude images and `.ai/cezar/mcp.json` are covered by `tests/test_runners.py`. A staged upload is written into the worktree (`tests/test_finish.py`). The engine appends `The user attached:` to the prompt; no test asserts that line. |
| Tool allowlists | partial | see the decisions table. Checked by the argv tests. |
| Skills as extra system prompt, local directories only | partial | engine loads `.ai/cezar/skills`, `.ai/skills`, `.agents/skills`. No global or team repo |

### Automations

| Item | Status | Verified |
| --- | --- | --- |
| Create paused, enable, pause, run now, delete | done | The automations page posts create, enable, pause, run now, and delete (`tests/test_screens.py`). The backlog rule stays `test_a_stale_schedule_does_not_launch_a_backlog`. |
| Stale schedule does not launch a backlog | done | `test_a_stale_schedule_does_not_launch_a_backlog` |
| Due interval launches one run | done | same test |
| Calendar UI | done | `/automations` renders a month grid. A new automation's name is in the cell for its `next_at` day (`tests/test_screens.py`). |
| GitHub / Jira / Linear reads | done | Unset credentials answer `{available: false}` and do not call out. A recorded server returns one GitHub issue, one Jira issue, one Linear issue, a Jira search hit, and a Linear search hit. `GET /github` returns the dry-run catalog (issues plus a draft PR). Base URLs must be the vendor https host or loopback (`tests/test_integrations.py`, `tests/test_stream_d_close.py`). |

### CLI

| Command | Status | Verified |
| --- | --- | --- |
| `serve` (default) | partial | `python -m app.main` was booted by hand and by compose. No test calls `python -m app.cli serve`. |
| `run` — `review` is exit 0, failure is exit 1 | done | `tests/test_cli.py` |
| `init` | done | same |
| `projects list` / `add` | done | same |
| `projects remove` | partial | implemented, not covered by a test |
| `import-runs <path>` | partial | The command copies records and `events_near` rows into SQLite. `tests/test_import_runs.py` covers the parser and the NDJSON helper, not this command. |
| `task`, `automation`, `runs`, `secrets`, `telemetry` | not done | secrets and telemetry are HTTP and a Secrets page, not CLI subcommands |
| `versions`, `unlink` | intentionally not ported | Same family as self-update. This fork does not rewrite its install. |
| `server-install` / `deploy` / `uninstall` | not done | compose is the deploy path |
| self-update `install` / `update` / `use` / `link` | intentionally not ported | They rewrite the install. See `versions` and `unlink` above. |

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
| `GET /api/v1/runs/{id}/events` | partial | `text/event-stream`. Replay then a live tail (`tests/test_api.py`). Dotted types are `ui-event`; everything else is `run-event`; the record is `run`. `item.delta` is live-only and coalesced at about 40 ms (`tests/test_runner_gaps.py`). A delta-only turn persists one `item.completed` in the engine; that persistence is not asserted. `plan.updated` is mapped for Claude `TodoWrite` and Codex `turn/plan/updated` in the runner tests; the engine writes it, and no test reads it back from the store. `usage.updated` is written when a turn's token gain is positive; no test asserts that event. `permission.*` is not emitted. `item.updated` is not emitted. `afterSeq` and `Last-Event-ID` skip older rows. |
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
| `GET/POST /runs/{id}/git/status`, `commit`, `push`, `GET …/diff`, `POST …/pr` | done | `tests/test_surface.py`. Commit uses the repo identity, or `cezar <cezar@localhost>` when `user.name` is unset. Push and draft PR do not leave the machine when `CEZ_DRY_RUN=1`. The diff uses the freshest anchor. |
| `GET/PUT /ui-state`, `GET/PUT /workspace/ui-state` | partial | shallow merge, 200-key cap, unknown keys kept. `tests/test_surface.py`. |
| `POST/DELETE /workspace/uploads` | partial | `tests/test_finish.py` stores text, starts a run, and finds `note.txt` on the files pane. Delete-by-id is implemented in `tests/test_surface.py`. The prompt line `The user attached:` is not asserted. |
| `GET /api/v1/fs/browse` | partial | `browse_directory` is tested: directories only, `realpath` containment, a symlink out of the root is hidden (`tests/test_finish.py`). No test calls the HTTP route. |
| `GET /providers/status`, `GET /models` | partial | binary presence and a static id list. |
| `POST /preview/design-proxy` | partial | Refuses non-loopback and hosted/`CEZ_DESIGN_MODE=0`. A loopback `http://` target is mirrored on `127.0.0.1` with `<!-- cezar-design -->` injected before `</body>`. `tests/test_surface.py`. |
| `POST /runs/{id}/terminal`, input, resize, output, close | partial | `TerminalHub` opens a PTY, echoes a command, and a resize is read back with `TIOCGWINSZ` (`tests/test_surface.py`, `tests/test_finish.py`). The HTTP open, input, resize, and SSE routes are not called by a test. |
| `GET/POST/DELETE /webhooks`, `POST …/test`, `GET …/deliveries` | done | Receiver URL must pass the destination policy. Dry-run test delivery is recorded as 204 and does not open a socket. Signing key is `whsec_`. `PUT /webhooks/{id}` with `expectedRevision` renames in place and bumps `deliveryRevision` only when the URL changes (`tests/test_stream_d_close.py`). |
| `POST /hooks/github`, `/hooks/jira`, `/hooks/linear`, `GET /hooks/receipts` | done | GitHub checks `X-Hub-Signature-256` against `CEZ_GITHUB_WEBHOOK_SECRET`. Jira and Linear check `X-Cezar-Webhook-Secret`. Unset or wrong is 401. A matching enabled automation can enqueue a run. Receipts are appended locally (`tests/test_surface.py`). |
| GitHub review and merge API | done | Dry-run merge-state, merge, and review. `expectedHeadSha` that is not the current head is 409 `head_moved` and does not merge. A matching head merges. The task page sends the review (`tests/test_parity.py`, `tests/test_stream_d_close.py`, `tests/test_surface.py`). |
| `GET /api/v1/launch-key` | done | Returns the same key the bookmarklet writes, mode 0600. `tests/test_routes.py`. |
| `GET/PUT /api/v1/config` | done | Reads and writes `systemPrompt`, `branchNaming`, and `reviewGate` without dropping other keys. `tests/test_routes.py`. |
| Skills update, workspace branding, plan, deferred-start scheduling | not done | — |
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
| `/p/:projectId` tasks overview | `/tasks` | done | List, filter, and create. `tests/test_cockpit.py`. Archive and mark-read are buttons; the store rules are in `tests/test_surface.py`. The buttons are not posted. |
| `/p/:projectId/new` | `/tasks/new` | done | The page shows the task field, Start, and `quick-task`. Create is the cockpit test. |
| `/tasks` global index | `/tasks` | done | One list for the boot project. There is no second workspace index. |
| `/p/:projectId/tasks/:id` session | `/tasks/{id}?pane=session` | done | Finish is posted and the page shows Cancel (`tests/test_cockpit.py`). The transcript contains `Dry run finished`, and Delete navigates away (`tests/test_screens.py`). |
| `…/changes` | `?pane=diff` | done | `CEZAR_DRY_RUN.txt` is on the diff pane. |
| `…/files` | `?pane=files` | done | A staged upload's name is on the pane (`tests/test_finish.py`). |
| `…/commits` | `?pane=commits` | done | After a commit, the pane lists `save the dry run` (`tests/test_surface.py`). |
| `…/graph` | `?pane=graph` | done | A quick-task shows the step "Do the task" (`tests/test_parity.py`). |
| `…/notes` | `?pane=notes` | done | A posted note is on the next render (`tests/test_parity.py`). |
| `…/terminal` | `?pane=terminal` | done | The pane runs one command in the worktree PTY and returns the output (`tests/test_screens.py`). `e2e/test_screens.py` types it. The HTTP terminal routes stay stream B. |
| `…/browser` | `?pane=browser` | done | The pane states the loopback design-mode rule (`tests/test_parity.py`). |
| `…/compare` | `/tasks/{id}/compare` | done | Variant letters A and B render (`tests/test_parity.py`). |
| `/p/:projectId/git` | `/git` | done | `?pane=` is commits, changes, branches, or files. Commits include `init`, files include `README.md`, branches include `main` (`tests/test_screens.py`). |
| `/p/:projectId/github` | `/github` | done | The page asks for owner and repo. Without a token it says `gh is not authenticated`. A stubbed read renders the issue title (`tests/test_screens.py`). |
| `/p/:projectId/tracker` | `/tracker` | done | Look up posts a key. Unset credentials say `jira is not configured`. A stubbed read renders the summary. A saved connection is used when it has a token (`tests/test_screens.py`). |
| `/p/:projectId/automations` | `/automations` | done | The page posts create, enable, pause, run now, and delete, and the month grid names the row (`tests/test_screens.py`). |
| `/p/:projectId/skills` | `/skills` | done | List and create. `tests/test_cockpit.py`. |
| `/p/:projectId/workflows` | `/workflows` | done | Create and list. `tests/test_cockpit.py`. |
| `/workflows/:name` | `/workflows/{name}` | done | The page lists the steps (`Do the task` on quick-task) and Start a task opens `/tasks/new?workflow=` (`tests/test_screens.py`). The node editor remains stream A's row. |
| `/p/:projectId/inbox` | `/inbox` | done | A finished run is listed. Mark read leaves `Nothing unread.` (`tests/test_screens.py`). |
| `/p/:projectId/settings` appearance | `/settings` | done | Parallel, runner, theme, accent. Settings stream test. |
| settings `secrets`, `workspace-secrets` | `/secrets` | done | The form saves a project secret. The next page shows the name and not the value (`tests/test_screens.py`). One list for the boot project; there is no second workspace vault. |
| settings `privacy` | `/settings/privacy` | done | The page says telemetry is intentionally not ported. `tests/test_finish.py`. |
| settings `agents` | `/settings/agents` | done | A binary on disk is `installed` and a missing path is `missing` (`tests/test_screens.py`). |
| settings `webhooks` | `/settings/webhooks` | done | Saving a loopback receiver puts its name on the page. An http non-loopback URL is refused (`tests/test_screens.py`). |
| settings `worktrees` | `/settings/worktrees` | done | The page saves a keep count for the project. `Engine.retain` uses that count: with two finished worktrees and keep 1, reclaim drops the older directory (`tests/test_screens.py`). Unset, it stays the process default. |
| settings `instructions` | `/settings/instructions` | done | The editor saves both fields, the prompt is prepended on the run, and a `start with` rule renames the branch (`tests/test_engine.py`, `tests/test_parity.py`). Free-text naming still does not call a model. |
| settings `agent-config` | `/settings/agent-config` | done | Posting the editor writes `AGENTS.md`. A hosted cockpit answers 409 `agent config writes are local-only` (`tests/test_screens.py`). Catalog is those three files, not `catalog.ts`. |
| settings `accounts` | `/settings/accounts` | done | The form saves a name and a runner and lists them (`tests/test_screens.py`). Profile homes stay on stream D's accounts row. |
| settings `notifications` | `/settings/notifications` | done | The browser toggle saves and the page says it is on. |
| settings `keyboard` | `/settings/keyboard` | done | `enter` is stored and rendered. The other two shortcuts are the same field. |
| settings `bookmarklets` | `/settings/bookmarklets` | done | The launch-key file is mode `0600`. `?launch=` with that key opens New task; a wrong key is 403 (`tests/test_screens.py`). |
| settings `integrations` | `/settings/integrations` | done | Set up e2e queues a task titled Tester Army, stores an optional model key as a project secret, and writes `e2e.config.ts` (`127.0.0.1:0`) plus `.ai/cezar/workflows/implement-and-e2e.yaml` when those files are absent (`tests/test_screens.py`). It does not run `npx e2e init`. |
| `/dashboard` | `/dashboard` | partial | Status counts render, including `count-done` after a finished run. A bar chart groups each finished run's reported tokens by day (`tests/test_screens.py`). It is not the TypeScript usage-window series of input and output tokens. |
| `/projects` and settings `projects` | `/projects` | done | Add, including refusing `$HOME`. |
| unknown path | — | done | `/does-not-exist` is 404. |
| settings `tracker`, `tasks`, `skills` (global), `global-instructions`, resources | `/settings/tracker`, `/settings/tasks`, `/settings/global-skills`, `/settings/global-instructions`, `/settings/resources` | partial | The base branch is what the next task forks from. The global prompt is prepended before the project's own prompt (`tests/test_screens.py`). A required check runs in the worktree before `done`; `false` fails the run. TypeScript runs those checks only while auto-landing, which this port does not do. Org skill repos are saved and are not cloned into the prompt. The memory cap is saved; the run loop does not sample the agent process tree or pause it. |
| GitHub review and merge UI | task page `#merge-box` | done | A pull request shows Ready to merge or Merge blocked, the blocker, and Squash and merge. `tests/test_surface.py`. Failing checks block `canMerge`. |
| Light / violet tokens, phone layout | the same CSS | done | Saving light and violet sets `class="light"` and `data-accent="violet"` (`tests/test_cockpit.py`). At 390×844 the sidebar stacks above the page; at 1280 it sits beside it, and the wordmark is the light-violet primary (`e2e/test_screens.py`). |
| Command palette | `/palette/results` | done | ⌘K opens a dialog. The results request keeps a task whose title contains the query and drops the pages that do not (`tests/test_screens.py`). |
| Mermaid in the transcript | session pane | done | A mermaid fence of `A --> B` is an SVG flowchart in the transcript. A diagram this port cannot lay out stays as the source (`tests/test_screens.py`). |
| Thread virtualization | session pane | partial | The session renders the latest 40 events and an Earlier link for the rest (`tests/test_screens.py`). It does not virtualize row heights in the browser. |
| Skills auto-update | — | intentionally not ported | It would run `npx` against the network. `CEZ_SKILLS_AUTO_UPDATE` stays unread. |
| Host telemetry | — | intentionally not ported | This fork does not send host telemetry. The consent routes do not open a socket. |

### Background work and integrations

| Item | Status | Verified |
| --- | --- | --- |
| Scheduler loop | done | engine parallel test and the live server |
| Automation ticker | done | engine test |
| Telemetry | intentionally not ported | This fork does not send telemetry. The consent routes, if called, do not open a network request. |
| Star count, self-update, skills auto-update | intentionally not ported | They would phone home or change the install. This fork leaves them out. |
| Desktop shell | intentionally not ported | Owner decision: the Tauri shell stays out of this port. |
| `gh` issues and draft PRs | done | `GET /github` lists open issues and pull requests, including the dry-run draft. A draft PR is the dry-run URL unless dry-run is off, in which case the port runs `gh pr create --draft` after a push (`tests/test_stream_d_close.py`, `tests/test_parity.py`). |
| Webhooks | done | Receivers, signed test deliveries, inbound hooks, and a lifecycle enqueue when `CEZ_WEBHOOKS=1`. The owner is a hard link with a successor slot and refuses to take over a different Linux PID namespace. Retries follow `retryAt`. Replay copies a finished payload for 7 days and refuses `webhook.test`. A receiver edit checks `expectedRevision`. Delivery checks the destination policy (denied, private consent, mixed DNS, hosted https, server port) and does not follow redirects. `tests/test_parity.py`, `tests/test_engine.py`, `tests/test_stream_d_close.py`. |

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
- The terminal hub is a PTY (`bash --noprofile --norc -i`) with `TIOCSWINSZ`.
  The task pane's shell is one open, write, and close. The HTTP terminal routes
  are not what the tests call.
- Worktrees are created inside the project repo. Finish does not merge and does
  not push. `Engine.retain()` can drop a finished worktree directory and keep
  the branch; a test covers the selector, not that deletion.
- GitHub review, merge, and draft PR call `gh` only when `CEZ_DRY_RUN` is off.
  That path is tested with a fake `gh` on `PATH`. Push is `git push`, not `gh`.
- Instructions, branch naming, and the three-file agent catalog are editors.
  A run does not read `instructions.json`. Accounts are a local JSON list.
- `CEZ_WEBHOOKS` defaults off. When it is `1` and a receiver is saved, a
  status change appends one Slack row. Dry-run does not open a socket. Retries
  stop at five attempts (TypeScript expires a delivery after 72 hours) and
  omit the 20% jitter. There is no hard-link owner chain.
- The diff anchor is the fork commit recorded at start, so a base branch that
  moves during the run is not re-attributed.

## How to verify

```bash
uv sync
uv run ruff check
uv run ruff format --check
uv run pyright
uv run pytest -q
CEZ_DRY_RUN=1 uv run python -m app.main
```

The browser loop is not part of `uv run pytest`. It lives in `e2e/` and needs Playwright:

```bash
uv sync --group e2e
uv run --group e2e playwright install chromium
uv run --group e2e pytest e2e -q
```

The process listens on `127.0.0.1:4321`. `GET /health` is open.
`GET /api/v1/health` on that bind is open too. Compose is the hosted check:

```bash
docker compose up --build
```

`GET /health` stays 200. `/tasks` and `/api/v1/health` are 401 until the
generated password in the `cezar-data` volume is sent as HTTP Basic. Do not
print that password.

`claude` and `codex` are not installed in this environment. Runner tests use
the fake binaries under `tests/fakes/`. Nothing here is a live CLI handshake.

## Deviations from TypeScript

- A successful run stops at `done`. `CEZ_REVIEW_GATE=1` or `reviewGate: true`
  parks a non-autonomous run that has a diff at `review`.
- Check steps are `bash -lc`. `bashAllowlist` shapes agent argv and does not
  gate the check. That matches `runCheckStep`.
- URLs are `?project=` on top-level paths. There is no `/p/:projectId`.
- Hosted mode (`CEZ_REMOTE=1` or a non-loopback bind) requires HTTP Basic
  inside this process. TypeScript puts that challenge on nginx.
- The diff base is `resolve_task_diff_base`: the freshest base ref, and a
  repointed HEAD measured against the branch as the run first saw it.
- Secrets live in `$PROJECT_DATA_DIR/secrets`. The data key uses the OS
  keychain when `secret-tool` answers; `CEZ_SECRETS_KEYCHAIN=0` keeps the file.
- Cursor's binary override is `CEZ_CURSOR_AGENT_BIN`, then `CEZ_CURSOR_BIN`.
- `CEZ_AUTOMATIONS=0` is reported on the health document and does not stop the
  ticker. `CEZ_FOLLOWUPS` and `CEZ_SINGLE_PROJECT` are the same kind of flag:
  visible on `/api/v1/health`, not enforced. `CEZ_HIDE_TOKEN_*` flips the
  health capability bits and does not change a chart.
- `CEZ_ARCHIVED_RUNS_KEEP` caps archived rows. Live rows still use `CEZ_RUNS_KEEP`.
- `systemPrompt` is prepended to the agent prompt. Branch names come from the
  namer. Dry-run uses the canned mock only when `CEZ_AUTONAME=1`.
- Agent config is three files. Writes are refused when the cockpit is hosted.
- Accounts are `{id, name, runner, home}` in the data directory. Claude and
  Codex homes are injected on a turn that names the account. Hosted mode
  refuses new accounts unless `CEZ_REMOTE_AGENT_ACCOUNTS=1`.
- Integrations queues one "Tester Army" task. It does not install a framework.
- GitHub merge and review call `gh` only when dry-run is off. The eligibility
  ladder and blocker list live in `app/integrations/merge_state.py`.
  `expectedHeadSha` must match the head.
- The webhook outbox is one NDJSON file. The owner is a hard link with a
  successor slot and a Linux PID namespace. Retries follow `retryAt` (5s
  doubling, 20% jitter, 72h expiry). Replay copies a finished payload for 7
  days and refuses `webhook.test`. Receiver edits check `expectedRevision`.
  Delivery uses the destination policy and does not follow redirects.
  `CEZ_WEBHOOKS` defaults off. Slack rendering covers labels, escapes,
  questions, links, and the 40_000-byte fallback.
- `item.updated` is not emitted. `permission.*` is not emitted. `usage.updated`
  is written only when a turn reports a token gain, and no test reads it back.
- Follow-up reuses a live Claude or Pi process. Otherwise it is a new process
  with `--resume`. Mid-turn steering into that process is not implemented.
- Telemetry, the star count, self-update, and the desktop shell are left out
  on purpose. Consent routes do not open a socket.

## TypeScript tests walked for this audit

`packages/*/src/**/*.test.*` and `packages/web/e2e/` were counted by directory,
not re-run. The large suites are `web/routes` (171), `cezar/server` (160),
`web/lib` (67), `cezar/core` (66), `web/components` (65), `cezar/workflows`
(57), and `cezar/webhooks` (51), plus the browser specs under `packages/web/e2e`
(task thread, git, GitHub, inbox, settings, webhooks, variants, automations).
Python covers a slice of core, workflows, runs, and server with fakes. It does
not run the React e2e suite. Areas that had no row before this pass are in the
next table.

## Not previously listed

| Item | Status | Verified |
| --- | --- | --- |
| `GET/PUT /api/v1/agent-config/:id` | not done | The HTML editor is three files. There is no JSON API. |
| Static `/assets`, `/icon.svg` | not done | The Python cockpit serves its own CSS. |
| Automations JSON API, automation log, check id | not done | Page posts exist and are not this contract. |
| `GET/PUT /config` | done | See the HTTP section. `tests/test_routes.py` writes `.ai/cezar/config.json`. |
| Deferred start options, preview, create | not done | — |
| `GET /e2e`, `POST /e2e/setup` | not done | Integrations queues a task instead. |
| Workspace event stream `GET /events` | not done | Per-run SSE exists. |
| GitHub checks, review comments, PR changes, ref status, search | done | `GET /github/checks`, `/github/search`, `/github/ref-status`, `/github/comments/{kind}/{number}`, `/github/prs/{n}/changes`. Dry-run answers the fixed catalog (128 passing, 124 failing, issue 142, review thread, renamed and binary files) and does not run `gh`. With dry-run off, checks and search run a fake `gh` (`tests/test_github_read.py`). Unknown ref-status numbers are absent; unknown checks are null. |
| Run groups and pick | not done | — |
| `GET /launch-key` | done | See the HTTP section. `tests/test_routes.py`. |
| Open in editor / open targets | not done | — |
| `POST /plan` | not done | — |
| Project checkout, create-on-GitHub, owners, patch, delete | not done | The page can add a local directory. |
| Provider connect, retry, update, enabled | not done | Status is `shutil.which`. |
| Repository `/repo/*` routes | done | `GET /repo`, `/repo/diff`, `/repo/changes`, `/repo/tree`, `/repo/files`, `/repo/commit/{sha}`, `POST /repo/branch`, and `/repo/sync` plus fetch, pull, and push. The tree is `git ls-files`, so a gitignored `.env` is not served. Fetch, pull, and push run against a local bare remote (`tests/test_github_read.py`, `tests/test_stream_d_close.py`). |
| `GET /runs/{id}/commits`, `GET /runs/{id}/files`, `POST /runs/{id}/continue`, `POST /runs/{id}/remove-worktree` | done | Files list the dry-run note, commits list `init`, continue requeues a review into another turn, and remove deletes the worktree directory. `tests/test_routes.py`. |
| Run drafts, layouts, handoff, history, images, land, report, start-now | not done | — |
| `GET /skills/importable`, `POST /skills/refresh` | not done | Local create is tested. |
| `GET/PUT /start-app` | not done | — |
| `POST /telemetry/error`, `POST /telemetry/page` | intentionally not ported | Consent routes do not send. |
| Todos API and `cez` follow-up inbox file | not done | `/inbox` lists unread runs. `CEZ_FOLLOWUPS` is copied onto the health document and does not change the page. |
| Tracker connection, watch, search, association | done | `GET/PUT/DELETE /tracker/connection` stores a `0600` dotenv under `$PROJECT_DATA_DIR/tracker-connections` and never returns the token. Dry-run refuses the save. Association, candidates, list, search, and a watch snapshot talk to a recorded loopback Jira server (`tests/test_tracker.py`). A private origin is rejected before any request. |
| Workspace profiles, branding, config, host usage, runs index, automation templates | not done | — |
| Self-update and skills auto-update routes | intentionally not ported | — |
| `GET /star-count` | intentionally not ported | — |
| `POST /worktrees/reclaim` | done | Returns the ids `Engine.retain()` reclaimed. `tests/test_routes.py`. |
| `CEZ_REVIEW_GATE` | done | Exact `1` parks a diff at `review`. `true` does not. `reviewGate: false` in config wins. An autonomous run stays `done`. `tests/test_engine.py`, `tests/test_cockpit.py`, `tests/test_cli.py`. |
| `CEZ_ARCHIVED_RUNS_KEEP` | done | Archived rows use this cap and live rows use `CEZ_RUNS_KEEP`. `tests/test_finish.py`. `Config.from_env` reads it. |
| `CEZ_HOME`, `CEZ_PROJECTS_DIR` | not done | State is `PROJECT_DATA_DIR` and SQLite. |
| `CEZ_SINGLE_PROJECT` | partial | The health document reports the flag. Project add is not refused because of it. |
| `CEZ_SECRETS_KEYCHAIN` | done | `0` forces the `0600` file. Otherwise a test-injected keychain (or `secret-tool` outside pytest) holds the 32-byte data key and the file is not written. A locked keychain fails the read instead of minting a new key (`tests/test_secrets.py`). |
| `CEZ_ENV_PASSTHROUGH`, `CEZ_AGENT_ENV_FULL`, `CEZ_REDACT_SECRETS` | done | Agents get a curated environment. `CEZ_ENV_PASSTHROUGH` forwards named extras. `CEZ_AGENT_ENV_FULL` of `1`, `true`, or `yes` restores the parent environment; `0` and `false` stay curated. A spawned fake does not see `AWS_SECRET_ACCESS_KEY` unless the full hatch is on. Stored events replace token shapes with `[REDACTED]` unless `CEZ_REDACT_SECRETS=0` (`tests/test_agent_env.py`). Checks still drop `CEZ_*` and inject secret values. |
| `CEZ_TERMINAL` | done | `0` makes `POST /runs/{id}/terminal` answer 409 `terminal is disabled`. `tests/test_routes.py`. |
| `CEZ_AUTOSAVE`, `CEZ_TITLE_UPDATES`, `CEZ_AUTONAME` | not done | No periodic commit and no model title. |
| `CEZ_TASK_PROCESS_REAP`, `CEZ_DISABLE_REPO_LOCK`, `CEZ_WORKFLOW_WEBHOOKS` | not done | — |
| `CEZ_HIDE_TOKEN_USAGE`, `CEZ_HIDE_COST`, `CEZ_HIDE_TOKEN_METRICS` | done | Each flag is set in `tests/test_screens.py`. The health capabilities follow it, and the dashboard hides the token total, the cost total, or both. There is no daily usage chart. |
| `CEZ_NO_BANNER`, `CEZ_UPDATE_CHANNEL`, `CEZ_SUPERVISED` | intentionally not ported | Star count, self-update, and the desktop supervisor. |
| `CEZ_DESKTOP`, `CEZ_DESKTOP_*`, `CEZ_DISCLAIM_EXEC` | intentionally not ported | The Tauri shell is out of scope. |
| `CEZ_SKILLS_AUTO_UPDATE` | intentionally not ported | — |
| `CEZ_REMOTE_AGENT_ACCOUNTS` | done | Hosted mode (`CEZ_REMOTE=1`) refuses `POST /settings/accounts` with 409 until the flag is exactly `1`. A local cockpit saves without it (`tests/test_agent_env.py`). |
| `CEZ_AUTONOMOUS_DEFAULT`, `CEZ_WORKTREE_DEFAULT` | not done | — |
| Release packaging, server-install, disk space, startup port probe | not done | Compose is the container. The listen port does not auto-increment. |
| Worktree lifecycle events, handoff files, skills banner, remote skills | not done | — |
| Browser e2e (`packages/web/e2e/`) | done | `e2e/test_main_loop.py` drives New task to `done`, and review through commit, push, and a fake-`gh` draft PR. `e2e/test_screens.py` covers each ported screen's main action: git panes, workflow steps, settings editors, automations and the calendar, variants compare, the terminal pane, inbox, dashboard, integrations, phone layout, and light/violet. `uv run pytest` does not collect `e2e/`. Thread virtualization, host telemetry, and skills auto-update are separate rows. |


## Deviations from the Stario skills

Skills are from stario-create `e56b6cd80cfcc011c8c1be7b4da92dfba5b5c31c`. One contradiction was fixed in this pass: the run API was importing private helpers from `app/features/task/views.py`. Those reads now live in `app/features/task/data.py`, which is the module another feature is allowed to import.

Left as they are. A later agent should not "clean these up" as a drive-by:

- `os.environ` is still read outside `app/config.py`: `app/engine/engine.py` (the check environment), `app/engine/namer.py`, `app/engine/review_gate.py`, `app/engine/gitwork.py`, `app/engine/telemetry_store.py`, `app/integrations/lifecycle.py`, `app/integrations/coordinator.py`, and `app/features/api/surface.py` (`CEZ_TERMINAL`). Several of those are read at the call, so a test can flip the flag after `Config` is built. A new process-lifetime flag belongs on `Config`. Do not move the live ones without updating the test that sets the variable after the client exists.
- JSON is often `json.dumps` (`app/engine/engine.py`, `app/engine/runners/protocol.py`, `app/integrations/outbox.py`, `app/secrets/store.py`, `app/integrations/hooks.py`). New documents should use `stario.json`. Leave a payload whose bytes are part of a signature or a wire fixture alone.
- Settings, inbox, and new-task commands answer with `w.redirect(..., 303)`. Tests assert that status. The skill's command reply is `w.empty()` or `SSE(w).navigate`, because a 303 does not change the URL inside a Datastar request. Switching the reply changes those tests and the browser walk.
- `Engine`, the terminal hub, and the delta coalescer use `asyncio.create_task`. The skill wants `c.app.create_task`. The engine is constructed with no `App` in tests, so the fallback stays until those tests hold an app.
- Most features have no `data.py`. Rows live in `app/store/db.py`. `Engine` is about 1,800 lines, `app/features/api/surface.py` about 830, and `app/features/api/handlers.py` about 650. The skill treats that shape as a second resource hiding in one class. Splitting it is its own change.
- CSS is hand-written in `static/css/style.css`. That is the Decisions table. Do not add Tailwind.
- A page is not always one resource plus a `db.watch` stream. Several settings pages are static HTML.

## Workstreams

Checklist after this pass: **67 done**, **77 partial**, **41 not done**, **12 intentionally not ported** (197 rows). `GET/PUT /config` and `GET /launch-key` in "Not previously listed" are done; `tests/test_routes.py` already covered them. The 118 open rows (`partial` + `not done`) are each in exactly one stream below. An agent updates only its rows in this file.

`intentionally not ported` (telemetry, star count, self-update, desktop) is not a stream. Do not send it.

How a row was placed when it touched two areas:

- Both SSE rows are A. B owns the other route families in `app/features/api/surface.py` and does not rewrite the event handlers.
- The node editor is A. The existing `/workflows/:name` shell is C. They share `app/features/workflows/`.
- The Todos API is B. The `/inbox` screen is C.
- Static `/assets` and `/icon.svg` are B. CSS and layout are C.
- `CEZ_TASK_PROCESS_REAP`, `CEZ_DISABLE_REPO_LOCK`, and `CEZ_WORKFLOW_WEBHOOKS` are one A row. If that webhook flag starts gating delivery, D edits the coordinator and A edits the engine. Add the field on `Config` once.
- Every CLI row is B, including a future `secrets` subcommand, because they all land in `app/cli.py`. D owns `app/secrets/` and does not add subcommands.
- Worktree retention is A. `POST /worktrees/reclaim` is already done.
- Automations page posts are C. The automations JSON API is B. `Engine.tick` is shared.
- Variants are C: the untested part is `/tasks/{id}/compare`. The `{runs}` body stays on B's `POST /api/v1/runs` row.
- Per-project base branch is C (no editor). Diff-base math is D.
- The model-catalog row is A. `GET /providers/status` and provider connect are B.
- Terminal HTTP routes are B. The terminal pane is C. `app/engine/terminal_hub.py` is shared.

### A — runners, event stream, workflows and graph

18 partial, 10 not done.

Partial:

- Version 2 graph workflows
- Follow-up from `review` is one more agent turn
- Worktree and index retention
- Queued message stack editable before dequeue
- In-place / trunk landing
- Claude stream-json session
- Codex app-server
- OpenCode serve
- Cursor agent
- pi RPC
- Junie ACP
- Copilot ACP
- Stdin subprocess
- Model catalog, provider login, accounts
- MCP, images
- Tool allowlists
- Skills as extra system prompt, local directories only
- `GET /api/v1/runs/{id}/events`

Not done:

- Node editor
- Resume of a live CLI session after restart
- Monitoring / autonomous nudge loop
- Usage-limit auto-resume
- Report injected into the parent's live session
- Workspace event stream `GET /events`
- `CEZ_AUTOSAVE`, `CEZ_TITLE_UPDATES`, `CEZ_AUTONAME`
- `CEZ_TASK_PROCESS_REAP`, `CEZ_DISABLE_REPO_LOCK`, `CEZ_WORKFLOW_WEBHOOKS`
- `CEZ_AUTONOMOUS_DEFAULT`, `CEZ_WORKTREE_DEFAULT`
- Worktree lifecycle events, handoff files, skills banner, remote skills

Owns: `app/engine/runners/`, `app/engine/agents.py`, `app/engine/namer.py`, `app/engine/workflows.py`, `app/engine/graph.py`, `app/engine/skills.py`, `app/engine/prompts.py`, `app/engine/retention.py`, `app/engine/deltas.py`, `app/engine/session_extras.py`, `app/engine/dispatch_logic.py`, `tests/test_runners.py`, `tests/test_runner_gaps.py`, `tests/test_graph.py`, `tests/test_graph_nodes.py`, `tests/test_workflows.py`, `tests/fakes/`.

The node editor, when it exists, is new files under `app/features/workflows/`. C already renders `/workflows/{name}` from that folder.

### B — server route families and the CLI

25 partial, 21 not done.

Partial:

- Import of `.ai/cezar/runs.json` and NDJSON
- UI state, attachments, layouts
- `serve` (default)
- `projects remove`
- `import-runs <path>`
- `GET /api/v1/health`
- `GET /api/v1/runs`
- `POST /api/v1/runs`
- `GET /api/v1/runs/{id}`
- `POST /api/v1/runs/{id}/cancel`
- `POST /api/v1/runs/{id}/finish`
- `POST /api/v1/runs/{id}/messages`
- `POST /api/v1/runs/{id}/archive`, `POST …/pin`, `POST /runs/archive-finished`, `POST /runs/read-all`, `POST …/read`, `POST …/unread`
- `PATCH/DELETE …/queued-messages/{msgId}`
- `DELETE /api/v1/runs/{id}/auto-resume`
- `GET /api/v1/workflows`
- `GET /api/v1/projects`
- Hosted Basic auth
- `GET/PUT /ui-state`, `GET/PUT /workspace/ui-state`
- `POST/DELETE /workspace/uploads`
- `GET /api/v1/fs/browse`
- `GET /providers/status`, `GET /models`
- `POST /preview/design-proxy`
- `POST /runs/{id}/terminal`, input, resize, output, close
- `CEZ_SINGLE_PROJECT`

Not done:

- `cez task` CLI inside the worktree
- `task`, `automation`, `runs`, `secrets`, `telemetry`
- `server-install` / `deploy` / `uninstall`
- Skills update, workspace branding, plan, deferred-start scheduling
- `GET/PUT /api/v1/agent-config/:id`
- Static `/assets`, `/icon.svg`
- Automations JSON API, automation log, check id
- Deferred start options, preview, create
- `GET /e2e`, `POST /e2e/setup`
- Run groups and pick
- Open in editor / open targets
- `POST /plan`
- Project checkout, create-on-GitHub, owners, patch, delete
- Provider connect, retry, update, enabled
- Run drafts, layouts, handoff, history, images, land, report, start-now
- `GET /skills/importable`, `POST /skills/refresh`
- `GET/PUT /start-app`
- Todos API and `cez` follow-up inbox file
- Workspace profiles, branding, config, host usage, runs index, automation templates
- `CEZ_HOME`, `CEZ_PROJECTS_DIR`
- Release packaging, server-install, disk space, startup port probe

Owns: `app/features/api/` (`handlers.py`, `records.py`, `urls.py`, and the non-event, non-git, non-webhook methods of `surface.py`), `app/cli.py`, `app/http/`, `app/engine/import_runs.py`, `app/engine/ui_state.py`, `app/engine/uploads.py`, `app/engine/fs_browse.py`, `app/engine/preview.py`, `app/engine/providers.py`, `app/engine/deferred.py`, `tests/test_api.py`, `tests/test_routes.py`, `tests/test_cli.py`, `tests/test_import_runs.py`.

Git, GitHub, webhook, and hook methods already on `surface.py` stay with D.

### C — Datastar screens, settings, and e2e

3 partial, 0 not done.

Partial:

- settings `tracker`, `tasks`, `skills` (global), `global-instructions`, resources
- `/dashboard`
- Thread virtualization

Command palette and mermaid fences are done. Skills auto-update and host telemetry are intentionally not ported; they are not open work.

Owns: `app/features/tasks/`, `app/features/dashboard/`, `app/features/editors/`, `app/features/places/`, `app/features/projects/`, `app/features/settings/`, `app/features/skills/`, `app/features/automations/` (the page, not the JSON API), `app/features/workflows/views.py` and `handlers.py` for the page that already exists, `app/common/shell.py`, `static/css/style.css`, `e2e/test_main_loop.py`, `tests/test_cockpit.py`.

The merge box and the commit / push / draft-PR buttons on the task page are D's. C owns the rest of that page's layout.

### D — integrations, webhooks, git, GitHub, secrets

0 partial, 0 not done.

Partial: none.

Not done: none.

Owns: `app/integrations/`, `app/engine/gitwork.py`, `app/engine/git_actions.py`, `app/secrets/`, `app/features/secrets/`, `tests/test_secrets.py`, `tests/test_integrations.py`.

### Shared files

Touch these only for the stream that owns the behavior, and leave the other stream's functions in place.

| File | Who writes | Care |
| --- | --- | --- |
| `app/engine/engine.py` | A for the walk, slots, namer, settle, and review gate. D for webhook notify and git actions the walk calls. | B does not rewrite the walk. C does not. |
| `app/features/api/surface.py` | B for route registration and the HTTP families in its list. A for the two event streams. D for git, GitHub, webhook, and hook handlers. | Add a method next to the family you own. |
| `app/features/task/views.py`, `app/features/task/handlers.py` | C for layout. D for the merge box and the git buttons. | A reads the transcript; it does not restyle the page. |
| `app/features/task/data.py` | Shared read. B and C import it. | Do not import `views.py` from the API. |
| `app/features/workflows/` | C owns the current page. A adds a node editor beside it. | Do not replace `views.py` in order to add a canvas. |
| `app/engine/terminal_hub.py` | B opens it from HTTP. C renders the pane. | The PTY loop has one owner at a time; say which in the row you close. |
| `app/config.py` | Whoever adds a field. | One field, one reader. Default it. |
| `app/main.py` | Registration only. | A new page is one `register` call. |
| `app/store/db.py` | Whoever adds a column the skill's way (virtual column, no data migration). | Schema changes are one transaction in `schema`. |
| `tests/conftest.py` | Fixtures only. | `CEZ_DRY_RUN`, `TestClient` base URL, `request_timeout` 30. |
| `tests/test_surface.py`, `tests/test_engine.py`, `tests/test_parity.py`, `tests/test_finish.py` | The stream whose assertion you add. | Do not rewrite another stream's test to make yours fit. |
| `MIGRATION.md` | The stream whose row you close. | Leave the other rows and this section's counts. Fix the count in your stream when a row moves to done. |
