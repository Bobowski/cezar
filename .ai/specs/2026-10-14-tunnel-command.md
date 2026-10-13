# The tunnel command — a project's ports, forwarded with one copied line

> Status: proposed (2026-10-14), not built. Branch: `brutus`.
> Builds on: `2026-10-11-project-services.md` (detected URLs), `2026-10-13-docker-view.md`
> (published ports), `2026-10-10-task-slots.md` (worktree port ranges),
> `2026-10-10-preview-gateway.md` §7 (the limit this works around).

## 1. Problem

On a VPS the project's stack listens on the server's `localhost`. The preview gateway re-serves
an app on another origin, which breaks exactly the things a real project depends on: an OAuth
client that allows `http://localhost:3000` and nothing else, a storefront with
`http://localhost:9000` baked into its bundle, a backend whose CORS list names `localhost:8000`.

An SSH local forward on the SAME port numbers makes the viewer's `localhost:3000` the server's.
Nothing in the project changes. What is missing is the command: the user has to remember which
ports this project uses and retype them per machine.

## 2. Decisions taken with the owner (2026-10-14)

| Question | Decision |
| --- | --- |
| How is a remote stack looked at, for now? | **An SSH tunnel on identical port numbers.** A browser running on the server (streamed to the cockpit) is the later answer; hostnames per port are rejected — they need a second OAuth origin. |
| Does the user keep a list of forwards? | **Mostly no.** cezar derives the ports from what it already knows and offers the command to copy. A short per-project list covers what it cannot see. |
| Local port ≠ remote port? | **Never offered.** A different local number is a different origin, which defeats the tunnel. |

## 3. Behaviour

Services gains a **Tunnel** block (sidebar, under the pinned list): one `ssh` line and a Copy
button.

```
ssh -N -L 8000:localhost:8000 -L 9000:localhost:9000 -L 4321:localhost:4321 kinel@agents.kinel.dev
```

### 3.1 Where the ports come from

| Source | Included by default |
| --- | --- |
| URLs a running pinned service printed (`service.urls`, loopback only) | yes |
| Host ports published by containers of THIS project's stacks (`mine` in the Docker view) | yes for HTTP-looking ports; **no** for well-known data ports (5432, 6379, 3306, 27017, 7700…) |
| The cockpit's own port | yes — it is what makes the tunnelled cockpit a local one (§5) |
| The project's extra ports (§3.2) | yes |

Each port is a checkbox; the command is rebuilt from the checked ones. A data port is listed
unchecked with the reason ("your machine may run its own Postgres"). Ports are de-duplicated and
sorted. No port known means no block — never an empty command.

### 3.2 Extra ports

A per-project list `{ port, note? }` for what cannot be discovered: a service that is not running
yet, one that prints no address, a worktree's slot range. Stored in
`<repo>/.ai/cezar/tunnel.json` (`0600`, atomic tmp+rename, every field optional with `.catch`,
per-entry salvage) — cezar-written state, outside git, and **added to `DATA_GITIGNORE_ENTRIES`**.
Absent or corrupt file = no extras.

A slot range is entered as a slot number, not a hundred ports: it adds the forwards a task of
that slot actually printed (its terminal's detected URLs), not `-L` × 100.

### 3.3 The destination

`<user>@<host>`: the user is the account cezar runs as (`os.userInfo().username`); the host is the
hostname the cockpit was opened with (`location.hostname`, never sent to the server). On a cockpit
opened at `localhost` the block says there is nothing to tunnel to and shows no command.

An SSH port other than 22, a jump host or a key file are the user's `~/.ssh/config` — the block
offers the same forwards as a `Host` stanza (`LocalForward` lines) beside the one-liner.

## 4. States and who fires each transition

The command is a pure function of (running services' URLs, this project's published container
ports, extras, checked set). It changes when a service starts or stops (`services:<projectId>`
topic), a container does (`docker` topic), or the user edits extras or a checkbox. Nothing is
polled for it and nothing is persisted but the extras and the unchecked set.

## 5. The tunnelled cockpit is a local cockpit

cezar decides local vs hosted by the address it BINDS, not the one it is reached at. Bound to
`127.0.0.1` on the server and reached through `-L 4321:localhost:4321`, it is a local cockpit:
the Browser column frames `localhost:3000` directly, Design Mode works, and the server exposes
nothing but SSH. **This is asserted from the code, not yet run on a VPS** — verifying it is the
first step of the build, and the spec's default changes if it does not hold.

## 6. API (contract first, chained into `servicesRoutes`, both mounts)

| Route | Purpose |
| --- | --- |
| `GET /services/tunnel` | `{ available, reason, user, ports: [{ port, source, label, default }], extras: [{ port, note }] }` |
| `PUT /services/tunnel` | replace `extras` and the unchecked set |

`source` is one of `service | container | cockpit | extra`. The command string is assembled in
the cockpit — the host is the browser's knowledge. Schemas in `packages/contract/src/services.ts`;
inventoried in `BACKWARD_COMPATIBILITY.md` §2; covered by contract parity and route parity.

## 7. Exposure and gating

The answer names the server's user and its listening ports, so every route follows the terminal
policy (`CEZ_TERMINAL`), reads included, and refuses a task's own credential — neither route joins
the run-token allowlist. No new `CEZ_*` variable. cezar never runs `ssh` and never opens a
listener for this: it prints a line the user runs on their own machine.

## 8. Not in v1

- A browser on the server streamed to the cockpit (the answer for phones and for "one window").
- Starting the tunnel for the user (a local helper process is a daemon to manage).
- Reverse forwards (`-R`) for webhooks: `stripe listen` already runs on the server.
- Per-machine checked sets: the unchecked set is the project's, not the laptop's.

## 9. Verification

- Unit: port derivation per source; data ports unchecked by default; de-duplication; `tunnel.json`
  salvage; no ports → no block; a `localhost` cockpit → no command.
- Gitignore cross-check, contract parity, route parity, BC inventory.
- Cockpit: the line rebuilds on a checkbox, Copy copies exactly what is shown, the `Host` stanza
  carries the same ports.
- On the VPS: §5 — a tunnelled cockpit frames `localhost:3000` in the Browser column, and a
  Google sign-in with `http://localhost:3000` as its only allowed origin completes.
