# cezar as an MCP server — the whole API as tools, for the coding agent on your desktop

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `packages/contract` (every request and response is a zod schema — the tool
> catalog is generated from it), `2026-10-12-cockpit-authentication.md` (owner sign-in;
> `run-tokens.ts` for a task's own CLI), `2026-09-10-dispatch.md` (`cez task create`, the one
> agent-facing write path today), `2026-10-24-cockpit-chat.md` (the second client).
> Backlog item: "a cezar MCP — add my cezar to Claude Code and launch tasks, build workflows…"

## 1. Problem

The owner works in Claude Code on the desktop and in the cockpit on the VPS. Starting a task,
checking what reached review, or writing a workflow for a project means switching to the
cockpit. Every one of those is an HTTP route with a typed contract; nothing exposes them to an
agent except `cez task create`, which only a run inside cezar can call.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Clients | **Claude Code / Codex on the owner's desktop** (the chat spec adds the cockpit's own chat) | Agents inside tasks keep `cez task …`; scripts can use the same tokens over plain HTTP. |
| Tool surface | **The whole API, 1:1, generated from the contract** | No hand-written tool drifts from a route; the contract already carries descriptions. |
| Auth from outside | **Owner API tokens** (Bearer), scoped, revocable | One credential for MCP over HTTP and for `cez --server`. |

## 3. The server

`cezar mcp` (stdio, for a local cockpit) and `POST/GET /api/v1/mcp` (Streamable HTTP, for a hosted
one) serve the same catalog:

- **One tool per route**, named `<family>_<verb>_<noun>` from the route manifest
  (`route-parity.test.ts`' manifest already names every family and path):
  `runs_create`, `runs_get`, `runs_send_message`, `workflows_put`, `automations_create`,
  `repo_changes`, `docker_stacks_stop`… Path params, query and body merge into one input
  schema; the output schema is the route's response. Both are the contract's zod converted to
  JSON Schema at build time — the generator fails the build when a route has no contract entry,
  which is the parity test's rule restated for tools.
- **Project scope** is an input (`projectId`, default: the boot project), so one server covers
  the workspace.
- **Annotations:** `readOnlyHint` for GET routes, `destructiveHint` for `DELETE` and for the
  routes the cockpit confirms (discard, docker remove, branch delete).
- **Resources:** `cezar://projects`, `cezar://p/<id>/runs/<runId>/thread` (the thread as
  Markdown), `cezar://p/<id>/workflows/<name>` — the read-often shapes an agent wants to
  browse rather than call.
- **Prompts:** `new-task`, `write-workflow` — short templates that tell the client which tools
  to use in which order.

Two hundred tools is a lot of context; the catalog therefore ships **tool sets**: the client
connects with `?tools=tasks,repo` (or `--tools` for stdio) and gets that subset; `all` is the
full list; the default set is `tasks,workflows,skills,projects` (about thirty tools).

## 4. API tokens

Settings → Security → **API tokens** (owner only):

- `POST /auth/tokens { name, scopes, expiresAt? }` → the token value, shown once
  (`ceztok_<id>_<secret>`); stored hashed (argon2, the password store's hash) in the auth store.
- Scopes: `read` (GET), `tasks` (runs, messages, dispatch), `author` (workflows, skills,
  automations, env), `admin` (everything, including settings and self-update).
- `GET /auth/tokens`, `DELETE /auth/tokens/:id`; last-used time shown.
- A Bearer token satisfies the auth guard like a session cookie, with its scope checked per
  route family; the request-origin guard (#426) is skipped for Bearer requests, because they
  are not browsers. Tokens never work for `/auth/*` management routes.

The CLI learns `cez --server https://<domain> --token <…>` (or `CEZ_SERVER` / `CEZ_TOKEN`), so
`cez task create` from a laptop talks to the VPS the same way the MCP server does.

## 5. Security

- The MCP endpoint is behind the same auth as the API; without a token or session it is 401.
- Scopes are enforced server-side per route family, not by the tool list the client saw.
- Token hashes only; a lost token is recreated, never recovered.
- stdio `cezar mcp` on a local cockpit needs no token: it is the machine's owner, like the CLI.
- The generator never exposes a route the cockpit does not have; a tool is a route.

## 6. Zero config

Nothing on by default: the HTTP MCP endpoint answers only to a token the owner created. The
stdio server is a command the owner adds to their client. No env var; `CEZ_SERVER`/`CEZ_TOKEN`
are client-side conveniences documented in `.env.example`.

## 7. Not done here

- Agents inside tasks as MCP clients (they keep `cez task …`; a later pass can inject this
  server through the private-MCP channel).
- OAuth device flow.
- Streaming SSE events as MCP notifications (polling `runs_get` is enough for v1).

## 8. Verification

- Unit: the generator over the route manifest — every route yields a tool with a JSON schema
  equal to its contract; a route without a contract fails; tool sets partition; scope map
  covers every family.
- Token store: hash, verify, revoke, expiry, scope check per family; Bearer bypasses the
  origin guard and nothing else.
- An MCP conformance run with the reference client against a dry-run server: list tools,
  call `runs_create`, read a thread resource.
- VPS: add `https://agents.kinel.dev/api/v1/mcp` to desktop Claude Code with a `tasks` token;
  create a task on fancy-fence-panels from the desktop; read its thread when it reaches review.
