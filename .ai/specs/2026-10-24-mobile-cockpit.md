# The cockpit on a phone — tasks and thread, review and decisions, a new task by voice, and push notifications

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `2026-07-14-cockpit-ui-redesign.md` (mobile safe areas, `use-mobile.ts`,
> `keyboard-inset.ts`), the browser-notification half in `lib/notifications.ts` (off by default,
> tab hidden only), `2026-10-12-cockpit-authentication.md` (the hosted origin a phone reaches),
> `2026-10-12-outbound-webhooks.md` (draft; a different channel for the same events).
> Backlog item: "cockpit responsiveness".

## 1. Problem

The VPS made the phone a real client: a task reaches review while the owner is away from the
desk, an agent asks a question, CI goes red. The cockpit renders on a phone — safe areas and
the keyboard inset are handled — but it is a shrunken desktop: three-column pages, hover-only
actions, a composer built for a keyboard, and no way to be told anything while the tab is
closed.

## 2. Decisions

| Question | Decision |
| --- | --- |
| What must be good on a phone | **The task list and thread; review and decisions; a new task by voice or text; an installable PWA with push notifications.** Not the editor, not the terminal. |

## 3. Behaviour

### 3.1 Layout under 768 px

One column at a time with a back gesture: Projects → Tasks → Thread, each a full screen. The
sidebar becomes a sheet. Every action that is hover-only on desktop has a visible affordance
(a row menu). The composer sits above the keyboard inset and keeps the thread still
(#1606's rule). Pages that have no phone version — Code, Services' Docker tab, Settings → Agent
config — show a one-line "open this on a larger screen" card with the page's name, not a broken
layout.

### 3.2 The thread and the task list

The list shows status, title, elapsed and the attention dot; swipe-right opens the thread,
long-press the row menu (Continue, Archive, Open PR). The thread renders tool calls collapsed
by default with a tap to expand, diffs as **Changes** (§3.3), and the answer box for a run in
`waiting` pinned at the bottom.

### 3.3 Review and decisions

Changes on a phone is one file at a time: a file list, then a full-screen unified diff with
the comment gutter (tap a line → comment sheet), **Next file / Previous file**. The review
actions — Approve, Request changes (the comments ride along as today), **Commit to base**,
**Open draft PR**, Discard — are a bottom bar. Approve and Discard confirm.

### 3.4 A new task

`/new` on a phone is the task text, a workflow picker and a Start button; backend, model and the
rest sit behind "More" with the project's defaults. **Dictation** uses the browser's
`SpeechRecognition` where present (Chrome, Safari) and otherwise shows nothing — no server-side
speech. Drafts are the composer's existing ones.

### 3.5 PWA and push

- A web manifest (name and icons from branding — the branding spec) and a service worker that
  caches the shell for an instant open; data is never served from the cache (one global SSE,
  authoritative refetch on focus, as today).
- **Push.** Settings → Notifications gains **This device: enable push**. The server generates a
  VAPID key pair once (`<CEZ_HOME>/push-vapid.json`, `0600`) — nothing to configure — and keeps
  subscriptions in `<CEZ_HOME>/push-subscriptions.json` per owner account. The events are the
  ones `wantsAttention` already names (`waiting`, `review`, `failed`), sent only when no
  cockpit tab of that account is visible (the same rule the browser notification follows,
  known from the WS beat). The payload is the task title and status — no prompt text; tapping
  opens the thread. Web Push goes to the browser vendor's endpoint; it is listed in
  docs/telemetry.md as an opt-in network destination, enabled per device by the user.
- A local cockpit can install the PWA too; push there needs HTTPS, so it is offered only on a
  hosted origin and the setting says why otherwise.

## 4. API

```
GET  /workspace/push                       → { available, publicKey, subscribed: boolean }
POST /workspace/push/subscribe             PushSubscription JSON
DELETE /workspace/push/subscribe
```

Workspace-level, behind sign-in; the manifest at `/manifest.webmanifest` and the worker at
`/sw.js` are served by `static-ui.ts` beside the shell. Contract in `workspace.ts`.

## 5. Security

- Push payloads carry no prompt text, no paths, no diff — title and status only, the same
  rule telemetry follows.
- Subscriptions are tied to the signed-in account; signing out of the device deletes its
  subscription.
- The service worker caches only hashed static assets, never an API response.

## 6. Zero config

Push is off until the user taps enable on a device; VAPID keys are state. No env var. The
hosted-only limitation is discovered, not configured.

## 7. Not done here

- The editor, the terminal, Docker and Agent config on a phone.
- Native apps (the desktop shell is Tauri; a mobile shell is a later decision).
- Rich push (inline reply) — tapping opens the thread.

## 8. Verification

- Unit: the one-column router (back navigation, deep links to a thread); phone Changes paging;
  push gating (visible tab → no push; subscription per account; payload shape);
  `shouldNotify` reuse.
- The existing jsdom suites at 375 px (the `use-mobile` convention); an e2e smoke at
  375×812 through `npm run test:e2e` for list → thread → answer → review → approve.
- VPS: install to the home screen, enable push, start a task that asks a question → the
  phone gets the notification with the screen locked; approve a review from the phone.
