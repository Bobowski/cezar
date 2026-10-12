# Project services — the project's stack, started and watched from the cockpit

> Status: implemented (2026-10-12). Branch: `brutus`.
> Implementation: `packages/contract/src/services.ts`, `packages/cezar/src/services/`
> (`discover.ts`, `store.ts`, `manager.ts`, `cli.ts`), the `servicesRoutes` family in
> `server/server.ts`, `packages/web/src/routes/services/services.tsx`.
> As built, where it differs from the text below:
> - **States are `stopped | running | exited`.** `starting` and `stopping` are not observable: a
>   spawn answers at once and a stop drops the session at once (the tree gets SIGHUP, then SIGKILL
>   after 2 s, in the registry). A user's stop ends in `stopped`, not `exited`.
> - **§5's owner is a key, not a union**: the registry keeps its one string field (`runId`) and a
>   project or service session carries `project:<id>` / `service:<projectId>:<serviceId>` there.
>   Every existing terminal case passes unchanged.
> - **Discovery** walks three directories deep rather than reading declared workspaces (a repo
>   whose app lives in `app/` declares none at its root), and also offers `Makefile` targets.
> - **Routes added**: `POST /services/resume` (start exactly `lastRunning`).
> - **§4's page is master–detail in the shell** (owner, 2026-10-12): pins, candidates, Resume
>   and "Add a command" are the screen's list and render in the contextual sidebar; the main
>   area is the selected service — its command, state, addresses, actions — and its log.
> - **Agents**: the read-only guarantee is the run token's allowlist (`auth/run-tokens.ts`) — two
>   GETs and nothing else — plus a refusal on every lifecycle route for a run principal.
> Sibling: `2026-10-11-code-page.md` (the Code page docks this panel and shares §5's session owner).
> Builds on: `2026-10-07-task-workspace.md` §6 (PTY sessions), `2026-10-10-task-slots.md`,
> `2026-10-10-preview-gateway.md`, `2026-10-10-cezar-in-a-container.md`.

## 1. Problem

A real project is several long-lived processes: a handful of dev servers, `docker compose up`,
`stripe listen`. cezar can run each of them today only as a command typed into a TASK's terminal
tab. There is no terminal without a task, nothing remembers which commands make up the project,
and an agent cannot see whether the API is up or read why it crashed. So the stack lives in
VS Code's terminal panel or a tmux window — one of the reasons to leave cezar.

Docker and the Stripe CLI are not special cases. From cezar's side each is a command that stays
running, prints logs, and sometimes opens a port. This spec treats them as exactly that.

## 2. Decisions taken with the owner (2026-10-11)

| Question | Decision |
| --- | --- |
| How does cezar know what a service is? | **Discovery plus local pins.** Candidates come from the repo; the user pins the ones they use or adds a custom command. Pins are cezar-written state under `.ai/cezar/`, outside git. |
| Lifecycle | **Manual start; services die with cezar.** They survive a closed browser tab. After a restart cezar offers to resume what was running. No autostart. |
| Per-task stacks | **Not in v1.** Services run on the project's main checkout only. §9 records the follow-up. |
| Agent access | **Read-only**: status and logs. An agent cannot start, stop or restart. |

## 3. Behaviour

### 3.1 Candidates (discovery)

Read on demand, never cached to disk, each source optional:

| Source | Candidate |
| --- | --- |
| `package.json` at the repo root and in each workspace it declares | One per script. Scripts named `dev`, `start`, `serve`, `watch`, `worker` or prefixed with one of those (`dev:api`) are listed first; the rest sit behind "Show all scripts". Run through the lockfile's package manager (`npm run`, `pnpm`, `yarn`, `bun`), `cwd` = the package's directory. |
| `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` at the root | One per file: `docker compose -f <file> up`, attached. Attached on purpose — logs stream into the same view and stopping the process stops the containers. |
| `Procfile` | One per line. |

A candidate whose executable is missing (`docker` not on `PATH`) is listed disabled with the
reason. No source present means an empty list and the "Add a command" form — never an error.

### 3.2 Pins

A pin is `{ id, name, command, cwd }`, `cwd` relative to the repo root. Pinning a candidate copies
its command, so a later rename of the script shows up as a failing start, not a silent change.
"Add a command" creates a pin with no source (`stripe listen --forward-to localhost:3000/webhooks`).

Stored in `<repo>/.ai/cezar/services.json`, `0600`, atomic tmp+rename, every field optional with
`.catch`, per-entry salvage. The same file carries `lastRunning: string[]` (§3.4). Absent or
corrupt file = no pins, one warning. **`services.json` and its temp name must be added to
`DATA_GITIGNORE_ENTRIES`** (`src/data-gitignore.test.ts` will fail otherwise).

### 3.3 Running

Start, Stop, Restart per service; Start all / Stop all for the pinned set. Each running service is
one PTY session (§5), so it has what a terminal tab has: scrollback, the process-group kill,
detected URLs. The log view is a terminal — the user can type into it (`r` to restart Vite,
a pairing prompt from `stripe listen`).

Environment: the same one a workspace terminal gets on the main checkout, with `CEZ_TASK_SLOT`
and `CEZ_TASK_PORT_BASE` present and empty (the shared stack, per the task-slots spec §2). Project
secrets from the vault are NOT injected in v1 — the main checkout has its own env files.

A detected URL is shown on the row and opens in the Code page's Preview column (or through the
preview gateway on a hosted cockpit).

### 3.4 States and who fires each transition

| From | To | Fired by |
| --- | --- | --- |
| stopped / exited | starting | the user (Start, Start all, Resume) |
| starting | running | the PTY spawn returning |
| starting | exited | spawn failure — carries the one-line reason |
| running | stopping | the user (Stop, Stop all, Restart), or cezar shutting down |
| stopping | exited | the process group ending; after 5 s of grace, `SIGKILL` to the group |
| running | exited | the process ending on its own — carries the exit code |

`running` means "the process is alive", nothing more. There is no health probe and no automatic
restart in v1: a crashed service stays `exited` with its code and last output until the user acts.
That is deliberate — an auto-restart loop is a state nobody asked to enter.

**Shutdown.** `SIGINT`/`SIGTERM`/normal exit of cezar stops every service through the same group
kill. A hard kill of cezar leaves no cezar to do that: on POSIX the PTY closing delivers `SIGHUP`
to the group; on Windows node-pty's job object ends the tree. Compose containers can outlive a hard
kill — the next attached `docker compose up` adopts them, which is the recovery.

**Resume.** `lastRunning` is rewritten on every start and stop. On boot, if it is non-empty, the
Services view shows "N services were running — Resume" and nothing starts until that is clicked.

## 4. Surfaces

- **`/p/:projectId/services`** — pinned services on the left with state, port and uptime; the
  selected service's log on the right; candidates below the pins.
- **Code page dock** — the same list and log as a tab beside Terminal in the bottom panel.
- **Sidebar** — the Services nav item carries the running count; an `exited` non-zero service
  turns it into a warning dot.
- **Agents** — `cez service list` and `cez service logs <name> [--tail N]`, thin HTTP clients over
  the routes below, addressed by `CEZ_API_URL` / `CEZ_PROJECT_ID` like `cez tracker`. A task's
  system prompt mentions them only when the project has at least one pin, and says plainly that
  **these services run the main checkout's code, not the task's worktree**. That prompt part has
  two construction sites — `execute` and `runContinuation` — and goes through one helper.
  Log content reaches an agent as untrusted reference data and passes the run's secret redaction.

## 5. Mechanism — one session owner instead of `runId`

`TerminalSessions` keys every session by `runId`. Both this spec and the Code page need sessions
that belong to a project. The key becomes an owner:

```ts
type SessionOwner =
  | { kind: 'run'; runId: string }
  | { kind: 'project'; projectId: string }               // Code page terminal
  | { kind: 'service'; projectId: string; serviceId: string }
```

`listFor`, the WS cursor topic and the reaper take the owner. `MAX_SESSIONS = 32` stays the bound
for interactive tabs; services get their own bound (24) so a full stack cannot lock the user out
of a terminal. Output keeps travelling over HTTP with a cursor; the WebSocket carries the cursor
only (workspace spec §6). Service STATE changes publish a version counter on a
`services:<projectId>` topic — demand-driven, no names or output on the bus.

When the optional PTY binding did not load, services are unavailable with the same reason the
terminal gives. No pipe-based fallback: "stop" must mean the whole tree.

## 6. API (contract first, chained into one `servicesRoutes` family, both mounts)

| Route | Purpose |
| --- | --- |
| `GET /services` | `{ available, reason?, services[], candidates[], lastRunning[] }` |
| `POST /services` | pin a candidate or add a custom command |
| `PATCH /services/:id`, `DELETE /services/:id` | rename / edit / unpin (delete refuses while running) |
| `POST /services/:id/start` · `/stop` · `/restart` | lifecycle |
| `POST /services/start-all` · `/stop-all` | the pinned set |
| `GET /services/:id/output?cursor=` · `POST /services/:id/input` · `/resize` | the terminal family's shapes, reused |
| `GET /services/:id/logs?tail=` | plain text tail for `cez service logs` |

Schemas live in `packages/contract/src/services.ts`; routes are inventoried in
`BACKWARD_COMPATIBILITY.md` §2 and covered by `contract-parity` and `route-parity`.

## 7. Exposure and gating

Starting a pinned command is running a shell command, so it follows the **existing `terminal`
capability** — on for a local cockpit, off for a hosted one unless `CEZ_TERMINAL=1`, off
everywhere under `=0`. No new `CEZ_*` variable; `.env.example` and the env table in
`docs/reference.md` gain one sentence saying `CEZ_TERMINAL` now also governs services. Every
route re-checks the policy per request, reads included, as the terminal family does.

The agent routes are read-only by construction: `cez service` has no write subcommand and the
lifecycle routes reject a request carrying a task identity.

## 8. Defaults applied without asking (override before implementation)

| Question | Default | Why |
| --- | --- | --- |
| One row per compose file, or per container? | Per file. | `docker compose up` already interleaves and prefixes logs; a per-container model needs `docker compose ps` polling and its own states. |
| Health checks / readiness? | None. | "Alive" is true on every stack; a probe needs per-service configuration. |
| Auto-restart on crash? | No. | See §3.4. |
| Inject vault secrets? | No. | The vault's rule is "never to agents"; services are user processes, but agents can read their logs. Needs its own decision. |
| Docker when cezar itself runs in a container? | Out of scope. | Needs the host's Docker socket mounted — an exposure decision that belongs to the container spec. |

## 9. Not in v1

Per-task stacks (the same pins started in a task worktree with its slot — the reason the env
contract in §3.3 already names the slot variables), autostart, agent-initiated restart, health
probes, per-container rows, committing pins to the repo for a team.

## 10. Verification

- Unit: discovery per source incl. absent/corrupt inputs; `services.json` salvage; the state table
  in §3.4, one case per row; owner-keyed session listing.
- A regression guard for the task terminal: every existing `terminal-routes` case passes unchanged
  after the owner refactor.
- Gitignore cross-check, contract parity, route parity, BC inventory.
- E2E (dry run): pin a fixture script, start it, see output, stop it, restart cezar, see Resume.
- Windows: start/stop of an npm script that spawns a child — the tree must be gone.
