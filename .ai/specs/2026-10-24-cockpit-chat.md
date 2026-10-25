# The cockpit chat — a run without a worktree that knows cezar

> Status: built (2026-10-25) — see §9. Branch: `brutus`.
> Builds on: `2026-10-24-cezar-mcp-server.md` (the tools it uses), `2026-10-20-trunk-based-projects.md`
> (`worktree: false` runs in the checkout), `2026-10-07-private-project-mcp.md` (how a run is
> handed MCP servers at launch), `2026-10-11-code-page.md` (the agent pane, which this replaces
> as the "talk to cezar about this project" surface).
> Backlog item: "…or instead a general cezar chat: create me a workflow… etc."

## 1. Problem

"Make me a workflow that runs e2e after every implement step", "which tasks touched the
checkout module this week", "start three variants of this on Codex" — questions and requests
about cezar itself, inside a project. Today they are clicks in Settings, or a task that does
not know what cezar is.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Build it at all | **Yes, beside the MCP server** | The owner wants both; the chat is the MCP's second client. |
| Engine | **An ordinary run, `worktree: false`, cwd = the project checkout, with cezar's MCP injected** | Same backends and models as tasks; it can read the repo, write `.ai/cezar/*`, and create tasks. |

## 3. Behaviour

- A **Chat** entry in the project sidebar opens a thread that looks like a task thread without
  the Changes/Preview columns. The first message starts a run with `kind: 'chat'`,
  `worktree: false`, no review gate, no PR, the project's default backend and model (switchable
  in the thread header), and the system prompt `builtin/cezar-chat.md`: what cezar is, which
  tools it has, that it must create a task rather than edit application code itself, and that
  it may write under `.ai/cezar/` (workflows, skills, automations, personas) directly.
- The run is launched with cezar's own MCP server injected through the private-MCP channel
  (stdio, `cezar mcp --tools all --as-run`), authenticated with the run token the task CLI
  already gets (`run-tokens.ts`), scoped to `author` for this project. So the chat can
  `runs_create`, `workflows_put`, `automations_create`, `repo_changes`… and nothing it does is
  a new code path: every action is a route the cockpit also calls.
- A chat run never ends at review: when its turn finishes it parks as `waiting` for the next
  message; it is archived like any run. One chat per project is pinned; **New chat** starts
  another. Previous chats are listed under the pinned one.
- Files it writes appear in the Changes tab of the chat (the checkout's diff, filtered to the
  chat's files) with **Commit** (trunk-based commit to base) and **Revert**. It may write
  exactly `CHAT_WRITABLE` (contract `runs.ts`): `.ai/cezar/workflows/**`, `.ai/cezar/skills/**`,
  `.ai/cezar/agents/**`, `.ai/cezar/automations.json` and `.ai/cezar/mcp.json` — the
  configuration an owner reviews and commits. Application code and the rest of `.ai/cezar/`
  (`config.json`, `config.local.json`, `mcp.local.json`, `runs.json`, event files, `worktrees/`)
  are out of bounds: the chat's `allowedTools` grant only that list and its `disallowedTools`
  name the rest of `.ai/cezar/` on backends that honour them (Claude); the prompt names the same
  list on those that do not.
- Tasks the chat creates show up in the task list with `createdBy: chat:<runId>` and a chip in
  the chat linking to them; their status updates stream back into the chat as system notes
  ("task ffp-612 reached review").

## 4. API

```
POST /runs            kind: 'chat' (new optional discriminant on the create body; default 'task')
GET  /runs?kind=chat
```

No other routes: the chat is a run. `RunRecord.kind` is optional (old records parse as task).

## 5. Security

- The injected MCP token is the run's own, scoped to `author`, dies with the process.
- Writes are limited to `CHAT_WRITABLE` by tool policy and prompt; a chat cannot push, cannot
  open a PR, cannot change settings (`admin` scope is never granted to a run).
- A task the chat starts goes through the review gate: `POST /runs` from a chat token is forced
  to its own worktree and `autonomous: false` (an in-place task lands, and pushes, on a
  `landing: auto` project), and a body asking for `worktree: false`, `autonomous`, `readOnly`,
  `newBranch` or `dispatch` is a `400`. The other launches are refused to it (`403`): an inbox
  start, an automation run, check, retry or enable, and a `PUT` that leaves an automation
  enabled — the chat drafts a paused automation and the owner switches it on.
- No secrets: the chat token is refused an env file's content, render and rerender, every env-file
  write, the secret store and the tracker connection; `GET /env-files` (paths and variable NAMES)
  stays readable. The prompt says so, and that file tools must not open `.env` files either.
- Hosted: the chat is behind sign-in like every run.

## 6. Zero config

The sidebar entry exists when the project exists; nothing to enable. Default backend and
model are the project's.

## 7. Not done here

- A workspace-wide chat (no run without a project today).
- Voice.
- Chat-authored changes outside `.ai/cezar/` (that is a task).

## 8. Verification

- Unit: `kind: 'chat'` launches with `worktree: false`, the builtin prompt, the MCP injection
  and the `author` token; the review gate is skipped; the Changes filter; `createdBy` linkage.
- Dry run: "create a workflow that…" → `workflows_put` called with valid YAML → file appears in
  `.ai/cezar/workflows/`; "start a task…" → a run exists with `createdBy`.
- VPS: ask the chat for a workflow for fancy-fence-panels, commit it, start a task with it from
  the chat, watch it reach review in the same thread.

## 9. As built

- **The run.** `src/chat/chat.ts` holds what a chat has that a task does not: `CHAT_WORKFLOW`
  (one agent step on `{{task}}`), the prompt (the spec's `builtin/cezar-chat.md`, a TS module
  because `tsc` ships nothing it does not compile), `CHAT_ALLOWED_TOOLS` and the MCP entry.
  `startRun` forces a chat in place and alone (no worktree, branch, read-only, autonomy, dispatch,
  fork ref or variants). `ActiveRun.chat` is set at BOTH construction sites; through it a chat
  takes no repo-root lease, gets the chat tools from the one `sessionTools` helper both session
  sites call, gets no dispatch/automations/services CLI prompt (its tools are MCP), never lands
  (`landingPolicy`, `land`, `landBeforeSettle`), never rests at review, and an idle close settles
  `done` instead of the inactivity failure — Continue reopens it.
- **"Author" scope.** `author` alone cannot `runs_create` (that is `tasks`'), so the chat's token
  carries `read`, `runs.transcript`, `tasks` and `author` (`CHAT_TOKEN_SCOPES`) — never `admin` —
  on its own project only, minus push, PR, land, Finish (which lands an in-place task), a task's
  file writes and `/workspace/*`. It is a run token with a third claim (`scope: 'author'`) minted
  per session launch by `mintChatRunToken`, verified by the guard BEFORE the auth-off shortcut,
  so a local chat is bounded too; a task CLI's token is still minted only under enforced auth.
  `isRunLive` is the token's lifetime, so it dies with the session.
- **MCP.** `privateMcpForLaunch` appends the `cezar` stdio server (`node $CEZ_BIN mcp --tools all
  --as-run`, env `CEZ_API_URL`/`CEZ_API_TOKEN`/`CEZ_TASK_ID`/`CEZ_PROJECT_ID`) to the private
  servers at both session sites, replacing a private server of the same name. `--as-run` refuses
  to start without the run's token, and never sends the host key. Over `/api/v1/mcp` a chat
  principal is listed only the tools its token reaches, and scoped tools default to its project.
  Without `CEZ_API_URL` (headless) or on a backend with no launch-time channel the chat runs
  without it and says so in a note and in its prompt.
- **createdBy.** `POST /runs` stamps `createdBy: chat:<id>` from the caller's chat token, never
  from the body; a chat cannot start a chat (`403`). The status relay (`relayChatStatusNotes`,
  owned by the `RunManager`) appends a `note` with `taskId` to the chat when such a task reaches
  `waiting`, `review`, `done`, `failed` or `cancelled`; the first sighting after a boot is its
  baseline, so a restart replays nothing.
- **Cockpit.** `/chat` opens the pinned chat — the newest unarchived one, so New chat moves the
  pin without new state — `/chat/new` the first-message composer (project default agent, or one
  picked there; the thread's Continue pills switch it later), `/chat/:id` a chat. The thread is
  the task workspace's conversation column; the header carries the tasks' chips and Archive. The
  Changes panel reads `GET /repo/status`, keeps `.ai/cezar/` files, and commits them on the
  checked-out branch with `/repo/stage` + `/repo/commit` (disabled while anything else is
  staged), or reverts them with `/repo/unstage` + `/repo/discard` after a confirm — the Git page's
  routes, so no route was added. A chat parked `waiting` no longer counts as an in-place task
  busy in the checkout. Chats are left out of the Tasks lists, counts and unread badge.
- **Not done:** the dry-run and VPS checks of §8 need a real agent calling the tools (the bundled
  mock never calls MCP); the unit suites cover the launch spec, the token's bound, `createdBy`,
  the relay and the panel.
