# The cockpit chat — a run without a worktree that knows cezar

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
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
- Files it writes in `.ai/cezar/` appear in the Changes tab of the chat (the checkout's diff,
  filtered to that directory) with **Commit** (trunk-based commit to base) and **Revert**.
  Application code is out of bounds: the chat's `allowedTools` deny `Edit`/`Write` outside
  `.ai/cezar/` on backends that honour them, and the prompt says so on those that do not.
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
- Writes are limited to `.ai/cezar/` by tool policy and prompt; a chat cannot push, cannot
  open a PR, cannot change settings (`admin` scope is never granted to a run).
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
