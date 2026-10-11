# A tracker ticket as first-class task context

> Draft, 2026-10-11. Extends [Jira/Linear browsing](2026-09-18-jira-linear-tracker-browsing.md) and
> the tracker half of [automations](2026-09-14-automations-redesign.md). Three of that browsing
> spec's non-goals are deliberately lifted here and named in § Superseded non-goals. Phases 1–5
> perform no vendor write. Phase 6 adds exactly one: a status change the user makes by hand on
> the board. Every other write (comments, PR links, anything an agent or automation does on its
> own) stays out and gets its own spec.

## 📝 TLDR

Today a Jira/Linear ticket reaches an agent as text pasted into the prompt, description only, and
the run forgets where it came from. This spec makes the ticket a structured part of the task:

1. **Link** — a run carries `trackerLinks`; the cockpit shows the ticket on the task and the
   tasks on the ticket.
2. **Comments** — the detail read returns a bounded comment thread, shown to the user and
   included in the handoff.
3. **Server-built snapshot for automations** — the server attaches the same context block at
   launch instead of only instructing the agent to fetch it.
4. **Brokered read** — `cez tracker issue --current` lets an agent re-read the ticket through
   the running cockpit, which keeps the token.
5. **Issue surface** — the tracker screen becomes a full-width list/board with a detail panel,
   which is where the link, the tasks and the comments are shown.
6. **Drag to change status** — moving a card to another board column changes the ticket's
   status at the vendor, as an explicit user action.

No new configuration, no new `CEZ_*` flag, no new state file. No vendor write before phase 6.

## 📝 Problem Statement

- **A manual handoff leaves no provenance.** `trackerRunBody` (`packages/web/src/lib/tracker-task.ts`)
  sends `{ workflow, task }`; only automation runs get `automationTracker`. The ticket list cannot
  say "an agent is already on this", and a task cannot show its ticket.
- **The agent starts under-briefed.** The prompt says so itself: *"Tracker snapshot scope:
  description only; comments, attachments, and custom fields are not included."* In Jira a large
  share of the actual decision lives in comments.
- **Automation context is a request, not a guarantee.** `renderTrackerTask`
  (`automations/task-template.ts`) tells the agent it "MUST fetch and read the full current issue"
  with curl and env credentials. That is unenforced, differs per backend, and is the reason the
  project's tracker credentials are placed in the agent's environment. The code comment already
  records this as known debt ("the safer, narrower server-side-only … path discussed and deferred").
- **A snapshot silently ages.** A task continued the next day works from yesterday's ticket.

## 📝 Prior art

Reviewed 2026-10-11 by reading the source of three projects (shallow clones, nothing executed).

| Project | Relevant finding | Taken | Not taken |
| --- | --- | --- | --- |
| stablyai/orca | Real Linear + Jira integration. Structured `linkedItems[]` with origins on the worktree; "Has Workspace" computed locally from that metadata; agent pulls context via `orca linear issue --current` through the app, which holds the token; every collection carries truncation metadata; ticket text wrapped as untrusted data with delimiter escaping. | Link array with origin; local "has task" computation; brokered `--current` read; per-collection truncation metadata; untrusted wrapper. | Identity-only prompt (agent must pull everything): costs round-trips and needs agent cooperation. Legacy per-provider slots living beside the array. Jira left without an agent path. |
| multica-ai/multica | Own tracker, no Jira/Linear. A run row has `issue_id`; the issue view lists active and past runs; a hash of title+description taken at claim time lets a resumed session be told "unchanged" or which fields changed; removed PR links are remembered so they do not come back. | Runs-per-ticket view; change detection by content hash. | Agent-driven status changes that need server-side safety nets; webhook/GitHub-App ingestion (needs a public address). |
| pingdotgg/t3code | No tracker integration. Thread↔PR link is a many-to-many record keyed by `(host, repository, number)` with a `source` provenance field and a cached snapshot with `syncedAt`; it was migrated from a single field. Context travels as typed, bounded, escaped records. | Many-to-many from day one; host-level identity key; cached snapshot with sync time. | Linking that depends on the agent remembering to call a tool; webhooks through a hosted tunnel. |

Two of the three converged independently on "many-to-many, with provenance, remembering removals".
The one that started with a single field had to migrate.

## 📝 Scope

In: the six phases above, for Jira Cloud and Linear, through the existing `TrackerProvider` seam.

Out, each a separate decision:

- Any vendor write other than phase 6's user-initiated status change: comments, PR links,
  assignee, labels, and every write made by an agent, an automation or the review gate.
- Removing tracker credentials from the automation agent's environment. See § Load-bearing.
- Attachments, custom fields, sub-issues, linked issues, activity history.
- Linking a ticket to a task that already exists; agent-initiated linking; text-derived linking.
  (Consequently no "removed link" tombstone is needed yet — nothing auto-relinks.)
- Automatic deduplication or blocking of a second task on the same ticket.
- New providers, OAuth, multiple associations per repository, encryption at rest.

### Superseded non-goals

The browsing spec said: no comment ingestion, no tracker status chips, no extension of
`task-refs.ts`. Comment ingestion and chips are now in scope. `task-refs.ts` stays untouched:
chips come from the structured link, never from parsing prompt text, so numeric tracker ids still
cannot become GitHub issue numbers.

## 📝 Data model

### `RunRecord.trackerLinks` (optional array)

```ts
trackerLinks?: Array<{
  provider: 'jira' | 'linear'
  sourceId: string        // TrackerAssociation.source.id
  scopeId: string         // TrackerAssociation.externalId
  itemId: string          // TrackerItem.id, as the vendor names it
  origin: 'handoff' | 'automation'
  linkedAt: string        // ISO
  // Enrichment from the server's own read; absent when that read failed.
  title?: string          // bounded
  url?: string            // https, vendor-canonical
  snapshot?: { status: string; updatedAt: string; contentHash: string; syncedAt: string }
}>
```

- **Identity is `(provider, sourceId, itemId)`.** Not `connectionId`: rotating a token must not
  orphan history. Not `scopeId`: an issue moved between Jira projects keeps its source.
- **Optional, like every `RunRecord` field**, so older indexes parse and an older cezar strips it.
- **Client-authored `title`/`url` are never stored.** They come from the server's read or stay absent.
- `contentHash` = sha256 over the normalized title, description and the included comment ids +
  bodies. It is a change detector, not a security property.
- `automationTracker` is unchanged. From this spec on, an automation launch writes both. One
  pure helper, `runTrackerLinks(run)`, is the only reader: it returns `trackerLinks`, or folds a
  legacy `automationTracker` into one derived link when the array is absent. No stored migration.

Construction sites that must set the field in the same commit (grep the type, not the field):
`POST /runs` single and ×2/×3 variants, `launchTrackerAutomationRun`. A dispatch child does
**not** inherit its parent's link; the ticket view groups by root run.

### Comments in the contract

`TrackerDriver` gains `listComments(itemId)`. The detail response becomes
`{ available: true, item, comments }` where `comments` is one of:

```ts
{ available: true, items: TrackerComment[], truncated: boolean, bodiesTruncated: number }
{ available: false, reason: string }   // item read succeeded, comment read did not
```

`TrackerComment = { id, author, createdAt, body, bodyTruncated, unsupportedContent }`.
Unavailable is not empty: a failed comment read is disclosed, never rendered as "no comments".
List and search rows do not carry comments.

Bounds (server-side, in the adapter): the 30 most recent comments, 4,000 characters each,
rendered oldest-first. Description cap stays 60,000; the final task cap stays 100,000.

## 📝 Behavior

### Phase 1 — link

- `POST /runs` accepts optional `tracker: { itemId, expectedScope }`. Validation is route
  middleware; the schema lives in `packages/contract`.
- The server resolves the link from the project's **saved** association plus `itemId`. A scope
  that no longer matches `expectedScope` is a 409 and no run is created, as reads already behave.
- Enrichment uses the server's own `getItem`. If that read fails, the run is still created with
  an unenriched link (key only, no href); enrichment is filled by the next successful read of
  that item. A vendor outage never blocks a launch that would have worked yesterday.
- **Task → ticket:** the task header shows a chip (key, status from `snapshot`, link to `url`).
- **Ticket → tasks:** list rows show a badge when any run links to the item (active vs finished);
  the detail pane lists those runs with status and a link to each. Computed in the cockpit from
  the runs already in the query cache; no vendor call, no new route.
- A "Has task" list filter is local and is labelled as covering loaded rows only.
- Launching on a ticket that has an active task shows a non-blocking notice with a link to it.

**Status 2026-10-11:** implemented — `trackerLinks` in the contract and the store, the
`POST /runs` field, the automation link, the task-header chip, the activity dot on rows and
cards, the Tasks section and the in-progress notice. Deviations from the text above:

- Completed 2026-10-11:
  - `runTrackerLinks` folds an earlier tracker-automation run into one derived link. It is applied
    where the cockpit reads runs (`GET /runs`, `GET /runs/:id`) and in the brokered read, and is
    never written back. A run event pushed over SSE carries the stored record, so the derived
    chip can drop out until the next refetch; such runs are finished ones and rarely emit events.
  - A key-only link is completed by the next detail read of that ticket (`enrichTrackerLink`).
    It gains `title`, `url` and `latest`, not a `snapshot`: that read is not the task's start.
  - The "Has task" filter exists (phase 5).
  - A dispatch child shows its root's ticket in the task header, derived from the run list.

### Phase 2 — comments in the handoff

- The detail pane renders the comment thread under the description.
- The prompt block gains a comments section; the fixed "description only" sentence is replaced
  by one generated from what was actually included.
- `trackerLosses` additionally reports: comment list truncated, comment bodies truncated,
  unsupported comment content, comments unavailable. Each requires the existing acknowledgment.
- All ticket text is emitted inside one untrusted-data envelope whose delimiter is escaped in
  the payload, so a comment cannot forge the end of the block.
- The context block is rendered by **one pure function** used by both the cockpit composer and
  the server (phase 3). It lives in `packages/contract` (Node-free; the service may import its
  values, and `inline-contract.mjs` already folds it into `dist/`).

**Status 2026-10-11:** implemented — `comments` on the detail response, comment reads in
both adapters and the demo fixtures, `renderTrackerContext`/`trackerContextLosses` in
`packages/contract/src/tracker-context.ts`, the thread in the issue panel, the envelope and
the new losses in the composer. Differences from the text above:

- `getItem` returns the comments; there is no separate `listComments` driver method. One read
  per detail view keeps the existing deadline, dedupe and cooldown without a second code path.
- No `bodiesTruncated` counter: it is derivable from the items.
- A prompt spends at most 30,000 characters on comments (`TRACKER_COMMENT_BUDGET`), keeping the
  newest that fit and reporting the rest as a loss. Without it a full thread plus a long
  description could exceed the 100,000-character task limit and block the launch.
- **Unverified against vendors.** The Jira comment endpoint, its parameters and scopes are
  implemented from prior knowledge of the API: the documentation page could not be read this
  session. Which end of a thread Linear's `comments(first:)` serves first is not documented
  where I could find it; the adapter sorts what it gets and reports `hasNextPage` as partial
  instead of claiming "most recent". Linear comments by integrations (no `user`) appear as
  "Unknown". Neither adapter has been exercised against a live account.

### Phase 3 — server-built snapshot for automations

- At launch, the automation path reads the item and its comments through the driver bound to the
  run's captured association and appends the phase 2 block, then records the link with `origin:
  'automation'` and its `contentHash`.
- The instruction changes from "you MUST fetch the issue" to "a snapshot is below; re-read with
  the brokered command if you need current state".
- **If the server read fails, the launch does not fail and the prompt falls back to today's
  agent-side fetch instruction verbatim.** With every new piece at its shipped default, the old
  scenario still works exactly as before.
- Preview (`cez automation check`) performs no extra read and reserves nothing.

**Status 2026-10-11:** implemented — `readTrackerTicket` and the optional `ticket` argument
of `renderTrackerTask` (`automations/task-template.ts`); `getDriver` is a required option of
`launchTrackerAutomationRun`, so all three launch sites in `server.ts` pass it. The link of an
automation run carries the content hash when the read succeeded. The instruction to re-read
names the vendor API and the environment credentials, since the brokered command of phase 4
does not exist yet. Launch now waits for one bounded vendor read.

### Phase 4 — brokered read and change detection

- `node "$CEZ_BIN" tracker issue (--current | <id>) [--comments] --json`, over the same
  run-scoped channel `cez task create` uses. `--current` resolves from the calling run's links.
- The cockpit performs the read with the project's stored credentials; the token never reaches
  the agent through this path. Output carries the same truncation metadata as the HTTP response.
- Only items inside the run's captured association are readable; a changed association or
  connection fails closed with the existing controlled errors.
- On a **user-initiated** Continue of a linked run, the server re-reads the item once, compares
  `contentHash`, and prepends either nothing or a short "the ticket changed since this task's
  snapshot: <fields>" note, then updates `snapshot`. A failed read adds nothing and blocks
  nothing. The autonomous nudge and the monitoring wake timer never trigger this read.

**Status 2026-10-11:** the brokered read is implemented — `GET /runs/:id/tracker-issue`
(`sinceStart`, `statusAtStart`), `cez tracker issue` (`packages/cezar/src/tracker-cli.ts`) and
`TRACKER_PROMPT`, composed at both `ActiveRun` construction sites for a linked run whose agent
can reach the cockpit. Differences from the text above:

- **The change note is on `POST /runs/:id/continue` only** (added 2026-10-11), not on messages to
  a live session: a Continue is the "picked up again later" moment and a person's act, so the
  autonomous nudge and wake timers never cause the read. The read is raced against a four-second
  budget and any failure adds nothing. The note is appended after the user's own text.
  `ticketChangeSince` compares against `noted ?? snapshot` — what the TASK was told — and never
  against `latest`, which is what the cockpit knows; a status moved on the board is therefore
  still announced. `snapshot` is not updated, so `sinceStart` keeps comparing against the start.
- **Reachability follows dispatch.** `CEZ_API_URL`/`CEZ_BIN` reach an agent only while dispatch is
  reachable (`agentEnv`), so with `CEZ_DISPATCH=0` or a headless run the agent is not told about
  the command. That keeps the environment byte-for-byte as before in those modes.
- A changed connection is refused by the tracker service itself; the route additionally checks
  provider, source and scope against the run's link, which deliberately carries no connection id.
- The automation prompt of phase 3 now names this command first and the vendor API as the
  fallback for a task that was not told about the command.

### Phase 5 — issue surface (screen redesign)

Today `/p/:projectId/tracker` is a narrow list in the secondary sidebar plus a detail pane that
is empty until a row is picked. The target is a full-width issue surface in the manner of
multica's Issues page (reviewed 2026-10-11: `packages/views/issues/` and the public site).

- **Toolbar:** view switch (List / Board), Filter (state, labels, "Has task"), Display (which
  row properties are shown), search, Refresh and Last checked. The provider/scope header and the
  Settings shortcut move here from the sidebar.
- **List view (default):** full-width rows grouped under collapsible status headings with a
  count. A row shows key, agent-activity indicator, title, labels, updated time.
- **Board view:** one column per status, cards with key, title, labels and the activity indicator.
- **Detail opens as a right-hand panel over the surface** (resizable, URL stays
  `/tracker/:id`, closes back to the same scroll position). Inside: title and description on the
  left with the comment thread (phase 2) below; a properties column on the right (status, labels,
  author, dates, source link) followed by **Tasks** (phase 1: active and past runs) and the
  hand-to-agent composer, which stops being a separate dialog step.
- Mobile keeps one pane at a time, as today.

What does NOT carry over from multica, because this tracker is read-only and paginated:

- **No inline assignee/priority pickers, no batch toolbar, no create.** Those are vendor
  writes. In this phase a card is draggable only into the task composer; dragging between
  columns arrives in phase 6, so columns are keyed by vendor status **id** from the start.
- **Counts and groups describe loaded rows.** The list is the first page of 50 plus whatever
  Load more fetched; headings say "12 loaded", never a backlog total, and a column can gain
  cards on Load more. Auto-refresh keeps covering the first page only.
- **No saved views, table/gantt/swimlane modes, custom properties.**

Contract additions this phase needs (each verified per vendor first):

- `statusCategory` on `TrackerItem` (`backlog | unstarted | started | done | canceled`), from
  Jira's status category and Linear's state type. Without it columns have no meaningful order
  and "active" grouping is a string guess. Unknown maps to a trailing "Other" group.
- Optional `assignee` and `priority` display strings. Cards work without them; add only if both
  vendors return them inside the reads already made.

The view mode is a per-viewer convenience kept in browser storage, never required; collapsed
groups last for the visit.

**Status 2026-10-11:** implemented — `statusId`/`statusCategory` in the contract and both
adapters, List and Board, the detail panel with properties and the inline composer. Completed
2026-10-11: the Display menu, the "Has task" filter, the Tasks section, the comment thread, the
resizable panel (pointer, arrow keys, double-click to reset) and `assignee`/`priority` from
both vendors. Display choices and the panel width live in browser storage with the view mode.
The Jira and Linear mappings, including assignee and priority, are covered by mocked fixtures
only; neither has been checked against a live account.

### Phase 6 — drag to change status

The first vendor write in the tracker. It is deliberately the narrowest one available: one
ticket, one field, started by a human gesture, reversible by the opposite gesture.

**Interaction**

- Dragging a card to another column requests that status. The same action is reachable without
  a pointer: a "Move to…" menu on the card and in the detail panel's status property.
- On drag start (or menu open) the cockpit asks which statuses this ticket may move to. Valid
  columns highlight; the rest dim and refuse the drop with a one-line reason.
- The move is optimistic. On rejection the card returns to its column and a toast states why.
- One card at a time. The drop position inside a column is ignored (no vendor rank writes); the
  card lands where the list's ordering puts it.
- If an enabled automation in this project triggers on the target status, the drop target says
  so before release ("starts automation <name>"). Computed from local automation definitions;
  informative, not blocking. The move is a real transition and the poller will see it.

**Server**

- Driver gains two optional methods: `listTransitions(itemId)` and
  `transition(itemId, { toStatusId, expectedStatusId })`. A provider without them gets the board
  with no drag; nothing else changes.
- Two project-scoped routes, chained into the tracker family, validated as middleware:
  `GET /tracker/:id/transitions` and `POST /tracker/:id/transition`. Both carry `expectedScope`.
  As sub-paths of an item they need no entry in `reservedTrackerItemIds`; the route inventory
  and parity tests gain both.
- **Compare-and-set.** The request names the status the user saw. If the vendor's current status
  differs, the answer is a 409 with the fresh item and nothing is written.
- **Linear:** the targets are the team's workflow states; the write sets the state id.
- **Jira:** the targets come from the issue's own transitions endpoint, which already reflects
  the workflow and the account's permissions. A transition that requires a screen or mandatory
  fields is listed as unavailable with "complete this in Jira" and a link, never attempted.
  When several transitions reach the same status, the write uses the one the vendor lists first
  and the choice is covered by a fixture.
- **Writes are never retried automatically and never cached.** A lost response is resolved by
  re-reading the item, not by sending the write again. Cooldowns from the read path apply.
- After success the server returns the fresh item; the cockpit patches the list and detail
  caches, and the `snapshot` of any run linked to that ticket is updated.
- Nothing here is exposed to agents: no broker write command, no change to what an agent's
  environment contains.

**Zero config: write access is discovered, not configured**

- No setting, no flag. The board offers drag whenever the driver supports it.
- Jira's transition list is permission-aware, so an account that cannot move the issue simply
  gets no targets and an explanation.
- A write refused for missing permission marks that connection revision as read-only for the
  process lifetime: drag is then disabled with "this token is read-only" and a link to Settings.
  Replacing credentials creates a new revision and clears the mark. No probe write is ever sent.
- A read-only token therefore keeps today's behavior exactly; the only difference is one
  rejected gesture and an explanation.

**Order of delivery:** Linear first (a plain state update), then Jira with transition validation.
Shipping Linear alone is acceptable; Jira then shows the board without drag until its half lands.

**Documentation that changes with this phase:** `docs/issue-trackers.md` stops saying browsing
performs no vendor writes and says instead that the only write is a status change the user makes
by hand; the credentials section gains the optional write permission (Jira classic
`write:jira-work`, Linear key with Write) and states that read-only tokens remain supported.

**Status 2026-10-11:** implemented for both providers — `listTransitions`/`transition` in the
Jira and Linear adapters and the demo tracker, the read-only marking in the tracker service, the
two routes, drag between board columns and the "Move to" menu in the issue panel. Differences
from the text above:

- Added 2026-10-11, completing the list above: the "Move to" menu on each card (beside the
  card's link, never inside it); the "Starts automation: <name>" line on an allowed drop target
  and on a menu item, from the project's enabled status-change automations bound to this scope;
  a temporary column, appended while a card is in hand, for each reachable status that holds no
  loaded ticket.
- **A move updates `latest`, not `snapshot`,** on every run linked to the ticket. `snapshot`
  is what the task started from and feeds `sinceStart`/`statusAtStart`; overwriting it would
  have made both lie. The task header shows `latest` when present. Only moves made in cezar
  reach it; a move made at the vendor does not.
- The automation hint does not model `requiredLabels`: an automation that also requires labels
  is named even when this ticket lacks them.
- The Jira write never falls back from the API gateway to the site origin: once reads have
  settled the transport, a refused POST is final. This was added so a refusal cannot send the
  write twice.
- **Unverified against vendors, and this is the write path.** Jira's transitions endpoint
  (`expand=transitions.fields`, `hasScreen`, `required`/`hasDefaultValue`, the 204 answer) and
  Linear's `workflowStates` filter and `issueUpdate` mutation are implemented from prior
  knowledge of both APIs and exercised only against mocks and the demo tracker. Whether a
  Linear read-only key's refusal arrives as the `FORBIDDEN` code the adapter maps is not
  confirmed. Nothing has been sent to a live account. Verify on a disposable project or team
  before relying on it.

## 📝 Load-bearing behavior that this spec must not remove

- **"cezar does not change your tracker on its own."** Phase 6 narrows this from "never writes"
  to "writes only what a person just did with their hand". No timer, automation, agent, review
  gate or background reconciliation may reach the transition route. It takes a request from the
  cockpit and nothing else calls the driver's `transition`.
- **Read-only tokens keep working.** Recommending read-only tokens was the documented default;
  every surface must behave as before for them.

- **Draft preservation across selection and refresh.** Per-issue instruction drafts, the
  workflow/engine/skills selection and the open issue survive list updates today; moving the
  composer into the panel must not reset them.
- **Demand-driven watch lifetime.** The first-page watch subscribes while the list is visible
  and releases on hide. On the new surface the list stays visible behind the panel on desktop,
  so demand is held there and released on mobile detail, exactly as now.

- **Tracker credentials in the automation agent's environment** (`resolveTrackerEnv`,
  `workflows/run.ts`). They read as "how the agent fetches the issue", which phase 3–4 replace.
  They are also the *only* way an automation agent performs the write-back the user's prompt may
  ask for. Removing them here would trade a working default for nothing. They stay untouched
  until the write-back spec ships a replacement that is on by default.
- **The loss acknowledgment.** More context means more ways to lose some; every new loss goes
  through the same gate rather than around it.
- **"No vendor request on boot, health or project classification."** Badges are computed from
  local run records for that reason.
- **`expectedScope` binding on every read**, including the new comment read and the broker.

## 📝 Vendor behavior to verify before implementation

Per `docs/adding-issue-tracker.md`: against official documentation and, where available, a live
test account; report live and mocked evidence separately.

- Jira: issue comment listing (pagination, newest-first ordering, ADF bodies through the existing
  converter), and whether classic `read:jira-work` suffices or which granular comment scopes the
  docs table must gain.
- Linear: `issue.comments` (ordering, pagination, threaded replies flattened or not) under a
  Read-only key.
- Both: comment visibility restrictions (Jira internal/role-restricted comments) must surface as
  absent, never as an error for the whole item.
- Phase 6, Jira: the transitions endpoint (permission filtering, how a required screen or
  mandatory field is reported, several transitions to one status) and the write scope needed.
- Phase 6, Linear: whether a Read-only key's refusal of a state update is distinguishable from
  other failures, and that workflow states are per team.
- Phase 6 needs a disposable test project/team: its live verification mutates vendor data, which
  the provider guide forbids without explicit authorization.
- Rate-limit cost of one extra request per detail view; the comment read shares the item read's
  deadline, in-flight dedupe and cooldown.

## 📋 Phasing

Each phase is independently shippable and leaves the default path working.

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| 1 | `trackerLinks`, `POST /runs` field, chip, badge, runs-per-ticket | — |
| 2 | `listComments`, detail contract, shared context renderer, losses | — |
| 3 | Automation snapshot with fallback | 1, 2 |
| 4 | Broker CLI, change note on Continue | 1, 2 |
| 5 | Full-width list/board surface, detail panel, `statusCategory` | — (richer with 1, 2) |
| 6 | Drag to change status (Linear, then Jira) | 5 |

Phase 5 can go first: it gives phases 1 and 2 their place on screen (activity indicator, Tasks
section, comment thread) instead of fitting them into the current narrow list.

## 📋 Acceptance criteria

- A task handed off from a ticket shows the ticket chip after a server restart and after
  Continue; the ticket's detail pane lists that task. A pre-existing automation run shows a chip
  through the legacy fold without any file being rewritten.
- A ticket whose decisive information is only in a comment produces a prompt containing it.
- With comments unavailable, the launch requires acknowledgment and the prompt says so.
- A comment containing the envelope's closing delimiter cannot end the block.
- With the vendor unreachable at launch: a manual handoff still starts (unenriched link); an
  automation still starts with today's fetch instruction.
- An automation run on a backend that ignores instructions still has the description and
  comments in its first prompt.
- `cez tracker issue --current` returns the ticket without any tracker variable being read from
  the agent's environment.
- Editing the ticket and continuing the task the next day yields exactly one change note.
- Dragging a card to a valid column changes the status at the vendor and the card stays there
  after Refresh. Dragging to an invalid column writes nothing.
- With a read-only token the first drag is rejected with an explanation, the card returns, and
  drag is disabled until credentials are replaced; browsing and handoff are unaffected.
- A ticket moved by someone else since it was loaded is not overwritten: the drop reports the
  conflict and shows the current status.
- A Jira transition that needs extra fields is never attempted.
- The status can be changed with the keyboard alone.
- No code path other than the cockpit's request reaches `transition` (asserted by a test over
  its call sites).
- Project isolation: no link, badge, comment or broker read crosses projects, connections or
  scopes; replaced credentials reject late results.

## 📋 Validation

- Contract parity in both directions for the changed detail response and the `POST /runs` body;
  `typed-bodies`, route parity (scoped/unscoped/default), versioned-surface and the
  BACKWARD_COMPATIBILITY route inventory for the broker route. Any new static tracker path
  segment joins `reservedTrackerItemIds`.
- Regression tests proven red without the fix: link survives Continue and restart recovery
  (both `ActiveRun` construction sites); automation fallback when the snapshot read fails; the
  empty/absent-input case of `runTrackerLinks`.
- Guard tests that pass both ways, kept on purpose: numeric tracker ids never become GitHub
  references; default agent environments receive no tracker credentials on manual handoffs.
- Phase 6: stale-status conflict, permission refusal marking the connection read-only and
  clearing on credential replacement, lost response resolved by re-read with no second write,
  cooldown, source/scope change mid-drag, optimistic rollback. Dry-run transitions mutate
  in-memory fixtures only. Tests use mocked vendors; any live write run is reported separately
  and only against a disposable scope.
- Dry-run fixtures gain comments, including an over-cap thread, an over-cap body and an
  unsupported-content case; `CEZ_DRY_RUN=1` contacts no vendor.
- Docs: `docs/issue-trackers.md` (context, scopes table), `docs/adding-issue-tracker.md`
  (`listComments` in the seam and checklist).

## 📝 Open questions

1. Should the cockpit's manual composer stay client-side (user sees exactly what is sent) with
   the server only recording the link, as specified, or should the server compose for manual
   handoffs too? Client-side is the smaller change; server-side removes the last second composer.
2. Comment bounds (30 × 4,000) are a first guess; adjust after measuring real tickets.
3. Should a dispatch child show its root's ticket chip (derived, not stored)?
