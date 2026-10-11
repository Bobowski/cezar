# Jira Cloud and Linear

Cezar can browse a Jira Cloud project or a Linear team and hand a selected issue to an
agent. Each local project has one saved tracker connection. GitHub remains independent.
cezar changes your tracker in exactly one way: when you move an issue to another status by hand (see [Changing a status](#changing-a-status)). Nothing else in the tracker screen writes, and cezar never does it on its own. Enabled event automations can launch agent workflows as described below. The visible issue list checks its first page every 60 seconds; it stops when hidden or closed.

## Connect

Open the project's **Settings → Issue tracker**, then **Configure Jira credentials** or
**Configure Linear credentials**. Jira needs the site URL, account email and API token;
Linear needs an API key. Use a token with read access restricted to the intended data.
Save it, choose **Browse**, search for the project/team, then **Connect**. Discovery is
paginated; **Load more** reaches later results. No server restart or environment editing
is needed. Saving credentials is local; Browse/Connect verifies vendor access.

Each cezar project has one credential connection and one selected tracker scope. Configuring
project A does not configure project B. Replacement creates a new connection identity and
requires selecting a scope again, even if the vendor IDs happen to match. Failed credential
storage preserves the previous credentials. Failed scope selection preserves the previous
association, but an association tied to replaced credentials remains disabled until reconnected.

**Disconnect** removes the selected scope while retaining the project's credentials for reuse.
**Remove project credentials** deletes the local credential record and disables reads; it does
not revoke the token at the vendor. The old scope metadata may remain stored, but Settings shows no connected tracker without matching credentials.
Both actions work offline. Remove credentials before unregistering or moving a repository;
otherwise its private credential file remains until explicitly removed. Use `cez tracker-connections list`
to inventory retained records and `cez tracker-connections remove <id>` to delete a selected
64-hex record ID, including a record whose repository is gone. These local commands require no
running server or vendor access and never print secrets. Credentials are not
copied when a repository is copied or moved to a new path.

### Storage and isolation

Secrets are write-only through the API: read responses expose only connection ID/provider.
They are stored as managed dotenv files in
`~/.cezar/tracker-connections/<sha256(canonical-project-path)>.env` (or the selected
`CEZ_HOME`), outside repositories by default, with directory mode `0700` and file mode `0600` on POSIX. A managed `.gitignore` excludes all files in the credential directory from ordinary Git staging,
including when `CEZ_HOME` is inside a repository; it does not untrack files already committed or
prevent forced staging. Storage uses atomic
replacement, no backups, and a hash of the canonical repository path. Repository state keeps
only a non-secret connection ID and scope identity. Form secrets are cleared after save,
failure, cancellation or project change; no browser storage is used. The API never forwards
these credentials into ordinary manual handoff agent environments. Enabled tracker automation
workflows have a deliberate exception: they receive only the captured connection’s credentials,
after its project, source and revision have been revalidated.

The form writes these files automatically; do not create or source a repository `.env`.
The dotenv values are parsed into a project-local object, never loaded into `process.env`.
The file contains provider credentials plus a format version, canonical `PROJECT_ROOT`, opaque connection UUID and
private consistency digest. The digest detects accidental edits; it is not encryption or a
security boundary against someone who can edit the file. Use Settings to replace credentials:
manual token edits without matching metadata fail closed, preventing use of an old cached key.

One managed dotenv format is supported. Unreleased prototype JSON/root-less dotenv records are
not automatically migrated or used as fallback. Stop prototype processes and reconnect through
Settings; remove obsolete records explicitly. Invalid records produce a controlled local-storage
error instead of silently appearing as an absent connection. Missing storage never prevents boot.

Removing credentials unlinks the selected record; no disabled marker or credential backup remains.
Mutations for the same record are serialized across processes. Unsupported future formats are not
automatically overwritten. Explicitly replacing credentials in Settings or removing a listed
record is a user-requested mutation; inspect the local inventory before doing so.
Local deletion does not revoke the vendor token.

Files are **not encrypted at rest**. OS permissions protect against other OS users, not agents
or processes with the same user's filesystem privileges. Project scoping is an application
boundary, not a tenant sandbox or a compliance certification. Hosted access must use the
existing authenticated HTTPS deployment. Ticket descriptions enter local run history and
the selected AI backend when you launch; follow your organization's data/retention policies.

Candidate discovery, adapter/cache instances and signed cursors are project/connection-bound.
Replacing/removing credentials rejects late results from the old connection. A token's vendor
permissions remain an upper bound: a broad token can discover many vendor scopes within the
project where it was explicitly configured. Separate narrowly scoped tokens are recommended.

### Existing environment-based connections

`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and `LINEAR_API_KEY` in the server
environment or a repository `.env` are not read by this integration. These names are used only
inside the managed per-project credential file. Existing saved scopes stay visible, but reads fail closed until you configure
credentials and reconnect in that project's Settings. There is no silent migration or fallback
to a global key. `CEZ_DRY_RUN=1` remains an explicitly selected credential-free demo; it cannot
save real credentials and never contacts vendors.

## Credentials and read permissions

Jira supports Cloud sites at `https://<site>.atlassian.net`, using account email plus
a scoped or unscoped API token. Data Center/custom hosts and OAuth are outside this
integration. Use the site URL, not the API gateway. Cezar discovers the cloud ID and
tries the scoped-token gateway first, with one site-origin fallback on authorization
failure. [Create, expire and revoke Atlassian tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).

The account needs **Browse projects** and any applicable issue-security access.
The four reads below use the recommended classic **`read:jira-work`** scope. When
choosing granular scopes instead, the endpoint requirements are:

| Read | Granular scopes |
| --- | --- |
| Project search and direct project lookup | `read:issue-type:jira`, `read:project:jira`, `read:project.property:jira`, `read:user:jira`, `read:application-role:jira`, `read:avatar:jira`, `read:group:jira`, `read:issue-type-hierarchy:jira`, `read:project-category:jira`, `read:project-version:jira`, `read:project.component:jira` |
| Enhanced issue search | `read:issue-details:jira`, `read:field.default-value:jira`, `read:field.option:jira`, `read:field:jira`, `read:group:jira` |
| Direct issue lookup | `read:issue-meta:jira`, `read:issue-security-level:jira`, `read:issue.vote:jira`, `read:issue.changelog:jira`, `read:avatar:jira`, `read:issue:jira`, `read:status:jira`, `read:user:jira`, `read:field-configuration:jira` |

These are the declared endpoint scopes in Atlassian's [OpenAPI contract](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json);
see [project reads](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/),
[enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/),
and [issue lookup](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
Browsing does not call `/myself`. Enabled Jira automations read the account timezone through
`GET /rest/api/3/myself`, which additionally requires classic **`read:jira-user`**. Its granular
scopes are `read:application-role:jira`, `read:group:jira`, `read:user:jira`, and `read:avatar:jira`
(already included in the aggregate table above). See [current-user permissions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/#api-rest-api-3-myself-get).
Opening an issue additionally reads its comments (`GET /rest/api/3/issue/{key}/comment`). The
classic `read:jira-work` scope is expected to cover it; with granular scopes add
`read:comment:jira` and `read:comment.property:jira`. This row has not been re-checked against
Atlassian's OpenAPI contract the way the table above was: if the token lacks it, the issue still
opens and its comments are reported as unavailable.
These reads require no write scope; agent-requested status updates need suitable vendor write permissions.

For Linear, create a personal API key with **Read** permission and access to the desired
team. It reads organization identity, team discovery/direct lookup, issue search/list/detail
and the issue's state, creator and labels. No create/update/admin permission is needed.
[Create, restrict and revoke Linear keys](https://linear.app/docs/api-and-webhooks).
The [GraphQL API](https://linear.app/developers/graphql) describes key authentication and
[rate limits](https://linear.app/developers/rate-limiting).

Rotate or renew an expired token using Replace credentials in project Settings, then reconnect the scope.
Changing the Jira site or Linear organization requires explicitly reconnecting the project;
saved IDs are never silently retargeted.

## Changing a status

Drag a card to another board column, or use **Move to**: the menu on a card (shown on hover and
on keyboard focus) and the status menu in the issue panel. Both menus work from the keyboard.

- When you pick a card up, cezar asks the tracker where that issue may go. Columns it can move
  to are outlined; the others dim and say why. A status it can reach that has no loaded issue
  gets a temporary column at the end of the board for as long as the card is in hand.
- If the move would fire one of this project's enabled automations (a status-change automation
  bound to this project or team), the column and the menu item name it before you let go. The
  move is a real transition: the automation sees it at its next check.
- The card moves at once. If the tracker refuses, it returns to its column with the reason.
- If someone else moved the issue since you loaded it, nothing is written: you are told, and the
  issue is shown where it now is.
- **Jira** moves follow the project's workflow. A move that opens a screen or requires fields is
  listed, explained and never attempted from cezar; make it in Jira. **Linear** offers the team's
  other workflow states.
- The write is sent once and never retried. After a lost answer the issue is simply re-read.

This needs a token that may write: Jira classic scope `write:jira-work`, or a Linear key with
write permission. There is no setting. A read-only token keeps working exactly as before; its
first attempted move is refused with an explanation and moving is then switched off for that
connection until you replace the credentials in Settings. cezar never sends a test write to find
out. Only you can make this change: no agent, automation or timer reaches it, and agents still
have no command for it.

## Tickets and tasks

A task handed off from a ticket, and a task a tracker automation launches, is **linked** to that
ticket. The task header shows the ticket key with the status it had when the task started, as a
link to the vendor. In the tracker, a dot on a row or card says a task exists for that ticket
(working, waiting for review, or finished) and the issue panel lists those tasks. Both are computed
from local task records, so they need no vendor request and keep working while the vendor is down.

After you move an issue in cezar, the header of every task linked to it shows the new status; the
status it started from is kept and shown on hover. A move made in the vendor's own UI is not
reflected there.

The link is recorded by the server from the project's saved scope and its own read of the ticket,
never from the prompt text. If the vendor does not answer at launch the task still starts, linked
by key only. A second task for a ticket that already has one in progress is allowed; the panel
says so first. Tasks started before this feature, and tasks typed by hand, carry no link.

## Re-reading the ticket from inside a task

A task linked to a ticket is told, in its system prompt, that it can read the ticket as it is now:

```sh
node "$CEZ_BIN" tracker issue --current     # this task's ticket: description and comments
node "$CEZ_BIN" tracker issue OPS-42        # another ticket of the same project or team
node "$CEZ_BIN" tracker issue --current --json
```

The cockpit performs the read with the project's stored credentials, so the agent needs no
tracker token for it. The answer says whether the ticket's title or description changed since
the task started, and what its status was then. It is read-only, and it only reads the scope the
task was started from: if the project has since been connected elsewhere, it refuses rather than
read another scope. It needs a running cockpit and task dispatch left on (the default);
with `CEZ_DISPATCH=0`, or in a headless `cezar run`, the agent is not told about it and works
from the snapshot in its prompt.

cezar does not push ticket changes into a running or continued task by itself: the agent learns
of them when it runs the command.

## Agent context

Handing off a ticket fetches its detail description, including text beyond the list preview, and
its comment thread. The prompt includes the identifier, title, source URL, description snapshot,
comments, selected skills, supplemental context and your instruction. Everything the vendor wrote
travels inside one block marked as untrusted reference data. The snapshot persists in normal run history. If no agent backend is ready or its authentication
cannot be checked, the handoff explains the problem and links to **Configure providers**;
your draft stays in place while you restore access.

Descriptions become eligible for refetch after one minute; this does not periodically refresh an
open detail view. Ordinary background refetches preserve the composer. A failed detail read blocks
launch until a successful **Retry**, while preserving your instruction and selections. The displayed
content is a snapshot, not a guarantee of the vendor’s current state. While connection or scope metadata is being refreshed,
launching and dragging tickets are temporarily disabled. Reads carry the captured source and
connection identity, so changing a connection cannot mix another source’s ticket into the current
draft. An unchanged scope preserves the draft; a changed scope clears it. Submitting the same search
again refreshes its results from page one. Detail refetches revalidate with the provider.

Opening an issue reads up to 30 comments, each capped at 4,000 characters, and shows them under
the description oldest first. Jira returns the 30 most recent; for Linear the page is whichever
end of the thread its API serves first, which has not been confirmed against a live workspace, so
a longer thread is reported as partial rather than as "the latest". A task prompt spends at most
30,000 characters on comments, keeping the newest that fit. Only comments the token's account
may see are returned. Attachments and custom fields are not fetched.

Previews are capped at 8,000 characters and detail descriptions at 60,000. If conversion drops
unsupported content, the description or a comment reaches its cap, the thread is partial, or the
comments could not be read at all, the composer says so and requires acknowledgment; you can add
supplemental context. Comments that could not be read are never shown as "no comments". Final prompts over 100,000 characters
must be edited before launch. Tracker credentials are not forwarded to agents by default:
a source link does not grant the agent access to omitted context.

## Recovery

| Symptom | Action |
| --- | --- |
| Connect disabled | Save credentials for this project. Jira URL must be a Cloud site origin without a path, embedded credentials, query or fragment. |
| Access denied | Check token expiry, read scopes, account permissions and selected team/project. Replace credentials in this project and reconnect. |
| Source discovery unavailable | Check connectivity and the Jira site URL; retry. Saved credentials remain local; no new scope association is saved when discovery or validation fails. |
| Source changed | Reconnect deliberately to the new site/workspace in Settings. |
| Rate limited | Wait for the indicated cooldown before Retry. Refresh does not bypass vendor cooldown. |
| Saved connection but no credentials | Configure project credentials and reconnect, or disconnect locally. |
| Expired result page | Restart the search; cursors are bound to the source, scope, query and server process. |
| Cannot save/disconnect scope | Restore write access to the project's `.ai/cezar` directory and retry. |
| Cannot save/remove credentials | Restore owner-only write access to `CEZ_HOME/tracker-connections` (default `~/.cezar/tracker-connections`) and retry. |

Deleting `.ai/cezar/tracker.json` removes only the non-secret connection. Ticket content
is not mirrored there, and already-created run snapshots remain in run history.

## Adding another provider

Developers and coding agents should follow [Adding an issue tracker](adding-issue-tracker.md)
for the extension points, invariants, implementation checklist and verification gate.

## Automatic list checks

Opening a configured Jira/Linear list starts a shared server-side check of the first 50 matching
issues every 60 seconds (from completion of the previous request). Hidden browser tabs, mobile detail views and
closed lists hold no observation demand. Desktop detail keeps the adjacent list visible and observed. Multiple tabs with the same project, connection and
filters share the check. Returning to a stale view checks once; it does not replay missed ticks.

The first page updates automatically. After **Load more**, detected first-page changes produce
**Show changes**; accepting returns to the fresh first page while retaining filters. **Refresh**
explicitly checks and returns to page one. This is not a full-backlog synchronization: changes
confined to later pages may not be detected until those pages are loaded again.

**Last checked** is the time of the last successful fresh provider response, even when its data
is unchanged. It describes the first-page check, not necessarily the displayed paginated snapshot.
Errors keep the displayed rows and last successful timestamp. Retries back off up to five minutes
and respect longer provider cooldowns. Timestamp/spinner animations respect reduced motion.

Local mode uses Cezar's shared WebSocket for opaque version signals and project-scoped HTTP for
snapshots. Remote mode uses authenticated HTTP long reads, with existing SSE configuration
reconciliation; it opens no browser WebSocket. No new configuration or credential access is needed.

## Issue browser layout

Jira and Linear issues fill the screen as a **List** (rows under one collapsible heading per
status) or a **Board** (one column per status); the toolbar switches between them and the choice
is remembered in this browser. Groups and columns follow the vendor's workflow order (Jira status
category, Linear state type) and describe the issues **loaded so far**: counts are not backlog
totals, and a status with no loaded issue has no column. A card or row can be dragged into the
task composer to prefill a task; a card can also be dragged to another column to change the
issue's status.

Opening an issue shows it in a panel beside the surface, with its description, its properties and
the hand-to-agent composer; nothing is opened until you pick an issue. Mobile shows one pane at a
time with a Back to the list link. Workflow and skills pickers are shared with GitHub.
Workflow/engine/skills choices persist between issues; per-issue instruction drafts stay in memory
until leaving the tracker or changing project/association. Automatic list updates preserve the
open issue. Snapshot limitations still require acknowledgment.

## Event automations

After connecting a project tracker, open **Automations → New automation → When Jira / Linear
changes**. Select an advertised event and, for Jira status changes, one or more destination
statuses. The default check interval is 30 minutes. Use the same workflow, backend and instruction
controls as other automations. Save paused, preview matches, then enable. Preview results appear
in the execution log and do not launch tasks. Enabling starts from the current time, not the backlog.

Optional **Required labels** filters candidates before starting an agent. Click a label to
select it; click again to deselect. Every selected name must be present (case-sensitive).
No selection means no label filter. The picker has no text input. Labels come from tasks
in the connected project/team, including closed tasks; **Load labels from more tasks**
fetches another page of 50 tasks. This is not a complete vendor catalog and excludes
inaccessible tasks. Previously saved selections remain visible and removable even when
missing from loaded tasks or when loading fails. Changing project/source/connection isolates
the suggestion cache. This works for Jira and Linear without label-history support.
API/JSON uses `trackerTrigger.requiredLabels`; CLI uses repeatable `--require-label bug`.
The filter uses labels in the polled issue snapshot, not their historical state at creation.
Adding a label is not a trigger and does not scan old skipped tasks; a recent creation can
still be reconsidered during the existing two-minute overlap. Preview uses the same filter.

Jira currently supports issue creation and status changes. Linear currently supports issue
creation. Jira label changes and Linear status/label changes are not advertised: their complete
history semantics have not been verified. The UI explains these limitations rather than treating
a currently matching status as a transition.

Changing the event or connection/scope of an enabled tracker automation establishes a new
current-time baseline; it does not replay the new source’s backlog. Editing its prompt or
status/label eligibility filters preserves the existing checkpoint and pending progress.
Changing the event or connection/scope while paused clears incompatible preview progress without
enabling the rule. Preview uses its bounded lookback; enabling still starts from the current time.

If local execution state is lost, the next check records a new baseline and a visible continuity
gap rather than replaying the old backlog. If an individual queued Jira issue disappears during
history pagination, its history is skipped with a visible gap entry; other issues keep progressing.
Authentication failures and provider outages still stop the scan and retry under backoff.
Jira automation discovery reads the authenticated account’s timezone through `GET /rest/api/3/myself`
(once per scan, within the existing request limit); the token must allow this profile read. If the
timezone cannot be read, the scan retries without advancing its checkpoint. Around daylight
saving changes, discovery includes a wider window; exact event timestamps still control matches.

When an automation launches a task, cezar reads the issue itself and puts its description and
comments into the task, in the same block a manual handoff sends, and links the task to the
ticket. The agent therefore starts with the context on any backend. The read uses the connection
and scope that fired the event; if they have changed since, or the vendor does not answer, the
task still launches and carries the earlier instruction instead: fetch the full current issue
through the vendor API and stop if that read fails or is incomplete. In that fallback the read is
an agent instruction, not a server-enforced fetch. Previewing an automation reads nothing extra.

Long history scans can span multiple polling intervals. Completed pages are checkpointed when
the scan yields near its time budget, so a slow sequence of successful reads does not restart
from page one each time; a request that cannot complete within the hard deadline still fails.

The CLI supports the same flow, for example:

```sh
cez automation add --kind tracker --name 'Jira work' --on issue.status_changed --to-status '<status-id>' --every 30m --prompt 'Implement {{tracker.key}} and prepare a pull request.'
cez automation check '<automation-id>'
cez automation enable '<automation-id>'
```

Use IDs from the project options picker/API, not display names. Copy as CLI preserves the exact
association and trigger as JSON. Credentials remain project-bound; rotation or a changed source
requires updating the automation with the new connection. A legacy status-only definition stays
visible but must be configured with an explicit event before it runs.

An automation launches an ordinary agent workflow. The agent can follow instructions to prepare
a PR or update a vendor status; the scheduler itself does not guarantee these outcomes or merge
PRs. Tracker automation agents receive the captured project's credentials; those are never
substituted with credentials from a later connection. Cezar redacts known secrets from run output,
but does not sandbox a trusted agent against reading local files or sending network requests.

Delivery receipts for tracker events are retained while the automation definition exists, including
when paused. This protects resuming an unfinished historical scan from launching old events twice,
but disk usage and receipt lookup cost grow with the number of distinct events. Deleting the
automation lets receipts older than 90 days expire through normal compaction. This is a conservative
interim retention policy; GitHub and schedule receipt retention is unchanged.
