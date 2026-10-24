# cezar as an MCP server — the whole API as tools, for the coding agent on your desktop

> Status: built (2026-10-24) — see §9 for what the build settled. Branch: `brutus`.
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
- **Annotations:** `readOnlyHint` for GET routes; `destructiveHint` for every write unless its
  route-table entry says `destructive: false` (additive or trivially undone). Every write tool
  states it, so a new write route is destructive until someone decides otherwise.
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
- Scopes: `read` (allowlisted GETs), `runs.transcript` (`/runs/:id/events`, `/runs/:id/history`,
  `/runs/:id/history-context`: tool output can carry secrets, so `read` has only the run list and
  summary; `tasks` implies it), `tasks` (runs, messages, dispatch), `author` (workflows, skills,
  automations, env), `admin` (everything, including settings, self-update and terminals — a task
  terminal is a shell on the host, so `tasks` and `author` never include it: `ADMIN_ROUTES`).
- **A scope bounds the API surface, not the machine.** A token that can start or continue a run —
  `tasks`, and `author`, whose workflows and automations start them — can execute code as the OS
  user cezar runs as: agents run Bash, and a check step is a command. That user can read and write
  everything under `~/.cezar/`, so treat `tasks` and `author` as owner-equivalent on that machine.
  `read` is the only scope that executes nothing; it is the one to hand to anything shared.
- `GET /auth/tokens`, `DELETE /auth/tokens/:id`; last-used time shown.
- A Bearer token satisfies the auth guard like a session cookie, with its scope checked per
  route family; the request-origin guard (#426) is skipped for Bearer requests, because they
  are not browsers. Tokens never work for `/auth/*` management routes.

The CLI learns `cez --server https://<domain>` with `CEZ_TOKEN` (or `--token`, which shows in the
process list; `CEZ_SERVER` for the address), so
`cez task create` from a laptop talks to the VPS the same way the MCP server does.

## 5. Security

- The MCP endpoint is behind the same auth as the API; without a token or session it is 401.
- `tasks` and `author` are code execution as the cezar user (§4). What the server does stop is
  that turning into the cockpit's owner credential off the box: the host key
  (`~/.cezar/auth-host.key`, `0600`, readable by any task) is accepted only from a loopback
  request — loopback `Host` and socket, no `X-Forwarded-*`/`Forwarded`/`X-Real-IP`/`Origin` — so a
  key a task reads out and hands to a token holder opens nothing through the public front. The
  installer's owner probe therefore goes to the loopback upstream, not through nginx.
- A revoked or expired token ends the SSE streams it opened within one keepalive beat
  (`sseSessionEnded`); a token opens no WebSocket under sign-in, so there is none to end.
- Scopes are enforced server-side per route family, not by the tool list the client saw.
- Token hashes only; a lost token is recreated, never recovered.
- stdio `cezar mcp` on a local cockpit needs no token: it is the machine's owner, like the CLI.
- The generator never exposes a route the cockpit does not have; a tool is a route.

## 6. Zero config

Nothing new is exposed by default. On a cockpit with sign-in (every hosted one, unless
`CEZ_AUTH=0`), the HTTP MCP endpoint answers only to a session or a token the owner created. On a
local cockpit without sign-in — the zero-config default — it answers, like every other `/api/v1`
route, to any caller on this machine: the machine is the perimeter there, and the #426 origin
guard still refuses a foreign `Host` and a cross-site browser request. The stdio server is a
command the owner adds to their client. A `--server` naming another machine over plain `http://`
gets a warning (the token would travel in clear), and the docs prefer `CEZ_TOKEN` to `--token`,
which shows in the process list. No env var; `CEZ_SERVER`/`CEZ_TOKEN`
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

## 9. As built

- **The contract entry** is `packages/contract/src/routes.ts`: one `METHOD /path` row per
  `/api/v1` route (summary, `response`, optional `tool` name, `destructive`, `notTool` for
  streams, bytes, cockpit beacons, sign-in and `/mcp` itself). Inputs are read off the route's
  own validator middleware (`validators.ts` tags each with its schema), so a tool's input is
  what the route validates. `mcp/catalog.test.ts` fails on a route without a row and on a row
  without a route; `contract-parity.routes.test.ts` checks every `response` against the route's
  2xx body both ways at typecheck. Names derive from the path (`GET` list/get, `POST` on a
  collection `_create`, else the action, `PUT` `_put`, `PATCH` `_update`, `DELETE` `_delete`);
  a row's `tool` overrides it (`POST /workflows` is `workflows_put`, `POST /runs/:id/messages`
  `runs_send_message`). A response that is not an object travels as `{ result }`.
- **SDK**: `@modelcontextprotocol/server` 2.4 (`createMcpHandler`, stateless; it serves the
  2025 `initialize` handshake and the 2026-07-28 envelope). A tool call is a request through the
  whole app with the caller's own headers, so the guard checks the scope on the route.
- **`cezar mcp`** is a stdio↔HTTP bridge to the cockpit's `/api/v1/mcp`, not a second server:
  local default address and the host key, or `--server`/`--token`. `bridgeTarget()` in
  `mcp/cli.ts` is where `--as-run` (the chat spec) adds the task's own address and token.
- **Tokens are SHA-256-hashed**, like session tokens, not scrypt: the secret is 256 random bits,
  and a slow hash on every API request would cost ~128 MB and hundreds of milliseconds per call.
  Minting asks for a fresh authenticator code, like every other credential change; tokens are
  minted by the signed-in owner only (`409` on a cockpit without sign-in); a local cockpit's
  trusted operator lists and revokes them with or without sign-in, since they verify there too;
  and `cezar auth reset`, a password change and "sign out everywhere else" (`revoke-others`)
  revoke the user's tokens.
- **Scopes**: `read` is an ALLOWLIST of GET routes known to carry no secret (`READ_ROUTES`): no
  credential, config, secret name, env file, shell, service log or lifecycle output — those need
  the family's scope or `admin`, and a GET nobody listed is not `read`'s. Any token reads a task's
  files (`/runs/:id/files`) through the repository index, as `/repo/files` does for everyone;
  any token may read `projects`, `health` and `models` and reach the `/mcp` transport. The
  family map is `FAMILY_SCOPES` in `auth/api-tokens.ts`; an unmapped family is `admin`'s.
- **Origin guard**: only a token that VERIFIES skips it; an unverified Bearer is checked like
  any request and then refused by the auth guard.
- **The CLI**: `CEZ_SERVER`/`CEZ_TOKEN` are ignored inside a task and never forwarded into an
  agent's environment (`core/agent-env.ts`), and a local cockpit without sign-in treats a token
  it never minted (from a loopback Host) as no credential; the host key is only ever sent to a loopback cockpit; from a shell (no
  `CEZ_TASK_ID`) `cez task create` starts a top-level task (`--workflow`, `--runner`, `--model`).
