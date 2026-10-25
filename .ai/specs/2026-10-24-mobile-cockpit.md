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
GET    /workspace/push[?device=<id>]       → { available, publicKey, subscribed, stale }
POST   /workspace/push/subscribe           PushSubscription JSON → the GET's shape
DELETE /workspace/push/subscribe           { endpoint? } or no body → the GET's shape
POST   /workspace/push/presence            { visible, tab } → { ok: true }
```

Workspace-level, behind sign-in; the manifest at `/manifest.webmanifest` and the worker at
`/sw.js` are served by `static-ui.ts` beside the shell. Contract in `workspace.ts`.

- **Device.** A subscription's id is the first 24 hex of its endpoint's sha-256. The cockpit
  names its own browser's subscription with `?device=`, so `subscribed` and `stale` answer for
  that device alone. Without it, a signed-in caller's sign-in session names the device; on a
  cockpit without sign-in (every caller is `owner`) nothing does, so `subscribed` is "any
  device of the account" and `stale` is always false.
- **`stale`.** The push service refused our VAPID key for this device's subscription (401/403:
  the key pair was regenerated). It is never sent to again, and the setting asks to re-enable
  push on that device — a hint per device, never hidden by another device's live row.
  Re-enabling replaces the stale rows of the same sign-in session; without a session only the
  endpoint itself is replaced, and the cockpit DELETEs the endpoint it dropped.
- **Limits.** Ten subscriptions per account (a new one past that replaces the oldest); sixty
  pushes per account an hour (past that a transition is dropped, not queued); twenty held pushes
  per account, one per run. A direct send clears a held push with the same tag, so one run never
  notifies twice.
- **Presence.** A socket-less tab (hosted without cezar's sign-in) beats every 30 s while
  visible, and once with `visible: false` when it hides; a beat holds push for 45 s. `tab` is a
  token of 1–64 `[A-Za-z0-9_-]`; optional `device` is the browser's subscription id. Past four beats a minute from one tab, or twenty tabs a minute
  from one caller (its sign-in session, else its `device`, else its account), the route answers 429 — a refused
  beat only means push may hold a little longer.
- **Endpoint rules.** An endpoint is an `https:` URL with no credentials, on a public host. The
  host judged is the one the WHATWG URL parser yields — after percent-decoding, IDNA mapping
  (fullwidth digits, punycode) and numeric IPv4 forms — never the raw authority: loopback,
  private, link-local, CGNAT, multicast and unspecified IPv4; their IPv6 counterparts and an
  internal IPv4 carried in a mapped, translated, compatible, NAT64 (`64:ff9b::/96`,
  `64:ff9b:1::/48`) or 6to4 address; `localhost`, `*.localhost`, `*.local` and single-label
  names are refused. A trailing dot is stripped before the check.
- **Redirects.** The server POSTs with `redirect: 'error'`: a push service never redirects, so a
  3xx is `failed` and its location is never contacted.
- **Accepted limitation: DNS.** The check reads the name, not what it resolves to. A public
  hostname whose DNS answer is a private address is not detected; pinning the resolved address
  would need a resolver in the send path, and the POST carries only an encrypted payload the
  target cannot read.

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
