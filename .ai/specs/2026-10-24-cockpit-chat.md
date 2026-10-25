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
  everything it writes is a proposal (below).
- The run is launched with cezar's own MCP server injected through the private-MCP channel
  (stdio, `cezar mcp --tools all --as-run`), authenticated with the run token the task CLI
  already gets (`run-tokens.ts`), scoped to `author` for this project. So the chat can
  `runs_create`, `workflows_put`, `automations_create`, `repo_changes`… and nothing it does is
  a new code path: every action is a route the cockpit also calls.
- A chat run never ends at review: when its turn finishes it parks as `waiting` for the next
  message; it is archived like any run. One chat per project is pinned; **New chat** starts
  another. Previous chats are listed under the pinned one.
- **Everything a chat writes is a PROPOSAL** (decided 2026-10-25, after review: a chat that
  wrote live files could arm an automation, or override `quick-task` with a `git.push` chain and
  run it through its own `runs_create`). It writes a mirror of exactly `CHAT_WRITABLE` (contract
  `runs.ts`) — `.ai/cezar/workflows/**`, `skills/**`, `agents/**`, `automations.json`, `mcp.json`
  — under `.ai/cezar/proposals/<chatRunId>/`. No loader reads `proposals/`: workflows
  (`load.ts`), the automations store, personas and `mcp.json` read their own live paths only, so a
  proposal is inert. `proposals/` is ignored state in `.ai/cezar/.gitignore`; the owner's commit
  is what makes it repo content. The chat's `workflows_put` (`POST /workflows`, `/workflows/graph`)
  and `automations_create`/replace (`POST /automations`, `PUT /automations/:id`) write proposals
  too — an automation always `enabled: false`, `enable: true` refused, and an enabled live one
  never edited; enable, pause, run, check and delete, and `DELETE /workflows/:name`, are refused.
- The chat's **Changes** panel lists its proposals as diffs against the live files
  (`GET /repo/proposals/:chatId`) with **Apply & commit** — the owner only, a trusted operator
  under the Git page's checkout rules: it copies them into place, stages the repo files among them
  and commits them on the checked-out branch (`automations.json` is local state: it goes live
  but is not committed), refused while anything else is staged; an automation the proposal
  switches on is applied paused — and **Discard**. Application code and the rest of `.ai/cezar/`
  (`config.json`, `config.local.json`, `mcp.local.json`, `runs.json`, event files, `worktrees/`)
  are out of bounds even as proposals.
- The chat's `runs_create` takes only a workflow that is LIVE (loaded): a proposed workflow cannot
  run until applied, and inline `steps` are a `400` for it.
- Tasks the chat creates show up in the task list with `createdBy: chat:<runId>` and a chip in
  the chat linking to them; their status updates stream back into the chat as system notes
  ("task ffp-612 reached review").

## 4. API

```
POST /runs            kind: 'chat' (new optional discriminant on the create body; default 'task')
GET  /runs?kind=chat   (absent = tasks only; `all` = both)
GET  /repo/proposals/:chatId            the chat's proposals, as diffs (owner only)
POST /repo/proposals/:chatId/apply      copy into place, stage, commit (owner only)
POST /repo/proposals/:chatId/discard    throw them away (owner only)
```

Otherwise the chat is a run. `RunRecord.kind` is optional (old records parse as task).
Chats appear only when asked for: `GET /runs` without `?kind=` lists tasks (so `runs_list`,
`cez task list` and scripts never see a chat), and the runs index, the dashboard and the
archive-finished sweep leave chats out. The Chat view reads `?kind=chat`, overlaid with the run
list's live SSE copies.

## 5. Security

- The injected MCP token is the run's own, scoped to `author`, and its session launch's: each
  launch (the opening and every Continue) draws a fresh nonce onto the record (`launchNonce`) and
  signs it into the token, and the guard accepts the token only while the chat is running, not
  archived, and still holds that nonce. A relaunch, an archive (which clears it) or a delete
  revokes the previous token; a restart rotates the signing key and kills them all.
- Writes are proposals only (§3), by tool policy, the server and the prompt: `allowedTools` grants
  writes under its own `proposals/<id>/` only, and `disallowedTools` (which beats a repo's own
  allow rules under `dontAsk`) names `Bash`, `WebFetch`, `WebSearch`, `Agent`, `Task`,
  `NotebookEdit` outright and every write beside the path to its proposals — the checkout's
  top-level entries as they are at launch, `.ai/`'s, `.ai/cezar/`'s (the live configuration
  included) and other chats' proposals. A top-level file the checkout does not have yet is outside
  that list; `allowedTools` under `dontAsk` still refuses it unless the repo's own settings allow
  it. A chat cannot push, cannot open a PR, cannot change settings (`admin` scope is never granted
  to a run), and cannot apply or discard its own proposals.
- Only the owner starts a chat: `POST /runs { kind: 'chat' }` from a task's, a chat's or an API
  token is `403`; a signed-in user or the host (sign-in off) may.
- A task the chat starts goes through the review gate: `POST /runs` from a chat token is forced
  to its own worktree and `autonomous: false` (an in-place task lands, and pushes, on a
  `landing: auto` project), and a body asking for `worktree: false`, `autonomous`, `readOnly`,
  `newBranch`, `dispatch` or inline `steps` is a `400`. It runs once (`variants` is forced to 1),
  and a chat has at most two tasks in flight (queued, running or waiting) and starts at most five
  an hour — `409` beyond. The other launches are refused to it (`403`): an inbox start, an
  automation run, check, retry, enable or pause, and an automation that would be enabled.
- **A chat's tasks are ordinary tasks.** They run in their own worktree with the full default tool
  set — `Bash`, the network and the user's git credentials — exactly like a task the owner starts;
  the review gate is what bounds them, not the chat's token. That is inherent: a task that cannot
  run a shell cannot do the work.
- No secrets: the chat token is refused an env file's content, render and rerender, every env-file
  write, the secret store, the tracker connection and `/services` (a pinned command line can carry
  an inline secret); `GET /env-files` (paths and variable NAMES) stays readable. Nor the owner's
  transcripts: `runs.transcript` reaches only the tasks the chat started — `/runs/:id/{events,
  history,history-context,handoff}` need `createdBy: chat:<id>` like a write — every other run
  record reaches it projected (status, not text), and `GET /todos` (the inbox quotes the owner's
  tasks) is refused. It is also refused the tracker link (`PUT`/`DELETE /tracker/association`), a
  ticket transition, the automations webhook (`POST`/`DELETE /automation-webhook`) and
  `DELETE /todos/:id`. The prompt says so, and that file tools must not open `.env` files either.
- A chat changes only the tasks it started: every write under `/runs/:id/…` or
  `/groups/:groupId/…` from its token (messages, Continue, cancel, archive, PATCH, DELETE,
  remove-worktree, a pick) needs the run — or every run of the group — to carry
  `createdBy: chat:<its id>`, else `403` (the guard's `chatOwns`). Another chat and the chat
  itself carry none, so neither is ever a target; the bulk archive and read-all sweeps are refused.
- **The boundary, honestly.** The token bounds what the chat's MCP bridge can do, and the bridge
  is its only documented way to cezar: the agent's own environment carries no cockpit address
  (`CEZ_API_URL`, `CEZ_API_TOKEN` and `CEZ_BIN` are `''`; the bridge's entry has its own). On a
  hosted cockpit (sign-in enforced) that is the whole boundary — a tokenless loopback request is
  `401` there, so nothing but the chat token gets in. On a LOCAL cockpit without sign-in a
  request with no bearer is the owner, and a server-side fix would break every local CLI; there,
  for a backend that ignores `allowedTools` (Codex, OpenCode, Cursor), the boundary is the
  prompt — which tells the chat never to call the HTTP API itself — exactly as it is for any
  task today. Claude honours the tool policy, which has no shell.

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
  because `tsc` ships nothing it does not compile), the tool policy (`chatToolPolicy`, built per
  launch from `listChatTree` so its deny rules name what is beside the proposals now) and the MCP
  entry.
  `startRun` forces a chat in place and alone (no worktree, branch, read-only, autonomy, dispatch,
  fork ref or variants). `ActiveRun.chat` is set at BOTH construction sites; through it a chat
  takes no repo-root lease, gets the chat tools from the one `sessionTools` helper both session
  sites call, gets no dispatch/automations/services CLI prompt (its tools are MCP), never lands
  (`landingPolicy`, `land`, `landBeforeSettle`), never rests at review, and an idle close settles
  `done` instead of the inactivity failure — Continue reopens it.
- **"Author" scope.** `author` alone cannot `runs_create` (that is `tasks`'), so the chat's token
  carries `read`, `runs.transcript`, `tasks` and `author` (`CHAT_TOKEN_SCOPES`) — never `admin` —
  on its own project only, minus push, PR, land, Finish (which lands an in-place task), a task's
  file writes and `/workspace/*` (and the further refusals of §5). It is a run token with a third
  and fourth claim (`scope: 'author'`, the launch nonce) minted
  per session launch by `mintChatRunToken`, verified by the guard BEFORE the auth-off shortcut,
  so a local chat is bounded too; a task CLI's token is still minted only under enforced auth.
  `isRunLive` (running, unarchived, the record's `launchNonce`) is the token's lifetime.
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
- **Proposals.** `src/chat/proposals.ts` owns the mirror: listing with diffs (a small line
  diff, not git's — a proposal is often a file the checkout does not have), `disarmAutomations`
  (anything new or changed in `automations.json` applies paused), `proposeAutomation` (the chat's
  API create/replace, based on its own proposal or the live file) and `applyProposals` (copy,
  `git check-ignore` to keep local state out of the commit, stage, commit, put the live files back
  if the commit fails, drop what was applied). Routes: `GET /repo/proposals/:chatId`,
  `POST …/apply` (through `mutateCheckout`: trusted operator, no run principal, no in-place task
  busy, no landing) and `POST …/discard`; the repo family is `admin`'s, so no token but the
  owner's reaches them.
- **Brakes.** `chatTaskLimit` (`server.ts`) counts the chat's tasks by `createdBy`:
  `CHAT_TASKS_IN_FLIGHT` = 2, `CHAT_TASKS_PER_HOUR` = 5. `runViewScopesFor` gives a chat its own
  tasks whole and every other run projected; the guard's `chatMutationTarget` covers the
  transcript reads as well as the writes.
- **Cockpit.** `/chat` opens the pinned chat — the newest unarchived one, so New chat moves the
  pin without new state — `/chat/new` the first-message composer (project default agent, or one
  picked there; the thread's Continue pills switch it later), `/chat/:id` a chat. The thread is
  the task workspace's conversation column; the header carries the tasks' chips and Archive. The
  Changes panel reads the chat's proposals (re-read when a turn ends), shows each as a diff, and
  offers Apply & commit and, after a confirm, Discard. A chat parked `waiting` no longer counts as an in-place task
  busy in the checkout. Chats are left out of the Tasks lists, counts and unread badge.
- **Not done:** the dry-run and VPS checks of §8 need a real agent calling the tools (the bundled
  mock never calls MCP); the unit suites cover the launch spec and its argv, the token's bound,
  `createdBy`, the relay, the proposals (a chat-written `quick-task` override is not loaded, a
  chat cannot enable by POST or by file, Apply & commit makes a proposal live) and the panel.
