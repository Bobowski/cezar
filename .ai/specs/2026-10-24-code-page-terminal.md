# The Code page terminal — detected addresses, project commands, clickable links, completion, and the gateway

> Status: built (2026-10-24), see §9 for what the build settled. Branch: `brutus`.
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

## 9. Settled while building

- **History comes off the input routes**, `server/terminal/history.ts`: a line is kept only when
  its text is certain (typing, backspace, paste — an arrow, a Tab or a Ctrl chord makes it
  unknown) and the shell sat at its prompt when the line BEGAN: a FRESH process table, read when
  its first word arrives, shows the shell with no child or only the line's own command (one
  chunk can carry a whole line, and the shell forks it while `ps` starts). That is what keeps a
  password a running `sudo`/`ssh` reads out of the file; a host with no readable process table
  (Windows) therefore keeps no history. The check never holds a keystroke: it runs beside the
  write, and keeps nothing when its own `ps` takes over 300 ms from its start, or the answer (a wait behind a running `ps` included) over 600 ms from the line's first word. A bare Enter, a Ctrl+C or a space-led
  line asks nothing; one `ps` runs at a time per host, a burst shares the one read queued behind
  it (never a read begun before it asked), and a `ps` past 300 ms is killed; while three killed ones have not exited (D-state), none is spawned and nothing is kept. Each line of a chunk is judged alone, and
  only a chunk's first line can have met a prompt: a pasted `ssh host⏎passw0rd⏎` keeps
  `ssh host`, and nothing begun after an Enter, Ctrl+C or Ctrl+Z in the same chunk is checked —
  `⏎hunter2⏎` finishing an earlier line keeps only that line. What the table cannot see is ruled by text: after `exec …` nothing is kept again
  (the shell's own pid became the program), the line after `read -s` is never kept, and after
  `ssh`/`sudo`/`su`/`doas`/`passwd`/`gpg`/`ssh-add`/`ssh-keygen` a line is kept only once a check
  begun 500 ms or more later confirms the prompt (a line typed ahead may beat the fork). Echo-off
  input is invisible from the keystrokes, so those rules are the whole account of it; a recalled
  (arrow-key) `read -s` or `exec` line is unknown text and sets no rule. A line led by a space is not kept
  (bash's `ignorespace`). A `NAME=value` (or `export NAME=value`) whose name looks like a
  credential — the transcript redactor's `SECRET_NAME_RE`, plus `PASS`/`PWD`/`KEY`/`PIN` as a
  name part — is stored as `NAME=***`. What the shell itself reads is kept as bash's own history
  keeps it: a heredoc body, and the answer to a `read -s` run by a sourced script or a function
  (no child shows and no typed line says `read -s`). Both the checkout's terminals and the
  project's task terminals feed it; a task's own credential never does, nor an API token (an MCP
  client), nor anyone typing into a session a token opened. A session's line state is dropped
  when its shell exits or the session is closed.
- **`/repo/terminal/urls` adds `sshUser`** (`projectDetectedUrlsSchema`), the account cezar runs
  as, on a hosted cockpit only — the tunnel line's login (tunnel spec §3.3).
- **Tab**: with the popover closed, Tab opens it when there is something to offer and is the
  shell's otherwise; after `Esc`, Tab is the shell's until the line is submitted or abandoned.
  `Esc` is taken only while the popover is open. Completion takes keys only at the shell's own
  prompt: never on xterm's alternate screen (vim, less), and only while the last prompt check — the
  terminal state's `busy`, asked at mount and 1.1 s after each Enter/Ctrl+C/D/Z, past the
  server's one-second process-table reuse, then every 1.1 s while busy for up to 10 s — found
  nothing running; until it answers, a REPL or a program's prompt keeps Tab, Esc and `Ctrl+R`.
  A host that cannot say (`busy: null`, Windows) counts as at its prompt for completion; it still
  keeps no history. Path completion needs a non-empty token, and lists
  from the shell's own directory: the session's `workdir` (relative to where it opened, read from
  Linux's `/proc/<pid>/cwd` with the busy check). A shell that left the checkout gets no paths; a
  host with no `/proc` (macOS, Windows) cannot say, and the checkout root stands in.
- **The strip never opens a gateway port.** Opening one to learn its number would hold a listener
  for every running address before any click, and could evict a user's Preview from a full pool.
  A hosted strip says `→ gateway` (known without asking) and `Open in Browser` opens the loopback
  address in a Browser tab, which asks the gateway for its port and fresh ticket on that click, as
  the Preview column does — and shows the gateway's refusal itself. The tunnel line sits beside
  every loopback address (preview-gateway §7).
- A "gateway address" in the output is this cockpit's own hostname on one of the pool's public
  ports (`CEZ_PREVIEW_PUBLIC_PORTS`, else `CEZ_PREVIEW_PORTS`), which `/repo/terminal/urls` names
  to a hosted cockpit as `gatewayPorts`; another port on that hostname is another service and
  opens in a new window.
- The task drawer keeps its strips as they were (user's browser + Preview); links, completion and
  the gateway mapping are the Code terminal's.
- **The address strip polls only while it is looked at**: every 3 s while its pane is shown and
  the page is in front, nothing while either is hidden, one read on coming back. The probe is a
  TCP connect per address and has no event to wait on, so it stays a poll rather than a topic.
