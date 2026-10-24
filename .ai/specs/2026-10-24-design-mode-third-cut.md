# Design Mode, third cut — a visible queue, a new task from collected notes, source locations, and the gateway

> Status: implemented on brutus (2026-10-25).
> Builds on: `2026-10-09-design-mode.md` (§6 limits, §7a the live note flow, §8 the prompt
> queue), `2026-10-10-preview-gateway.md`, `2026-10-11-code-page.md` (`CodeBrowserTab`: with no
> task chosen, each note starts a task of its own), `2026-10-12-cockpit-authentication.md`.
> Backlog item: "improve Design Mode — several comments before sending to the agent/worktree,
> skills, workflows".

## 1. Problem

Three things the second cut left:

- **Several notes, several messages.** Drafts can coexist, but each Send is its own prompt in
  the queue. The queue itself is invisible until a note's status changes; reordering or
  reading what is waiting means opening each frame.
- **A note with no task** starts a `quick-task` with defaults. There is no way to say "these
  five notes are one task, run it with the `ui-review` skill on Codex".
- **Hosted cockpits have no Design Mode at all** (AGENTS.md: always off on a hosted one), because
  the mirror is a second `127.0.0.1` listener. On the VPS, the one place the owner now works,
  the feature is absent.

And one quality gap: the agent receives a selector and a component name and then searches the
tree for the file, when a dev build already knows it.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Several notes before sending | **Each note stays its own queued message; the queue becomes visible and editable** | The owner prefers one note = one turn; what was missing is seeing and steering the queue. |
| Skills and workflows | **When the notes start a NEW task**: pick workflow, backend, model and skills as in `/new`; the collected notes are its task text | Notes to an existing task keep the one-way flow. |
| Hosted cockpits | **Design Mode works through the gateway** | The VPS is the primary cockpit. |
| What the agent gets | **The source location when a dev build exposes it** (`path:line`), else what it gets today | Stops the agent from locating components by selector. |

## 3. Behaviour

### 3.1 The queue, visible

A **Queue** chip in the Design Mode toolbar shows the count of notes waiting. Clicking it opens a
drawer listing every queued prompt of the run (`GET /runs/:id/prompt-queue`), design notes and
typed messages alike, in order, each with its element name, text, and **Edit · Move up · Move
down · Remove** — the existing `PATCH`/`DELETE` routes, plus a new `reorder` body on the
collection (`PUT /runs/:id/prompt-queue { order: msgId[] }`). A note that is already with the
agent is listed read-only with its status, as §7a defines. Nothing about sending changes.

### 3.2 A new task from collected notes

On the Code page with **no task chosen** (`CodeBrowserTab` with `run: null`), notes no longer
start a task each. They collect as drafts (framed, numbered, persisted in the project's draft
store like a run's `design-picks`), and the toolbar shows **Start task with N notes**. That
opens the `/new` composer pre-filled: the task text is the notes in order (element, note),
with an optional opening line the user types; the pickers — workflow, backend, model, variants,
base branch, skills (`/skill` chips) — are the composer's own. Starting the task consumes the
drafts and attaches the notes to the run as its first prompt; the frames turn lime and numbered
as after a send. One note can still be sent alone: its menu has **Start task with this note**.

### 3.3 Source locations

The picker script reads, for the picked element and its ancestors up to the first hit:
React's `__reactFiber$*` → `_debugSource` (`{ fileName, lineNumber }`, present in dev builds),
`data-v-*` + `__vueParentComponent.type.__file` for Vue, `data-source`/`data-loc` attributes
(Svelte and Astro dev builds). The note's element block gains `source: { file, line }` relative
to the worktree when the path is under it. The cockpit shows it under the element name; the
agent receives it in the same block. No source → nothing new, as today.

### 3.4 Through the gateway

The design proxy (`server/preview/design-proxy.ts`) stops being its own loopback listener:
on a hosted cockpit it is mounted **as a mode of a gateway slot**. The Browser tab asks for a
gateway port with `designMode: true`; the gateway re-serves the same loopback app through that
port **with the picker script injected and the frame-busting headers stripped**, under the
same ticket-then-cookie session as a plain preview. The picker's messages travel through the
gateway's existing same-origin channel to the cockpit. `CEZ_DESIGN_MODE=0` still turns it off
everywhere; the hosted-mode refusal in `capabilities.ts` is removed and AGENTS.md's line is
updated to "available by default, toggled on per Preview, local or hosted".

The §6 limits that remain: `http://` loopback apps only; per-origin `localStorage` (the
gateway origin differs from the app's, as it already does for plain previews).

## 4. API

```
PUT   /runs/:id/prompt-queue          { order: string[] }      reorder (same-set check, 409 otherwise)
POST  /preview/gateway                { url, designMode?: true }  existing route, new flag
GET   /repo/design-drafts             project-level drafts (no task)   → { picks: DesignPick[] }
PUT   /repo/design-drafts             replace
```

`DesignPick` (contract `preview.ts` / `runs.ts`) gains optional `source: { file, line }`.

## 5. Security

- The injected picker runs inside the previewed app's page, as today; the gateway already
  treats that page as untrusted and keeps the note window in the cockpit (§7a). Nothing typed
  lives in the page.
- A gateway slot in design mode is still ticket-gated and loopback-mirrored; it never
  mirrors a non-loopback origin.
- Source paths are reported relative to the worktree and only when under it — no absolute
  server paths reach the hosted viewer (`trimPaths` rule).

## 6. Zero config

Design Mode stays off until the toggle is clicked on a Preview. No new env var; the hosted
switch is the removal of a refusal, recorded as an owner-approved exception.

## 7. Not done here

- Batching notes into one message for an existing task (declined).
- Screenshots of picked elements (declined in the first cut; unchanged).
- Computed styles in the element block.
- `https://` loopback apps.

## 8. Verification

- Unit: reorder validation; project-level drafts store; source extraction against a fixture
  DOM with React `_debugSource`, with Vue `__file`, and with neither; the gateway slot in
  design mode injects the script and strips `X-Frame-Options`/CSP `frame-ancestors`; the
  hosted refusal is gone and `CEZ_DESIGN_MODE=0` still refuses.
- Cockpit: the Queue drawer lists, edits and reorders; the no-task Browser collects notes and
  opens `/new` pre-filled; the sent frames keep numbers.
- VPS: Design Mode on the storefront through `https://<domain>:85xx`; three notes → Start task
  with workflow + skill; the run's first prompt holds them with `source:` lines.
