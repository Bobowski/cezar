# The Code page terminal — detected addresses, project commands, clickable links, completion, and the gateway

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `2026-10-11-code-page.md` (the bottom panel's project terminal),
> `2026-10-07-task-workspace.md` §6–§7 (the two strips the TASK terminal already has:
> `task-workspace/terminal-extras.tsx`, `detectedUrlSchema`, `discoveredCommandSchema`),
> `2026-10-10-preview-gateway.md` (ports 8500–8519 and the ticket), `2026-10-14-tunnel-command.md`
> (the ssh line for what the gateway cannot carry), `2026-10-17-task-palette.md`.
> Backlog item: "terminal on the Code page — command hints and links to services (localhost:3000…)".

## 1. Problem

The task workspace's terminal drawer wears two strips: the addresses this task's shells printed
(probed, with **Open in Browser**) and the commands its project defines (one click runs one in a
new tab). The Code page's project terminal has neither — it is a bare xterm. And on the VPS a
printed `http://localhost:3000` is an address on the server: clicking it in the viewer's browser
opens nothing, and there is no hint that the same page lives at `https://<domain>:85xx` behind
a gateway ticket.

## 2. Decisions

| Question | Decision |
| --- | --- |
| What the Code terminal gets | **All four**: the two strips, clickable links in the output, completion while typing, gateway mapping on a hosted cockpit. |

## 3. Behaviour

### 3.1 The two strips

`DetectedUrlsStrip` and `DiscoveredCommandsStrip` are lifted out of `task-workspace/` into
`components/terminal/` and take a **scope** instead of a `runId`: `{ kind: 'run', runId }` or
`{ kind: 'project' }`. Server side, the project terminal family (`/repo/terminal…`) gains
`GET /repo/terminal/urls` and `GET /repo/terminal/commands`, the same shapes as the run
routes (`detectedUrlsSchema`, `discoveredCommandsSchema`), computed over the project terminals'
output and the main checkout's manifests. **Open in Browser** opens a Browser editor tab on the
Code page (not a column). Nothing opens or runs on its own — the task spec's rule stands.

### 3.2 Links in the output

xterm's `@xterm/addon-web-links`, with a custom handler: a loopback or gateway address opens a
Browser tab in Code; anything else opens a new window (the Browser tab is for the project's own
app — browser-tabs spec). The regex also catches `localhost:3000` without a scheme and
`0.0.0.0:<port>` (a bound address that means loopback to the viewer).

### 3.3 Completion while typing

Cockpit-side, never in the shell: a small popover under the cursor row, fed by three sources,
shown after `Tab` or when the typed prefix has ≥ 2 characters and a pause of 300 ms:

| Source | Items |
| --- | --- |
| Discovered commands (§3.1) | `npm run dev`, `make test`, `docker compose up` … |
| Project history | the last 500 lines the user typed in THIS project's terminals, deduped, newest first — stored in `.ai/cezar/terminal-history.json` (gitignored; `ensureDataGitignore`) |
| Paths | one level of the checkout tree for the token under the cursor (the Code page already has the tree) |

`Tab` accepts (writes the remainder into the pty, as if typed), `Esc` hides, `Ctrl+R` opens the
history list with a filter. Nothing is sent to the shell except the accepted text — the popover
is drawn over xterm, the shell's own completion keeps working when the popover is closed.

### 3.4 The gateway, on a hosted cockpit

Each detected or linked loopback address is resolved through the preview gateway when the
cockpit is hosted (`capabilities().localHandoff === false`): the strip shows
`localhost:3000 → :8502` and **Open in Browser** opens the gateway address with a fresh ticket,
exactly as the task Preview column does today. When no gateway port is free, or the address is
one the gateway cannot carry (preview-gateway §7: an app that calls another loopback port by
absolute address), the strip offers **Copy tunnel command** — the ssh line from the tunnel
spec, built from the same port list — instead of a dead link.

## 4. API

```
GET /repo/terminal/urls       → detectedUrlsSchema       (project terminals)
GET /repo/terminal/commands   → discoveredCommandsSchema (main checkout)
GET /repo/terminal/history    → { lines: string[] }      (this project, capped at 500)
```

Chained onto the existing `repo` family, both mounts, contract in `terminal.ts`. The run routes
are untouched. The gateway resolution reuses the preview routes (`preview.ts`); no new ticket
shape.

## 5. Security

- Completion items come from the project's own files and the user's own history — the
  history file is per project under `.ai/cezar/`, never shared across projects or sent anywhere.
- Links open only loopback/gateway addresses inside the cockpit; everything else is a plain
  new-window open with `noopener`.
- The gateway ticket rules are unchanged: one page load, under a minute, signed-in only.

## 6. Zero config

No settings. History is state (delete the file, it refills). The hosted mapping needs the
gateway that `CEZ_PREVIEW_PORTS` already configures for the VPS image.

## 7. Not done here

- Shell-side completion (bash-completion, fish) — different per shell, this is the cockpit's.
- AI command suggestions ("what should I run?") — the agent pane is beside the terminal.
- Multi-project history.

## 8. Verification

- Unit: scope-aware strips render from fixtures; link regex (with and without scheme,
  `0.0.0.0`, IPv6 loopback); completion ranking (discovered > history > paths, prefix match,
  dedupe); history cap; gateway resolution picks the ticket path on hosted and the plain
  address on local; tunnel fallback when no port is free.
- Contract parity for the three routes.
- VPS: `npm run dev` from the Code terminal → the strip shows `:3570 → :8503` → Open in
  Browser shows the storefront; a printed `http://localhost:9000` in the output is a link to
  the same gateway port; `Tab` after `npm run ` lists the project's scripts.
