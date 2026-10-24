# GitHub events, extended — PR updates, comments, CI results, pushes and releases; webhook wake-ups; delivery to the owning task

> Status: built (2026-10-24) on `brutus` — see §11 for where the build differs from the text.
> Builds on: `2026-07-25-github-automations.md` (the shipped poll), `2026-09-14-automations-redesign.md`
> (the surface, `kind`, schedules), `2026-10-06-agentic-e2e-checks.md` Phase 3 (`checkout: 'pr-head'`),
> `2026-10-12-cockpit-authentication.md` (the VPS has a public, authenticated origin).
> Backlog item: "extend GitHub events (for automations) — when a PR is updated, etc."

## 1. Problem

Automations react to nine GitHub events (`automations.ts`): PR opened / reviewed / review
requested / re-requested / closed / merged, issue opened / labeled / unlabeled. All are bounded
polls. Three things a VPS cezar is now in a position to do are missing:

- **The PR a task opened keeps living after the task reached review.** A reviewer comments,
  CI goes red, someone pushes a fix-up commit — and nothing tells the task. Today the user
  reads GitHub and types the comment into the thread by hand (the desktop Claude app's
  "address comments" and "fix CI" are exactly the loop cezar lacks).
- **No event for new commits, comments, CI, pushes or releases.** The nine cover the
  issue/PR lifecycle, not what happens inside it.
- **Latency is a poll.** The VPS runs behind Caddy on a domain; GitHub could tell it.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| New events | **PR synchronize; PR, review and issue comments; CI result; push to a branch; release published** | Each closes one loop the owner named. |
| Delivery | **A webhook, when registered, only wakes the poller; the poll stays the source of truth** | One parser, one dedup, reconcile after downtime. Locally, without a URL, nothing changes. |
| Event on a PR a cezar task owns | **Delivered to that run as a message** (Continue), in its worktree; a new run only when no owner exists | The conversation that made the PR is the context that can fix it. |
| Loop guard | **cezar recognises its own traces**: shas it pushed and comments it posted are recorded on the run and ignored as triggers | Works whichever GitHub account the VPS uses (today: the owner's). |

## 3. Events

`automationEventSchema` grows by:

| Event | Source (poll) | Filters |
| --- | --- | --- |
| `pull_request.synchronize` | PR `head.sha` changed since the checkpoint (`/pulls?state=open`, ETag-cached) | labels, author, branch glob |
| `pull_request.commented` | `/issues/:n/comments` since cursor | mention (`@login`, default none), author, labels |
| `pull_request.review_commented` | `/pulls/:n/comments` since cursor | same |
| `issue.commented` | `/issues/:n/comments` on issues | same |
| `check_suite.completed` | `/commits/:sha/check-suites` for open PR heads | conclusion: `success` / `failure` / `any` |
| `push` | `/commits?sha=<branch>&since=` | branch (exact or glob), author |
| `release.published` | `/releases` since cursor | prerelease yes/no, tag glob |

All bounded the way the existing poller is (`HARD_CANDIDATE_CAP`, ETags, backoff). Comment
events carry `{{github.comment.body}}`, `{{github.comment.author}}`, `{{github.comment.url}}`;
CI carries `{{github.check.name}}`, `{{github.check.conclusion}}`, `{{github.check.url}}` and
the failing jobs' names; push carries `{{github.push.before}}`/`after` and the commit subjects.
Templates are the existing `task-template.ts` mechanism with new keys.

`checkout: 'pr-head'` is allowed for every `pull_request.*` event, so a CI-failure automation
can fork from the failing head as the e2e automations already do.

## 4. Webhook wake-up

`POST /api/v1/hooks/github/:hookId` is the one unauthenticated route besides `/health`:

- `hookId` is a random 32-byte id generated when the owner clicks **Register webhook** on the
  project's Automations page; the HMAC secret is a second random value. Both live in
  `.ai/cezar/github-webhook.json` (gitignored; `ensureDataGitignore` learns the name).
- Registration is one `gh api repos/<owner>/<repo>/hooks` call with the cockpit's public origin
  (hosted mode knows it from the request's `Host`; a local cockpit shows the route and says it
  has no public URL — the button is disabled there).
- The handler verifies `X-Hub-Signature-256`, reads only `X-GitHub-Event` and the delivery id,
  **discards the payload** and calls `coordinator.wakeNow(projectId)`, which runs the next poll
  cycle immediately instead of at `nextCheckAt`. Rate-limited to one wake per 5 s per project;
  extra deliveries collapse. Never a launch from the payload.
- The Automations page shows the hook's last delivery time and the result of a **Ping**.

Without a webhook, the poll interval is unchanged. With one, the interval can stay long (the
redesign's default) and latency becomes seconds.

## 5. Delivery to the owning run

A new per-automation field, `deliver: 'new-run' | 'owning-run'` (default `new-run`, the shipped
behaviour). With `owning-run`:

1. The matched item is a PR. The run that owns it is found by `prNumber` on the run records of
   the project (the store already tracks it, `store.ts`), newest first; the run must not be
   `discarded`/`deleted`.
2. If the owner exists, the rendered prompt is delivered to it as a user-visible message
   (`run.ts`'s delivery path, the one Continue uses: live when the run is parked at review,
   queued when it is running). The run's worktree is the one that made the PR, so "fix the
   failing check" happens where the code is. The execution log records
   `delivered-to: <runId>` instead of `launched: <runId>`.
3. If no owner exists (a PR opened by hand), the automation falls back to `new-run` with
   `checkout: 'pr-head'` when set, as today.

Nothing changes for issue events or for `new-run` automations.

## 6. The loop guard

Every run records its traces:

- `pushedShas: string[]` — appended by the draft-PR push (`pr.ts`) and by the repo-git-sync
  push path; capped at 50.
- `postedComments: number[]` — comment ids the run posted (the tracker marker comments
  `markerRefs` already exist; this is the GitHub side of the same idea).

The poller drops a candidate whose source is a recorded trace: a `synchronize` whose new head
is in `pushedShas`, a comment whose id is in `postedComments`, a `check_suite` on a sha in
`pushedShas` **unless** the automation explicitly asks for CI on its own pushes
(`filters.includeOwnPushes: true` — the "fix my CI" case needs exactly that, and it is the one
place a loop is possible, so it also carries the existing per-automation launch cap).

## 7. Security

- The hook route is the only new unauthenticated surface: it accepts nothing but a signature
  check and a wake-up. A forged request without the secret is a 404 (the id is the first
  factor); with the id but a bad signature, 401; a valid one changes nothing a poll would not
  have found anyway.
- Comment bodies reach the agent as task text — the same trust as an issue body today; the
  existing fork-head gating (`allowForkHeads`) applies, and a comment event from a fork PR is
  skipped unless admitted.
- Registering a hook uses the user's own `gh` auth; the secret never leaves the box except in
  that one call.

## 8. Zero config

- No webhook unless the owner clicks Register. Polls stay as they are.
- New state only: `github-webhook.json`, the two trace arrays on run records (optional fields;
  old records parse).
- No new env var.

## 9. Not done here

- Webhook payloads as a source (reconcile-free fast path).
- Non-GitHub hooks (GitLab, Gitea) — the hook route is namespaced for them.
- Tracker (Jira/Linear) comment events — their pollers are separate (`tracker-poller.ts`).
- A per-PR "activity" view in the task thread; delivered messages appear as messages.

## 10. Verification

- Unit: each new poll source against recorded fixtures (`fixtures/` beside the poller), the
  cursor/ETag bookkeeping, the loop guard (own sha / own comment dropped; `includeOwnPushes`
  admits), owner lookup (newest non-discarded run with the `prNumber`), delivery vs launch in
  the execution log.
- Hook handler: signature ok → wake called once per 5 s; bad signature → 401; unknown id → 404;
  payload never parsed (a malformed body still wakes).
- Contract parity, BC inventory for the hook route and the new fields.
- VPS: register the hook on fancy-fence-panels; open a task that makes a PR; comment on it →
  the comment arrives in the thread within seconds; push a commit that breaks CI → the failure
  is delivered to the same run; the run's own push does not re-trigger.

## 11. As built (2026-10-24)

Where the code (`automations/github-activity.ts`, `automations/owning-run.ts`,
`automations/webhook.ts`, `server/automation-webhook.ts`, `runs/github-traces.ts`) differs from
the text above, and why:

- **Comment sources are repo-wide**: `/repos/:r/issues/comments?since=` and
  `/pulls/comments?since=` — one read each, instead of one per issue. A comment is observed at its
  `updated_at` (an edit-only page still moves the cursor) and launches only if CREATED since the
  cursor. A submitted review's diff comments collapse to one candidate per PR per poll, bodies
  joined. Comment bodies never reach a receipt; a retry points the prompt at the comment's URL.
- **`push` diffs branch heads** (`/branches`, or `/branches/<name>` for an exact name) against
  `branchHeads` and reads `/compare/<before>...<after>` for the subjects — `/commits?since=` would
  miss a fast-forward of old commits. `synchronize` diffs `prHeads` the same way. Both record the
  heads on first sight (and after every enable) and fire nothing then; their candidates are
  `cursorless`, deduplicated by their receipt. Heads of PRs and branches that slide out of the
  capped lists (100 open PRs, 300 branches) are kept — up to 1000 each, newest first; a kept PR
  head is marked `left` and never read for check suites — so one sliding back is diffed against
  what was last seen. A branch with no previous head is a baseline, never a push (sliding in and
  being created look the same); its first move fires. A PR outside the window that a comment
  names is read through `/pulls/:n`, and a moved head found that way fires `synchronize`. An edit
  that changes the events or `branches` clears the heads, as enabling does.
- **ETags** cover `/pulls`, `/releases` and each head's `/check-suites`. A page whose rows a poll
  did not evaluate forgets its ETag, so a `304` never hides rows the cursor has not passed.
- **`wakeNow`** is "every enabled, not backed-off GitHub poll of the project is due now", then the
  workspace scheduler's ordinary reschedule — the same leases, backoff and caps as a timer tick.
  Deliveries the 5-second window collapses arm one trailing wake at its end, and a wake that
  lands while a poll runs (`wakeAt` in the runtime state) keeps that poll due when it persists
  instead of pushing it out a whole interval.
- **Owner lookup** also counts the PR a run created (`pullRequestUrl`) and its `prRefs`, never a
  `pr-head` verifier or a run whose worktree is gone. A delivery takes the ladder a person's
  message takes (queued run → prompt queue of a live session → buffered start → Continue); an
  owner that cannot take it falls back to a new run, and the log row says why.
- **Traces** are also recorded for the task push route, the graph `git.push` node, an in-place
  landing, the `github.pr-comment` node and the agent's own `git push` / `gh … comment` tool calls.
  The repo-sync push of the project checkout belongs to no run and records nothing. An agent's
  `git push` call records `HEAD` provisionally as it starts (so a webhook-woken poll already
  knows it); when it finishes, the shas it really pushed are read off its output (`old..new`,
  `[new branch]`) — or `HEAD` as it left the checkout when the output names nothing — and the
  provisional sha is dropped unless it is one of them (a failed push, `Everything up-to-date`, a
  `git commit && git push`). A comment's
  body is a trace BEFORE it is posted: its fingerprint goes on the run record
  (`postedCommentBodies`, at most 100, each kept 24 hours), so a poll that reads the comment
  before its id comes back — or after a restart — still knows it, and a candidate matches by id
  or by body. For the agent's own tool calls the body is read off the command as the call starts
  (`--body`, `--body-file`, a heredoc, `gh api … -f body=`), and both it and any comment id the
  output prints are kept whatever the call's final status: `gh pr comment … && git push` fails
  after it posted.
- **Registering** needs a hosted cockpit with cezar's own sign-in (not `CEZ_AUTH=0`, where the
  proxy would also stand between GitHub and the route). The secret goes to `gh` on stdin.
- **Comment bodies are data, never instructions** (§7 tightened). `{{github.comment.body}}`
  renders as a pointer — "(the comment is quoted in the GitHub event context below)" — and the
  body itself appears only inside the "GitHub event context (untrusted data)" block, every line
  `> `-quoted, so a body cannot close the block or pose as one of its fields.
- **Who may message a running task.** With `deliver: 'owning-run'`, a comment event is admitted
  only when its `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`, or the automation
  names `filters.authors`, or it opts in with `filters.allowAnyAuthor: true`. A `new-run`
  automation still admits anyone's comment, as before.
