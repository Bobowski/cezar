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
| Import of `.ai/cezar/runs.json` and NDJSON | done | `tests/test_import_runs.py` keeps id, task, status, workflow, runner, and timestamps, skips a bad row, and reads `runs/<id>.ndjson`. `tests/test_stream_b.py` runs `import-runs` and finds the dashed UUID's event text in SQLite. A second import skips the same id. |
| Workflow and skill files remain the authored source | done | `tests/test_workflows.py`, cockpit workflow/skill test |
| Workspace settings: parallel (default 2), runner, theme, accent | done | settings stream test |
| Per-project base branch stored at registration | done | The project card and Settings → Tasks save it through `Engine.set_base_branch`. A task started after that forks from the saved branch (`tests/test_screens.py`). |
| Secrets vault | done | `tests/test_secrets.py` and the check injection test. AES-256-GCM, audiences `checks` and `cezar`, project root binding, list API omits values. Stored under `$PROJECT_DATA_DIR/secrets`, not `~/.cezar/secrets`. The data key is the keychain row. |
| Agent accounts / profiles | done | `/settings/accounts` stores `{id, name, runner, home}` in `$PROJECT_DATA_DIR/agent-accounts.json`. Claude gets `CLAUDE_CONFIG_DIR` and Codex gets `CODEX_HOME`; OpenCode, Cursor, pi, Junie, and Copilot stay on the default login. A turn whose run names the account is spawned with that home (`tests/test_agent_env.py`). `POST /runs` accepts `accountId`. Hosted mode is the `CEZ_REMOTE_AGENT_ACCOUNTS` row. |
| UI state, attachments, layouts | done | `tests/test_surface.py`. Project `.ai/cezar/ui-state.json` and `$PROJECT_DATA_DIR/ui-state.json` merge shallowly and cap a write at 200 keys. Uploads store base64 under the data directory (text, images, pdf, octet-stream) and delete by id. Layouts, drafts, and prompt templates are JSON under the data directory (`tests/test_stream_b_close.py`). |

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
| Version 2 graph workflows | done | `tests/test_graph.py` walks the spec example, including the loop cap. `tests/test_graph_nodes.py` runs a fork, a dispatch, a commit, a dry-run draft PR, and `github.wait-ci`. `tests/test_stream_a.py` runs `github.pr-comment`, `github.pr-update` (`pr ready`, a label, a reviewer), and `github.issue-comment` against a fake `gh`, and fails a comment when the task has no PR. A graph still needs an agent or check reachable from start, which is the TypeScript rule. |
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
| Follow-up from `review` is one more agent turn | done | `deliver` from `review` queues one agent turn with `resume` set and that message as the prompt. `tests/test_stream_a.py`. |
| Cancel, including killing a check | done | `test_cancel_stops_a_check_without_waiting_for_it`, API cancel test |
| Restart marks `running` failed and leaves `queued` | done | `test_a_restart_fails_a_running_agent_and_leaves_the_queue` |
| Resume of a live CLI session after restart | done | `mark_interrupted` still fails the running row. `deliver` on that row queues one follow-up with `resume` and the run id as the session. `tests/test_stream_a.py`. The subprocess itself is gone; the next turn is a new process. |
| Monitoring / autonomous nudge loop | done | `CEZ:MONITORING` parks in `monitoring` and does not hold a slot. The tick requeues the monitoring nudge after the interval, 40 times, then parks in `waiting`. An autonomous turn without `CEZ:DONE` is continued with the autonomous nudge; the dry-run agent answers that nudge with `CEZ:DONE`. `tests/test_stream_a.py`. |
| Usage-limit auto-resume | partial | Claude's usage-limit marker with an epoch (seconds or milliseconds), an ISO timestamp, and a relative delay set `auto_resume_at` to the reset plus 30 seconds. The tick requeues the run. Attempt 12 stops with a note. A check whose output contains `usage limit` also schedules a short retry. `DELETE …/auto-resume` clears the deadline (`tests/test_stream_a.py`, `tests/test_stream_b_close.py`). A clock-only reset (`8:10pm (Europe/Warsaw)`) is not parsed. It does not resume a live provider CLI session. |
| Worktree and index retention | done | `Engine.retain()` deletes finished worktree directories past the cap and index rows past `CEZ_RUNS_KEEP`. A queued row stays. `tests/test_stream_a.py`. The selectors in `tests/test_finish.py` still cover keep 0 and live rows. |
| Archive, pin, read/unread | done | `tests/test_surface.py` and `tests/test_graph_nodes.py`. Bulk archive and mark-all-read match the TypeScript rules. |
| Queued message stack editable before dequeue | done | Edit and delete change the text folded into the prompt and do not write it back onto `task`. A second `Engine.startup` records that a deferred message was lost. `tests/test_stream_a.py`. A message that arrives while `running` is still the next follow-up (`tests/test_graph_nodes.py`). |
| Child dispatch cap 4, budget carve, settle report | done | `tests/test_dispatch.py`, `test_dispatch_caps_children_and_reports_when_one_settles` |
| Report injected into the parent's live session | done | A running parent whose runner implements `steer` receives the child's report in that session, and the pending copy is cleared. With no open session the report stays for the next prompt. `tests/test_stream_a.py`. |
| `cez task` CLI inside the worktree | done | `POST /runs/{id}/dispatch` creates a child while the parent is running and has a branch. `POST /runs/{id}/report` stores `status` and `verdict` on that child and 404s a run with no parent. The CLI posts those routes when `CEZ_API_URL` and `CEZ_TASK_ID` are set, and exits 2 when the URL is missing. `tests/test_stream_b.py`, `tests/test_cli.py`. The child uses the parent's runner. |
| Variants (×2 / ×3) and compare | done | The new-task form posts `variants` 2 and 3 and lands on `/tasks/{id}/compare`, which renders A/B and A/B/C (`tests/test_screens.py`). `POST /api/v1/runs` still returns `{runs}` (`tests/test_api.py`). |
| In-place / trunk landing | partial | A non-git directory runs in place. `CEZ_WORKTREE_DEFAULT=0` runs a git checkout in place (`tests/test_stream_a.py`). `inPlace: true` commits dirty files except `.ai/cezar` and does not push (`tests/test_stream_b_close.py`). Merging onto the trunk is not ported. |

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
| Codex app-server | partial | fake binary. `thread/start` on the first turn; a stored thread id is `thread/resume` on a later turn (`tests/test_runners.py`). A resume that reports `already has an active writer` is retried, then `thread/fork` (`tests/test_runner_gaps.py`). Stdio MCP servers ride `config` overrides. `item/updated`, `fileChange`, and `contextCompaction` are parsed, and a compaction boundary continues the run up to 3 times (`tests/test_stream_a.py`). Not ported: the remaining non-tool item types, and a process-level compaction fixture. |
| OpenCode serve | done | Fake binary. `opencode serve --hostname 127.0.0.1 --port N`, then `POST /session` and `POST /session/:id/message`. A `text/event-stream` body surfaces assistant parts and skips the user's echo; `permission.asked` becomes `permission.requested`. A second turn reuses the stored session id and does not create another session. `tests/test_runners.py`. A JSON body is still accepted. |
| Cursor agent | partial | fake binary. Argv is `-p --force --trust --output-format stream-json` and the prompt as the last positional (system prompt prepended). Same stream-json parser as Claude. One shot: the prompt is argv, not a stdin session. |
| pi RPC | partial | fake binary. `pi --mode rpc`, then `{type:get_state}` and `{type:prompt, streamingBehavior:steer}`. `message_update` / `text_delta`, tool start/end, and `agent_settled` ends the turn. `--session` versus `--session-id`. A non-empty bash allowlist drops Bash. Not the rest of the pi event set. |
| Junie ACP | partial | fake binary. `junie --acp=true -p <cwd>`. JSON-RPC `initialize` (protocolVersion 1), `session/new`, `session/prompt`. `session/update` chunks stream; the prompt response completes the turn. `stopReason: refusal` fails it. |
| Copilot ACP | partial | fake binary. `--acp --allow-all-tools --no-auto-update` (`--model` when set). Same ACP frames as Junie. `allowedTools` and `bashAllowlist` are not mapped onto flags, matching TypeScript. |
| Stdin subprocess | partial | `StdinAgent` remains for a test that records a result-frame usage line. The engine does not use it. |
| Missing binary | done | `test_a_missing_backend_fails_the_run_instead_of_spawning` — the run fails with "not found". There is no `CEZ_REAL_AGENTS` gate. |
| Model catalog, provider login, accounts | partial | `--model` is passed for Claude, Cursor, Pi, and Copilot. `GET /providers/status` is `shutil.which`. `GET /models?runner=` lists ids this port knows when the binary is on PATH. No CLI probe, no login, no agent accounts. |
| MCP, images | done | Claude images and `.ai/cezar/mcp.json` are covered by `tests/test_runners.py`. A staged upload is written into the worktree (`tests/test_finish.py`). The prompt gains `The user attached:` plus those paths (`tests/test_stream_a.py`, `tests/test_stream_b_close.py`). |
| Tool allowlists | done | Claude maps a non-empty bash allowlist to `Bash(<prefix>:*)`. Pi drops Bash. Copilot stays `--allow-all-tools`. Codex and OpenCode argv do not carry an allowlist. `tests/test_runners.py`. |
| Skills as extra system prompt, local directories only | partial | The engine loads `.ai/cezar/skills`, `.ai/skills`, `.agents/skills`, and the `.claude` / `.codex` / `.cursor` / `.opencode` mirrors. Global `~/.agents/skills` and `~/.claude/skills` are read, and a local file wins a name clash. A team repo is read from `~/.cache/cez/team-skills` when that directory already exists. Nothing clones or fetches. `tests/test_stream_a.py`. |

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
| `serve` (default) | done | `tests/test_cli.py`. No arguments and `serve` both call `serve` on `127.0.0.1`. `--port 9` is the port passed through. An omitted port uses the first free port from 4321, so an explicit port is never rewritten (`tests/test_stream_b_close.py`). |
| `run` — `review` is exit 0, failure is exit 1 | done | `tests/test_cli.py` |
| `init` | done | same |
| `projects list` / `add` | done | same |
| `projects remove` | done | `tests/test_cli.py`. Removes an added id, then a second remove is "not found". `CEZ_SINGLE_PROJECT=1` refuses add and remove. |
| `import-runs <path>` | done | `tests/test_stream_b.py`. The command copies the record and the dashed `runs/<uuid>.ndjson` event into SQLite. |
| `task`, `automation`, `runs`, `secrets`, `telemetry` | done | `tests/test_cli.py`. `task create` posts dispatch. `runs list --json` prints the records. `automation schema`, `create`, `cron`, and `tracker` post the schedule API (`cron` defaults `kind` to `schedule`, `tracker` to `tracker`). `automation check <id>` posts `…/check`. `secrets set` reads stdin, `list` prints the name and audience, never the value, and `unset` removes it. `telemetry status` says it does not send; `telemetry enable` exits 1. |
| `versions`, `unlink` | intentionally not ported | Same family as self-update. This fork does not rewrite its install. |
| `server-install` / `deploy` / `uninstall` | done | Python equivalent, not the Node installer. `server-install` writes `cezar.service` (`ExecStart=python -m app.main`) and `compose.yaml` into `--dest` and does not call systemd, launchd, or docker. `deploy` writes only the compose file. `uninstall` deletes those two names. `tests/test_stream_b_close.py`. |
| self-update `install` / `update` / `use` / `link` | intentionally not ported | They rewrite the install. See `versions` and `unlink` above. |

### HTTP

Project routes are also mounted at `/api/v1/p/default/…` and
`/api/v1/p/<project id>/…`. An unknown project id is 404. The unscoped mount
is the boot project.

| Route | Status | Verified |
| --- | --- | --- |
| `GET /health` | done | cockpit test. Plain `ok`. |
| `GET /api/v1/health` | done | `tests/test_api.py` and `tests/test_stream_b.py`. Required discovery keys, CORS `*`, no `root` on `projects[]`. A found binary includes its `--version` line (`git` in the test). `disk` has `freeBytes`, `totalBytes`, and `level`. `instanceId` is sent when `CEZ_INSTANCE_ID` is set. `terminal` follows `CEZ_TERMINAL` on a local bind. `designMode` follows the local design-mode flag. `forge` is `{kind: github}` when `origin` is a GitHub host, and null otherwise. Health does not shell out to `gh`, so `available` stays absent. |
| `GET /api/v1/runs` | done | JSON array of records. `workflowDef` omitted unless `full=1`. While a check is running the record includes `usage` (`cpuPct`, `rssBytes`, `procCount`) from that process tree (`tests/test_stream_b_close.py`). |
| `POST /api/v1/runs` | done | 201 stored record, or `{runs}` for `variants` 2 or 3 (letters A/B/C, one `groupId`). Inline steps run as `(planned)`. Image attachments are stored, and the dry-run prompt contains `The user attached:` (`tests/test_stream_b_close.py`). An attachment-only task is stored as `(see attachments)`. |
| `GET /api/v1/runs/{id}` | done | Required record keys (`id`, `title`, `workflow`, `task`, `status`, `createdAt`, `tokensUsed`, `archived`, `steps`). `tests/test_api.py`. `autoResumeAt` is present only while a retry is scheduled. |
| `GET /api/v1/runs/{id}/events` | done | `text/event-stream`. Replay then a live tail (`tests/test_api.py`). Dotted types are `ui-event`; everything else is `run-event`; the record is `run`. `item.delta` is live-only and coalesced at about 40 ms (`tests/test_runner_gaps.py`). A delta-only turn persists one `item.completed`. `plan.updated`, `usage.updated`, `permission.requested`, and `item.updated` are written and read back (`tests/test_stream_a.py`). `afterSeq` and `Last-Event-ID` skip older rows. |
| `POST /api/v1/runs/{id}/cancel` | done | 200 `{cancelled: true\|false}`. A settled run is false. 404 unknown. `tests/test_api.py`. |
| `POST /api/v1/runs/{id}/finish` | done | 200 from `review` (accept), from `waiting` (the ask is abandoned), and from `running` (the step is stopped and the run becomes `done`). A settled run is 409 `no open session`. An in-place git checkout is committed on success and is not pushed (`tests/test_api.py`, `tests/test_stream_b_close.py`). |
| `DELETE /api/v1/runs/{id}` | done | 200 `{deleted: true}`. 409 while queued, running, or waiting. 404 unknown. |
| `POST /api/v1/runs/{id}/messages` | done | `{queued, message}` while the run is still `queued`; the stack is composed into the prompt and not written back onto `task`. `{delivered: true}` for `waiting` and `review`. `{deferred: true}` while `running`. Images on a review message are written into the worktree and the next prompt contains `The user attached:` (`tests/test_api.py`, `tests/test_stream_b_close.py`). |
| `POST /api/v1/runs/{id}/archive`, `POST …/pin`, `POST /runs/archive-finished`, `POST /runs/read-all`, `POST …/read`, `POST …/unread` | done | Archive and pin flags. Archiving clears a pin and cancels queued, running, or waiting work. The bulk sweep and read receipts match the TypeScript rules (`tests/test_surface.py`). |
| `PATCH/DELETE …/queued-messages/{msgId}` | done | Edit and delete while the run is still queued. After it starts, patch is 409. `tests/test_stream_b.py`. |
| `DELETE /api/v1/runs/{id}/auto-resume` | done | 200 `{cancelled: true}` when a usage-limit retry is scheduled, and `{cancelled: false}` when nothing is scheduled. The cleared run stays `failed`. 404 unknown. `tests/test_stream_b_close.py`, `tests/test_api.py`. |
| `GET /api/v1/workflows` | done | `{workflows, issues}`. A workflow file that is not valid YAML is reported under `issues` and the built-in `quick-task` stays (`tests/test_stream_b_close.py`). |
| `GET /api/v1/projects` | done | `id`, `name`, `root`, `addedAt`, `lastOpenedAt`, `source: local`, `status`, `branch` when it is a git checkout, `tags`, and `forge` (`{kind: github}` when `origin` is a GitHub host). The document includes `maxParallel`. `projectsDir` is `CEZ_PROJECTS_DIR`, or `<data dir>/projects` when that is unset. `PATCH` accepts `tags`. `tests/test_api.py`, `tests/test_stream_b_close.py`. |
| Loopback `Host` guard on `/api` | done | `tests/test_api.py`. Foreign Host is 403, including health. `CEZ_REMOTE=1` skips it. |
| Hosted Basic auth | done | `tests/test_api.py`. Required when hosted. `GET /health` is open. A missing `CEZ_AUTH_PASSWORD` is generated into the data directory at mode 0600. A successful Basic login sets an HttpOnly `cezar_session` cookie (token file mode 0600) that authorizes the next request without the header (`tests/test_stream_b_close.py`). There is no Settings user table; the password file is the credential. |
| `GET/POST /runs/{id}/git/status`, `commit`, `push`, `GET …/diff`, `POST …/pr` | done | `tests/test_surface.py`. Commit uses the repo identity, or `cezar <cezar@localhost>` when `user.name` is unset. Push and draft PR do not leave the machine when `CEZ_DRY_RUN=1`. The diff uses the freshest anchor. |
| `GET/PUT /ui-state`, `GET/PUT /workspace/ui-state` | done | shallow merge, 200-key cap, unknown keys kept. `tests/test_surface.py`. |
| `POST/DELETE /workspace/uploads` | done | `tests/test_finish.py` stores text, starts a run, and finds `note.txt` on the files pane. Delete-by-id is implemented in `tests/test_surface.py`. The prompt line `The user attached:` is asserted in `tests/test_stream_b_close.py`. |
| `GET /api/v1/fs/browse` | done | Directories only. A symlink whose target is outside `CEZ_BROWSE_ROOT` is hidden, and that outside path is 400. `tests/test_stream_b.py`. |
| `GET /providers/status`, `GET /models` | done | Binary presence, a static id list, and the local connect marker (`connected`, `enabled`, `version`). `tests/test_surface.py`, `tests/test_stream_b_close.py`. |
| `POST /preview/design-proxy` | done | Refuses non-loopback and hosted/`CEZ_DESIGN_MODE=0`. A loopback `http://` target is mirrored on `127.0.0.1` with `<!-- cezar-design -->` injected before `</body>`. `tests/test_surface.py`. |
| `POST /runs/{id}/terminal`, input, resize, output, close | done | Open answers 201, input and resize answer 200, the output stream's first event is `output`, and close then a second close is 404. `tests/test_stream_b.py`. `CEZ_TERMINAL=0` is still 409 (`tests/test_routes.py`). |
| `GET/POST/DELETE /webhooks`, `POST …/test`, `GET …/deliveries` | done | Receiver URL must pass the destination policy. Dry-run test delivery is recorded as 204 and does not open a socket. Signing key is `whsec_`. `PUT /webhooks/{id}` with `expectedRevision` renames in place and bumps `deliveryRevision` only when the URL changes (`tests/test_stream_d_close.py`). |
| `POST /hooks/github`, `/hooks/jira`, `/hooks/linear`, `GET /hooks/receipts` | done | GitHub checks `X-Hub-Signature-256` against `CEZ_GITHUB_WEBHOOK_SECRET`. Jira and Linear check `X-Cezar-Webhook-Secret`. Unset or wrong is 401. A matching enabled automation can enqueue a run. Receipts are appended locally (`tests/test_surface.py`). |
| GitHub review and merge API | done | Dry-run merge-state, merge, and review. `expectedHeadSha` that is not the current head is 409 `head_moved` and does not merge. A matching head merges. The task page sends the review (`tests/test_parity.py`, `tests/test_stream_d_close.py`, `tests/test_surface.py`). |
| `GET /api/v1/launch-key` | done | Returns the same key the bookmarklet writes, mode 0600. `tests/test_routes.py`. |
| `GET/PUT /api/v1/config` | done | Reads and writes `systemPrompt`, `branchNaming`, and `reviewGate` without dropping other keys. `tests/test_routes.py`. |
| Skills update, workspace branding, plan, deferred-start scheduling | done | `POST /skills/update` copies local skill files and reports `network: false`. `PUT /workspace/branding` stores a name and accent and does not rewrite the theme. `POST /plan` enqueues one agent step and returns `callsModel: false` (it does not call a model). Deferred start is `tests/test_stream_b.py`. The rest is `tests/test_stream_b_close.py`. |
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
| `/dashboard` | `/dashboard` | done | Status counts render, including `count-done` after a finished run. The usage table is a 7-day or 30-day UTC window (`?period=30d`). Input and output tokens, and cost, are lifetime totals grouped by the day the task was created. Completed counts `done` tasks by the day they finished, including a task created before the window. Hiding token or cost metrics drops those columns (`tests/test_screens.py`). |
| `/projects` and settings `projects` | `/projects` | done | Add, including refusing `$HOME`. |
| unknown path | — | done | `/does-not-exist` is 404. |
| settings `tracker`, `tasks`, `skills` (global), `global-instructions`, resources | `/settings/tracker`, `/settings/tasks`, `/settings/global-skills`, `/settings/global-instructions`, `/settings/resources` | done | The base branch is what the next task forks from. The global prompt is prepended before the project's own prompt (`tests/test_screens.py`). A required check runs in the worktree before `done`; `false` fails the run. TypeScript runs those checks only while auto-landing, which this port does not do. An org skill repo is cloned bare — a local path in the test — and a step that names the skill gets that body in the prompt. The memory cap samples the agent process tree (`VmRSS` of processes whose cwd is the worktree, plus their descendants). Crossing it pauses the task at `waiting` and the note names the limit. The form still rejects a cap under 256 MB. |
| GitHub review and merge UI | task page `#merge-box` | done | A pull request shows Ready to merge or Merge blocked, the blocker, and Squash and merge. `tests/test_surface.py`. Failing checks block `canMerge`. |
| Light / violet tokens, phone layout | the same CSS | done | Saving light and violet sets `class="light"` and `data-accent="violet"` (`tests/test_cockpit.py`). At 390×844 the sidebar stacks above the page; at 1280 it sits beside it, and the wordmark is the light-violet primary (`e2e/test_screens.py`). |
| Command palette | `/palette/results` | done | ⌘K opens a dialog. The results request keeps a task whose title contains the query and drops the pages that do not (`tests/test_screens.py`). |
| Mermaid in the transcript | session pane | done | Every mermaid fence is a `pre.mermaid`. The vendored `static/js/mermaid.min.js` draws it in the browser. There is no CDN and no homegrown layout. `e2e/test_screens.py` waits for a flowchart and a sequence diagram, and aborts any request that is not the cockpit. |
| Thread virtualization | session pane | done | The server sends every event. At 300 rows the thread stays flat; past that, or with `?thread=virtual`, the browser keeps the last 16 rows in the DOM. `?thread=flat` keeps every row (`tests/test_screens.py`, `e2e/test_screens.py`). It does not restore a scrolled-up position the way virtua does. |
| Skills auto-update | — | intentionally not ported | TypeScript runs it. After the server listens, a coordinator checks Open Mercato skill updates at most once per six-hour cache window and, when one is available and auto-update is on, applies it with a bounded `npx --yes skills update`. `CEZ_SKILLS_AUTO_UPDATE=0` or the Settings override skips applying; the background check can still run. This port does not start that coordinator. Adam can decide whether to port it. |
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
  ticker. The automations JSON family answers 409 when it is set. `CEZ_FOLLOWUPS=1`
  is what makes `GET/DELETE/POST /todos` read the inbox file; off, the list is
  empty and a mutation is 409. The inbox page does not use that file.
  `CEZ_SINGLE_PROJECT=1` refuses project add, patch, and remove. `CEZ_HIDE_TOKEN_*`
  flips the health capability bits and hides the matching dashboard totals and
  usage-series columns.
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
| `GET/PUT /api/v1/agent-config/:id` | done | `tests/test_stream_b.py`. Ids, scopes, and precedence strings follow `catalog.ts` (26 files, including `project.agents` and `claude.project.settings`). PUT writes repo files when `version` matches and 409s a stale version. User-scope files are listed locally and refused on write. A hosted cockpit 409s every write and does not serve outside-repo files. `userMcp` is `{servers: []}` because this cockpit does not read `~/.claude.json`. |
| Static `/assets`, `/icon.svg` | done | `GET /icon.svg` returns the svg and `GET /assets/mark.txt` returns that file. A missing asset is 404. `tests/test_stream_b.py`. These are files under `static/`, not a Vite `web/dist` manifest. |
| Automations JSON API, automation log, check id | done | `tests/test_stream_b.py`. Schedule create, revisioned PUT (409 on a stale `expectedRevision`), enable, run, delete, and `GET /automation-log` (the run id from run-now). `POST …/check` returns an id, `matches: 0`, and `launched: false`. `CEZ_AUTOMATIONS=0` is 409. Create accepts `kind` (`schedule`, `github`, `tracker`), `events`, and `filters`. `GET /automations` includes `stats` (`total`, `enabled`, `runsLaunched`). `GET /automation-templates` is a fixed local list. `tests/test_stream_b_close.py`. The HTML page is unchanged. |
| `GET/PUT /config` | done | See the HTTP section. `tests/test_routes.py` writes `.ai/cezar/config.json`. |
| Deferred start options, preview, create | done | `tests/test_stream_b.py`. Options report the local zone and `usageReset.available: false`. A future `at` previews `notBefore` and a revision; a past time is unavailable. Create stores one enabled once-automation and replays the same idempotency key. A different task on that key is 409. |
| `GET /e2e`, `POST /e2e/setup` | done | `GET /e2e` reports a local `e2e.config.ts` (or `.mts` / `.py`), credential names from `e2e.credentials.json` (never the values), and the latest `set up e2e` run. `POST /e2e/setup` enqueues that task. No network. `tests/test_stream_b_close.py`. |
| Workspace event stream `GET /events` | done | `GET /api/v1/workspace/events` emits `run` with `projectId` when a run is saved (`tests/test_stream_a.py`). `GET /api/v1/events` and `GET /api/v1/p/{id}/events` are that one project and omit `projectId`. `run-deleted` and `worktree-lifecycle` use the same fan-out. Todos and host usage samples are not on the stream. |
| GitHub checks, review comments, PR changes, ref status, search | done | `GET /github/checks`, `/github/search`, `/github/ref-status`, `/github/comments/{kind}/{number}`, `/github/prs/{n}/changes`. Dry-run answers the fixed catalog (128 passing, 124 failing, issue 142, review thread, renamed and binary files) and does not run `gh`. With dry-run off, checks and search run a fake `gh` (`tests/test_github_read.py`). Unknown ref-status numbers are absent; unknown checks are null. |
| Run groups and pick | done | `tests/test_stream_b.py`. `GET /groups/{id}` lists letters A and B. `POST …/pick` archives the other variant and leaves the winner. `diffStat` is empty. Handoff excerpts are not included. |
| `GET /launch-key` | done | See the HTTP section. `tests/test_routes.py`. |
| Open in editor / open targets | done | `tests/test_stream_b.py`. `GET /open-targets` lists `cursor`, `code`, or `idea` when that binary is on `PATH`. An unknown target is 400. With `CEZ_DRY_RUN=1` a known target answers `{opened: true, dryRun: true}` and does not spawn. With dry-run off, `code` is handed to the spawn hook and the test records the argv (`tests/test_stream_b_close.py`). Hosted mode returns an empty list. |
| `POST /plan` | done | Enqueues one agent step whose prompt is the task and returns `callsModel: false`. This port does not call a model to draft the plan. `tests/test_stream_b_close.py`. |
| Project checkout, create-on-GitHub, owners, patch, delete | done | `tests/test_stream_b.py`. `POST /projects` registers a local directory. `PATCH` renames it and can set `tags`. `DELETE` removes it and 409s the boot project. `CEZ_SINGLE_PROJECT=1` 409s add. `POST /projects/checkout` and `POST /projects/github` register a directory under `projectsDir`. `GET /github/owners` returns a login. Dry-run does not call `gh`; a live checkout calls the injected runner (`tests/test_stream_b_close.py`). |
| Provider connect, retry, update, enabled | done | `POST /providers/{name}/connect` and `…/retry` write a local marker. In a dry run the version is `dry-run` and the probe is not called. `PUT …/enabled` stores the boolean. There is no network login. `tests/test_stream_b_close.py`. |
| Repository `/repo/*` routes | done | `GET /repo`, `/repo/diff`, `/repo/changes`, `/repo/tree`, `/repo/files`, `/repo/commit/{sha}`, `POST /repo/branch`, and `/repo/sync` plus fetch, pull, and push. The tree is `git ls-files`, so a gitignored `.env` is not served. Fetch, pull, and push run against a local bare remote (`tests/test_github_read.py`, `tests/test_stream_d_close.py`). |
| `GET /runs/{id}/commits`, `GET /runs/{id}/files`, `POST /runs/{id}/continue`, `POST /runs/{id}/remove-worktree` | done | Files list the dry-run note, commits list `init`, continue requeues a review into another turn, and remove deletes the worktree directory. `tests/test_routes.py`. |
| Run drafts, layouts, handoff, history, images, land, report, start-now | done | File-backed drafts, layouts, and prompt templates. Handoff is a markdown file per run. History lists stored events. Images materialize into the worktree. Land commits an in-place checkout. `GET …/report` returns the stored dispatch report (null when there is none) and `POST …/report` still 404s a run with no parent. `POST …/start-now` drops a usage-limit hold. `tests/test_stream_b_close.py`. |
| `GET /skills/importable`, `POST /skills/refresh` | done | Lists `.ai/skills` and `.agents/skills` that are not already under `.ai/cezar/skills`, then copies those files. `network` is false. No clone and no fetch. `tests/test_stream_b_close.py`. |
| `GET/PUT /start-app` | done | Stores `{command, cwd}` under the data directory. The command is not executed. `tests/test_stream_b_close.py`. |
| `POST /telemetry/error`, `POST /telemetry/page` | intentionally not ported | Consent routes do not send. |
| Todos API and `cez` follow-up inbox file | done | `tests/test_stream_b.py`. The file is `.ai/cezar/todos.json` (or `CEZ_TODOS_FILE`). A row without a summary is skipped. `GET` is `[]` when `CEZ_FOLLOWUPS` is off; delete is then 409. Start enqueues a run, writes `startedTaskId`, and a second start is 409. The `/inbox` page is unchanged. |
| Tracker connection, watch, search, association | done | `GET/PUT/DELETE /tracker/connection` stores a `0600` dotenv under `$PROJECT_DATA_DIR/tracker-connections` and never returns the token. Dry-run refuses the save. Association, candidates, list, search, and a watch snapshot talk to a recorded loopback Jira server (`tests/test_tracker.py`). A private origin is rejected before any request. |
| Workspace profiles, branding, config, host usage, runs index, automation templates | done | `tests/test_stream_b.py`. `GET/PUT /workspace/config` reads and sets `maxParallel` (1–16). `GET /workspace/runs-index` lists id, title, status, and project across the registry. Profiles, branding, host disk usage, and automation templates are stored or listed locally (`tests/test_stream_b_close.py`). Branding does not rewrite the cockpit theme. |
| Self-update and skills auto-update routes | intentionally not ported | — |
| `GET /star-count` | intentionally not ported | — |
| `POST /worktrees/reclaim` | done | Returns the ids `Engine.retain()` reclaimed. `tests/test_routes.py`. |
| `CEZ_REVIEW_GATE` | done | Exact `1` parks a diff at `review`. `true` does not. `reviewGate: false` in config wins. An autonomous run stays `done`. `tests/test_engine.py`, `tests/test_cockpit.py`, `tests/test_cli.py`. |
| `CEZ_ARCHIVED_RUNS_KEEP` | done | Archived rows use this cap and live rows use `CEZ_RUNS_KEEP`. `tests/test_finish.py`. `Config.from_env` reads it. |
| `CEZ_HOME`, `CEZ_PROJECTS_DIR` | done | `tests/test_stream_b.py`. With `PROJECT_DATA_DIR` unset, `CEZ_HOME` is the SQLite directory. An empty `CEZ_HOME` does not count. `PROJECT_DATA_DIR` still wins, so compose keeps its volume. `CEZ_PROJECTS_DIR` is `projectsDir` on `GET /projects`. |
| `CEZ_SINGLE_PROJECT` | done | Exact `1`. The health document reports it. Project add, patch, and delete answer 409, and `projects add` / `projects remove` refuse. `tests/test_stream_b.py`, `tests/test_cli.py`. |
| `CEZ_SECRETS_KEYCHAIN` | done | `0` forces the `0600` file. Otherwise a test-injected keychain (or `secret-tool` outside pytest) holds the 32-byte data key and the file is not written. A locked keychain fails the read instead of minting a new key (`tests/test_secrets.py`). |
| `CEZ_ENV_PASSTHROUGH`, `CEZ_AGENT_ENV_FULL`, `CEZ_REDACT_SECRETS` | done | Agents get a curated environment. `CEZ_ENV_PASSTHROUGH` forwards named extras. `CEZ_AGENT_ENV_FULL` of `1`, `true`, or `yes` restores the parent environment; `0` and `false` stay curated. A spawned fake does not see `AWS_SECRET_ACCESS_KEY` unless the full hatch is on. Stored events replace token shapes with `[REDACTED]` unless `CEZ_REDACT_SECRETS=0` (`tests/test_agent_env.py`). Checks still drop `CEZ_*` and inject secret values. |
| `CEZ_TERMINAL` | done | `0` makes `POST /runs/{id}/terminal` answer 409 `terminal is disabled`. `tests/test_routes.py`. |
| `CEZ_AUTOSAVE`, `CEZ_TITLE_UPDATES`, `CEZ_AUTONAME` | done | Turn end and run finalize commit `cezar autosave (turn end)` or `cezar autosave (run finalize)` on the task branch. Signing follows the repo's git config, matching `autosaveCommit` in `packages/cezar/src/git-worktree.ts` (`commit --no-verify`, no `commit.gpgsign` override). Tests set `commit.gpgsign false` on the repo in `tests/conftest.py`. `CEZ_AUTOSAVE=1` adds the periodic commit (`tests/test_stream_a.py`). `CEZ_TITLE_UPDATES=0` skips the live title refresh; otherwise a dry-run with `CEZ_AUTONAME=1` may rename from the turn (`tests/test_stream_a.py`). `CEZ_AUTONAME` itself is covered by `tests/test_engine.py`. |
| `CEZ_TASK_PROCESS_REAP`, `CEZ_DISABLE_REPO_LOCK`, `CEZ_WORKFLOW_WEBHOOKS` | done | Settling a run SIGTERMs processes whose environ contains `CEZ_TASK_ID=<id>`; `CEZ_TASK_PROCESS_REAP=0` leaves them. In-place runs take one repo-root lock; `CEZ_DISABLE_REPO_LOCK=1` skips it and says so. A `notify.webhook` node fails until `CEZ_WORKFLOW_WEBHOOKS=1`, then POSTs. `tests/test_stream_a.py`. |
| `CEZ_HIDE_TOKEN_USAGE`, `CEZ_HIDE_COST`, `CEZ_HIDE_TOKEN_METRICS` | done | Each flag is set in `tests/test_screens.py`. The health capabilities follow it, and the dashboard hides the token total, the cost total, or both, and drops the matching columns from the usage series. |
| `CEZ_NO_BANNER`, `CEZ_UPDATE_CHANNEL`, `CEZ_SUPERVISED` | intentionally not ported | Star count, self-update, and the desktop supervisor. |
| `CEZ_DESKTOP`, `CEZ_DESKTOP_*`, `CEZ_DISCLAIM_EXEC` | intentionally not ported | The Tauri shell is out of scope. |
| `CEZ_SKILLS_AUTO_UPDATE` | intentionally not ported | TypeScript reads it, and the Settings override, to decide whether the post-listen skills update applies. This port does not run that update. See the skills auto-update screen row. |
| `CEZ_REMOTE_AGENT_ACCOUNTS` | done | Hosted mode (`CEZ_REMOTE=1`) refuses `POST /settings/accounts` with 409 until the flag is exactly `1`. A local cockpit saves without it (`tests/test_agent_env.py`). |
| `CEZ_AUTONOMOUS_DEFAULT`, `CEZ_WORKTREE_DEFAULT` | done | Exact `1` / `0`. Omitted on `plan_run` inherits them: autonomous on, or a git checkout run in place. An explicit argument wins. `tests/test_stream_a.py`. |
| Release packaging, server-install, disk space, startup port probe | done | Deviation from the Node installer: `cez package` writes a wheel of the `app` package, and the image is the repo `Dockerfile` (`CEZ_DRY_RUN=1`, `python -m app.main`). `server-install` / `deploy` / `uninstall` only write or delete unit files. Disk space is the `disk` field on `GET /api/v1/health` and `GET /workspace/host-usage`. An omitted listen port probes forward from 4321; `--port 9` stays 9. `tests/test_stream_b.py`, `tests/test_stream_b_close.py`. |
| Worktree lifecycle events, handoff files, skills banner, remote skills | not done | — |
| Browser e2e (`packages/web/e2e/`) | done | `e2e/test_main_loop.py` drives New task to `done`, and review through commit, push, and a fake-`gh` draft PR. `e2e/test_screens.py` covers each ported screen's main action: git panes, workflow steps, settings editors, automations and the calendar, variants compare, the terminal pane, inbox, dashboard, integrations, phone layout, and light/violet. `uv run pytest` does not collect `e2e/`. Thread virtualization, host telemetry, and skills auto-update are separate rows. |


## Deviations from the Stario skills

Skills are from stario-create `e56b6cd80cfcc011c8c1be7b4da92dfba5b5c31c`. One contradiction was fixed in this pass: the run API was importing private helpers from `app/features/task/views.py`. Those reads now live in `app/features/task/data.py`, which is the module another feature is allowed to import.

Left as they are. A later agent should not "clean these up" as a drive-by:

- `os.environ` is still read outside `app/config.py`: `app/engine/engine.py` (the check environment), `app/engine/namer.py`, `app/engine/review_gate.py`, `app/engine/gitwork.py`, `app/engine/telemetry_store.py`, `app/integrations/lifecycle.py`, and `app/integrations/coordinator.py`. `CEZ_TERMINAL`, `CEZ_SINGLE_PROJECT`, `CEZ_FOLLOWUPS`, `CEZ_AUTOMATIONS`, `CEZ_INSTANCE_ID`, and the hosted Basic credentials are read in `app/config.py` at the call, so a test can still flip them after `Config` is built. A new process-lifetime flag belongs on `Config`. Do not move the live engine ones without updating the test that sets the variable after the client exists.
- JSON is often `json.dumps` (`app/engine/engine.py`, `app/engine/runners/protocol.py`, `app/integrations/outbox.py`, `app/secrets/store.py`, `app/integrations/hooks.py`). Route documents in `app/features/api/surface.py`, `app/engine/ui_state.py`, and `app/engine/uploads.py` go through `stario.json`. Leave a payload whose bytes are part of a signature or a wire fixture alone.
- Settings, inbox, and new-task commands answer with `w.redirect(..., 303)`. Tests assert that status. The skill's command reply is `w.empty()` or `SSE(w).navigate`, because a 303 does not change the URL inside a Datastar request. Switching the reply changes those tests and the browser walk. The `/api/v1` families answer JSON.
- The walk, the delta coalescer, and the terminal read loop go through `Engine._schedule`. When the server has bound an `App`, that is `App.create_task` (`tests/test_stream_a.py`). The CLI builds an `Engine` with no `App`, so the same helper uses `asyncio.create_task` there. Do not delete that fallback.
- Most features have no `data.py`. Rows live in `app/store/db.py`. `Engine` is about 2,500 lines, `app/features/api/surface.py` about 1,450, and `app/features/api/handlers.py` about 670. The skill treats that shape as a second resource hiding in one class. Splitting it is its own change.
- CSS is hand-written in `static/css/style.css`. That is the Decisions table. Do not add Tailwind.
- A page is not always one resource plus a `db.watch` stream. Several settings pages are static HTML.

## Workstreams

Checklist after this pass: **175 done**, **11 partial**, **2 not done**, **14 intentionally not ported** (202 rows). Stream B has no open rows. The 13 open rows are all in stream A. An agent updates only its rows in this file.

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

11 partial, 2 not done.

Partial:

- In-place / trunk landing
- Usage-limit auto-resume
- Claude stream-json session
- Codex app-server
- Cursor agent
- pi RPC
- Junie ACP
- Copilot ACP
- Stdin subprocess
- Model catalog, provider login, accounts
- Skills as extra system prompt, local directories only

Not done:

- Node editor
- Worktree lifecycle events, handoff files, skills banner, remote skills

Owns: `app/engine/runners/`, `app/engine/agents.py`, `app/engine/namer.py`, `app/engine/workflows.py`, `app/engine/graph.py`, `app/engine/skills.py`, `app/engine/prompts.py`, `app/engine/retention.py`, `app/engine/deltas.py`, `app/engine/session_extras.py`, `app/engine/dispatch_logic.py`, `tests/test_runners.py`, `tests/test_runner_gaps.py`, `tests/test_graph.py`, `tests/test_graph_nodes.py`, `tests/test_workflows.py`, `tests/fakes/`.

The node editor, when it exists, is new files under `app/features/workflows/`. C already renders `/workflows/{name}` from that folder.

### B — server route families and the CLI

0 partial, 0 not done.

Partial: none.

Not done: none.

Owns: `app/features/api/` (`handlers.py`, `records.py`, `urls.py`, and the non-event, non-git, non-webhook methods of `surface.py`), `app/cli.py`, `app/http/`, `app/engine/import_runs.py`, `app/engine/ui_state.py`, `app/engine/uploads.py`, `app/engine/fs_browse.py`, `app/engine/preview.py`, `app/engine/providers.py`, `app/engine/deferred.py`, `tests/test_api.py`, `tests/test_routes.py`, `tests/test_cli.py`, `tests/test_import_runs.py`.

Git, GitHub, webhook, and hook methods already on `surface.py` stay with D.

### C — Datastar screens, settings, and e2e

0 partial, 0 not done.

Skills auto-update and host telemetry are intentionally not ported. TypeScript does run skills auto-update after the server listens (at most once per six-hour window, unless `CEZ_SKILLS_AUTO_UPDATE=0` or Settings turns application off). This port does not. Adam can decide whether to port it. Host telemetry stays out.

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
