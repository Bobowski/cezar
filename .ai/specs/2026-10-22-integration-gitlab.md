# Integration provider: GitLab (gitlab.com + self-managed)

> Slug: `integration-gitlab` · Updated: 2026-10-22 · Status: draft for review.
> Builds on the binding umbrella spec [integration-providers](2026-10-22-integration-providers.md)
> (manifest, facets, anchors, connections, contract, routes, Issues view, automations, linking).
> **Supersedes the GitLab half of #847** and its spec PR #848
> (`2026-08-10-forge-provider-adapters.md`, never merged). It takes the live-verified evidence of
> PR #1226 (glab 1.118 vs gitlab.com) and of the downstream fork described in
> [#1226 (comment)](https://github.com/open-mercato/cezar/pull/1226#issuecomment-6217599142)
> (self-managed GitLab 19.x CE) as input; code from #1226 may be ported, its `ForgeDriver` shape is not.

## Evidence legend

Every vendor claim carries one tag:

- **[docs]** — stated by the cited official documentation. Web tools were unavailable in the
  session that wrote this spec, so these were **not re-fetched on 2026-10-22**; the implementer
  re-checks each against the URL before relying on it (one checklist item in Phase G0).
- **[live]** — observed against a real instance in #1226 (gitlab.com, glab 1.118) or the downstream
  fork (self-managed 19.x CE). Strongest evidence we have.
- **[local]** — verified on the writing machine (`brew info glab` → stable **1.124.0**, 2026-10-22).
- **[assumption]** — design inference; must be proved by a test or a live check before shipping.

## TLDR

- One provider directory `packages/cezar/src/integrations/gitlab/`, **remote-anchored**, role
  **code host** + **work source**. Facets: `workItems`, `changeRequests`, `merge`, `publish`,
  `clone`, `automation`, `link`, `agentAccess` — every one of them.
- **Connection: `cli` (glab) first, `token` (PAT → REST v4) second.** Both drive the **same REST v4
  client**: glab is used as an authenticated *transport* (`glab api --hostname H …`), not as a set
  of human-oriented subcommands. One zod schema set, two transports, identical normalized output.
- Self-managed is first class: host discovered from glab's own config / `GITLAB_HOST` / the token
  store (no host table to write), **subgroups** carried as a full project path, **relative URL
  roots** (`https://intranet.acme/gitlab/`) taken from the instance base the connection reports,
  **self-signed CAs** inherited from glab's per-host `ca_cert` or, for tokens, an optional CA file.
- Draft MR is created by `POST /projects/:id/merge_requests` (JSON response, `web_url`) — no stdout
  URL scraping. Merge supports **auto-merge (merge when pipeline succeeds)**, squash, approvals.
- Automations advertise only events provable from GitLab history (resource events, `created_at`,
  `merged_at`); reviewer events wait (§ Open questions).

## Problem

A team on gitlab.com or a self-managed GitLab gets plain-git cezar: no issues/MR browsing, no draft
MR from the review gate, no CI glyphs, no merge, no clone, no automations, and run bookkeeping drops
every `/-/merge_requests/N` link because `runs/store.ts` and `runs/task-refs.ts` match `github.com`
only. #847 asked for this in August; #1226 implemented it on the old `ForgeDriver` seam and proved
the GitLab mechanics live, but the umbrella spec replaces that seam, and #1226 left merge,
automations, sub-path instances and the `workflows/run.ts` PR nodes uncovered.

## Non-goals

- Epics, iterations, boards, OKRs, requirements, vulnerability reports, CI job control (retry/play),
  the Web IDE, GitLab Duo. Issues + MRs + pipelines-as-glyphs only.
- GitLab **work-item** types other than issue/task/incident (the Issues REST API covers those).
- Creating issues, editing MRs beyond draft→ready, approving MRs from cezar (a cezar user approving
  their own agent's MR defeats the gate; out of scope by design).
- Webhooks / system hooks. Polling only (umbrella non-goal).
- Gitea/Forgejo (GitLab-API-*incompatible*), GitLab API v3 or GitLab < 15.0 (see § Compatibility floor).

## Vendor research

### The CLI: `glab`

| Question | Finding | Tag |
| --- | --- | --- |
| Official? | Yes. Started as `profclems/glab`, adopted by GitLab in 2022; lives at [gitlab.com/gitlab-org/cli](https://gitlab.com/gitlab-org/cli), docs at [docs.gitlab.com/cli](https://docs.gitlab.com/cli/). Maintained by GitLab staff, frequent releases (1.118 in #1226's run, 1.124.0 in Homebrew today). | [docs] [live] [local] |
| Install | macOS/Linux `brew install glab`; Windows `winget install glab.glab` / `scoop install glab`; Linux `.deb`/`.rpm` from the [releases page](https://gitlab.com/gitlab-org/cli/-/releases), distro packages (Arch, Alpine, Nix, snap) are community. No official apt repo. [Install docs](https://gitlab.com/gitlab-org/cli#installation). | [docs] [local: brew] |
| Auth | `glab auth login --hostname H` (interactive; token paste or OAuth browser flow for gitlab.com), `--stdin` for a piped token; `glab auth status [--hostname H]`. [auth docs](https://docs.gitlab.com/cli/auth/). | [docs] [live] |
| Credential storage | `config.yml` in glab's config dir — `~/.config/glab-cli/` (`GLAB_CONFIG_DIR` overrides; `%APPDATA%` on Windows), per-host block with `token`, `api_host`, `api_protocol`, `git_protocol`. Token is **plaintext in that file** unless the user chose the OS keyring at login. [config docs](https://docs.gitlab.com/cli/config/). | [docs] |
| Env | `GITLAB_TOKEN` (also `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`), `GITLAB_HOST` / `GL_HOST`, `GLAB_CONFIG_DIR`, `NO_COLOR`. The old `NO_PROMPT` variable is **deprecated** — #1226 hit this live. [env docs](https://docs.gitlab.com/cli/#environment-variables). | [docs] [live] |
| Self-managed / TLS | Any host via `--hostname`/`GITLAB_HOST`; per-host `ca_cert` (custom CA bundle) and `skip_tls_verify` keys, set with `glab config set ca_cert /path --host H`. [config docs](https://docs.gitlab.com/cli/config/set/). | [docs] |
| Relative URL root | glab's `api_host` may carry a path; `glab auth status` prints a `REST API Endpoint: https://host/gitlab/api/v4/` line — the fork reads the instance base from it. | [live: fork] [docs] |
| JSON output | `glab issue list`, `glab mr list`, `glab mr view`, `glab repo view` take `--output json` (`-F json` on some commands; the short flags **differ between `issue list` and `mr list`** — use the long form). JSON is the raw REST object. | [live] [docs] |
| Raw passthrough | `glab api <endpoint>` — REST and `glab api graphql -f query=…`; `-X` method, `-f`/`-F` fields (`-F` types numbers/booleans, `@file` reads a file), `-H` headers, `--paginate`, `-i/--include` (status line + headers), `--hostname H`; placeholders `:id`, `:fullpath`, `:branch` resolved from the cwd's repo. [api docs](https://docs.gitlab.com/cli/api/). | [docs] [live] |
| Pagination | `--paginate` emits **one JSON array per page** (not a merged array); GraphQL needs `$endCursor`. | [live: fork] [docs] |
| Error signalling | `glab api` exits **0 on an HTTP 404**, error only on stderr (`glab: 404 Not Found (HTTP 404)`); high-level commands print boxed errors on stderr. Exit code alone is not trustworthy. | [live] |
| Rate limits | gitlab.com: authenticated API ~2,000 req/min per user, 429 with `RateLimit-*`/`Retry-After` headers ([gitlab.com limits](https://docs.gitlab.com/user/gitlab_com/#rate-limits-on-gitlabcom)); self-managed: admin-configured, often off ([user & IP limits](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/)). | [docs] |
| Gaps | No JSON from `glab mr create`/`mr merge` (prints a URL / prose); no batched pipeline status; no "list hosts" JSON (`auth status` is prose on stderr, exits non-zero when any host is logged out); `--no-editor` on `mr create` *adds* a prompt in 1.118. | [live] |

### REST v4 / GraphQL endpoints used

Base `<instance>/api/v4`, project addressed by **URL-encoded full path** (`group%2Fsub%2Frepo`)
([REST basics](https://docs.gitlab.com/api/rest/#namespaced-paths)). Auth header
`PRIVATE-TOKEN: glpat-…` for the token transport ([auth](https://docs.gitlab.com/api/rest/authentication/)).
Offset pagination `page`/`per_page` ≤ 100 with `X-Next-Page`
([pagination](https://docs.gitlab.com/api/rest/#pagination)). GraphQL at `/api/graphql`
([GraphQL](https://docs.gitlab.com/api/graphql/)). Endpoint list is in the facet table below; each
row cites its API page.

### Recommendation: **both — `cli` (glab) preferred, `token` fallback**

1. **`cli` first.** Official, maintained, owns the credential (cezar holds nothing — the property
   GitHub relies on), already solves self-managed hosts, custom CAs and relative roots, and
   `glab api` reaches **every** endpoint we need, so no facet is CLI-blocked. Using `glab api` (not
   `glab issue list`) as the transport keeps one REST schema set, makes errors parseable via
   `--include`, and dodges the per-command flag drift seen live.
2. **`token` second**, through the managed per-project store (umbrella § Connection strategies),
   for: machines where glab cannot be installed (locked-down Windows, hosted cockpit), a CI-run
   cockpit, and users who refuse a plaintext `config.yml`. Fields: instance URL, PAT, optional CA file.
3. **Plain git tier (no glab, no token):** discovery still shows the GitLab remote (*"Sign in to
   gitlab.acme.internal"*), clone uses `git clone`, and publish may fall back to GitLab **push
   options** (`git push -o merge_request.create -o merge_request.draft …`,
   [push options](https://docs.gitlab.com/topics/git/commit/#push-options-for-merge-requests)) —
   the MR URL is read from the `remote:` lines. [docs][assumption: `draft` option availability per version]

## Mapping onto the umbrella facets

### Anchor and discovery (zero-network)

`discover()` classifies every remote. A remote's host is GitLab when, in order:

1. it is `gitlab.com` (well-known);
2. it is a host key in glab's `config.yml` or equals `GITLAB_HOST`/`GL_HOST` — read **synchronously**
   with a 30 s TTL exactly like `packages/cezar/src/github-hosts.ts` does for `gh`'s `hosts.yml`
   (the fork asked for this in place of `auth status` subprocesses, #1226 Q2). The parser is a zod
   **pick** of `hosts.<h>.{api_host, api_protocol}`; the `token` value is never read into a variable
   that outlives the parse, never logged, never cached;
3. it is the host of a stored `gitlab` token connection;
4. otherwise, a first DNS label `gitlab` (`gitlab.acme.com`) yields a **candidate** shown in Settings
   → Integrations as *"Looks like GitLab — sign in"*, never an active integration (same "a name is a
   guess" rule as `github-hosts.ts`).

`glab auth status` (async, off the request path, at most once per 10 min) only refreshes signed-in
state and the `REST API Endpoint:` base; it never gates classification.

**Project path and instance base.** `ParsedRemote` gains an additive `path` (all segments) — the
current last-two-segments parse loses subgroups. For an HTTPS remote under a relative root
(`https://intranet.acme/gitlab/grp/sub/app.git`) the path is ambiguous (`gitlab` could be a group);
it is resolved by stripping the **instance base path** the connection knows (glab `api_host` /
`REST API Endpoint`, or the token form's instance URL). SSH remotes never carry the root. The web
origin (scheme, port, root) comes from the connection, never from an SSH remote's host/port.
Anchor: `{ kind:'remote', remote, host, path: 'grp/sub/app' }`; integration id `gitlab`
(`gitlab-2` for a second GitLab remote). [assumption, pinned by `discover.test.ts` fixtures]

### Transport (`integrations/gitlab/transport.ts`)

```ts
interface GitlabTransport {           // both return parsed JSON + headers, or a typed failure
  rest(method: 'GET'|'POST'|'PUT', path: string, fields?: Record<string,string|number|boolean>): Promise<GlResponse>;
  graphql(query: string, variables: Record<string, unknown>): Promise<GlResponse>;
}
```

- **GlabTransport:** `execFile('glab', ['api', '--hostname', host, '--include', '-X', M, path, ...fields])`
  via `integrations/shared/cli-exec.ts`; cwd = project root; env adds `GLAB_NO_PROMPT`-equivalent
  only after G0 confirms the current name [assumption], `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`;
  stdin closed. The status line from `--include` decides success, so the exit-0-on-404 quirk cannot
  leak; `RateLimit-Remaining`/`Retry-After`/`X-Next-Page` come from the same headers. Fields always
  as separate argv elements (`-f key=value`, `-F` for typed), never a shell string; a body field
  longer than 64 KB goes through `-F description=@<tmpfile>` [docs].
- **HttpTransport:** `integrations/shared/http-transport.ts` (today's `tracker/transport.ts`):
  `PRIVATE-TOKEN` header, deadline, size cap, no cross-origin redirect, cooldown on 429. Custom CA:
  `NODE_EXTRA_CA_CERTS` already works process-wide [docs: Node]; the connection's optional `caFile`
  is read once into an undici `Agent({ connect: { ca } })` scoped to that connection. There is **no**
  "skip TLS verify" toggle in cezar — a user who needs it sets it in glab, where it is their call.
- Page loop owned by cezar (`page`, `per_page=100`, stop on empty `X-Next-Page`), bounded by a
  per-call budget like GitHub's timeline loop; `--paginate` is not used.

### Facet → command table

`P` = `projects/<enc(path)>`. Every row runs through either transport; the argv column shows the glab form.

| Facet / op | glab argv (`glab api --hostname H --include …`) | JSON fields used | API docs |
| --- | --- | --- | --- |
| availability | `user` (+ `version` once/day) | `username`; `version` | [users](https://docs.gitlab.com/api/users/#retrieve-the-current-user), [version](https://docs.gitlab.com/api/version/) |
| project | `P` | `id`, `path_with_namespace`, `web_url`, `default_branch`, `merge_method`, `squash_option`, `only_allow_merge_if_pipeline_succeeds`, `forked_from_project.id` | [projects](https://docs.gitlab.com/api/projects/#retrieve-a-project) |
| workItems.list | `P/issues?state=opened&scope=all&order_by=updated_at&sort=desc&with_labels_details=true&per_page=50&page=N[&search=q&in=title,description][&labels=a,b]` | `iid`, `title`, `state`, `author.username`, `assignees[].username`, `labels[].{name,color}`, `created_at`, `updated_at`, `web_url`, `user_notes_count`, `description` | [issues](https://docs.gitlab.com/api/issues/#list-project-issues) |
| workItems.get | `P/issues/:iid` | as above + `closed_at`, `issue_type` | same |
| workItems.thread | `P/issues/:iid/notes?sort=asc&order_by=created_at`, `P/issues/:iid/resource_label_events`, `…/resource_state_events`, `…/resource_milestone_events` | notes: `id`,`body`,`author`,`created_at`,`system`; events: `action`,`label.name`,`state`,`created_at`,`user` | [notes](https://docs.gitlab.com/api/notes/), [label events](https://docs.gitlab.com/api/resource_label_events/), [state events](https://docs.gitlab.com/api/resource_state_events/) |
| changeRequests.list/search | `P/merge_requests?state=opened\|merged\|closed\|all&…` (same params) | issue fields + `draft`, `source_branch`, `target_branch`, `sha`, `merged_at`, `reviewers[]` | [MRs](https://docs.gitlab.com/api/merge_requests/#list-project-merge-requests) |
| changeRequests.thread | `P/merge_requests/:iid/discussions`, resource events as above, `…/approvals` | `notes[].position` (diff comments), `resolvable/resolved`; approvals `approved_by[].user` | [discussions](https://docs.gitlab.com/api/discussions/), [approvals](https://docs.gitlab.com/api/merge_request_approvals/) |
| status by branch | `P/merge_requests?source_branch=B&state=all&order_by=created_at&sort=desc&per_page=5` | newest `iid`, `state`, `draft`, `web_url` | MRs |
| changes (diff) | `P/merge_requests/:iid/diffs?per_page=50&page=N` (GitLab ≥ 15.7; `…/changes` is deprecated) | `old_path`, `new_path`, `new_file`, `renamed_file`, `deleted_file`, `diff`, `collapsed`, `too_large`, `generated_file` | [list MR diffs](https://docs.gitlab.com/api/merge_requests/#list-merge-request-diffs) |
| checks (glyphs, batched) | `graphql` `project(fullPath:$p){ mergeRequests(iids:$iids){ nodes{ iid headPipeline{ status } } } }` | `iid`, `headPipeline.status` | [GraphQL MergeRequest](https://docs.gitlab.com/api/graphql/reference/#mergerequest) |
| checks (merge panel) | `P/merge_requests/:iid` → `head_pipeline.id`; `P/pipelines/:id/jobs?per_page=100` | `name`, `status`, `allow_failure`, `web_url` | [jobs](https://docs.gitlab.com/api/jobs/#list-pipeline-jobs) |
| merge.state | `P/merge_requests/:iid` (+ `…/approvals`) | `detailed_merge_status`, `has_conflicts`, `draft`, `blocking_discussions_resolved`, `merge_when_pipeline_succeeds`, `sha`, `user.can_merge` | [MR detail](https://docs.gitlab.com/api/merge_requests/#get-single-mr), [merge status](https://docs.gitlab.com/api/merge_requests/#merge-status) |
| merge.merge | `-X PUT P/merge_requests/:iid/merge -f sha=<head> -F squash=… -F should_remove_source_branch=… [-F auto_merge=true]` | `state`, `merge_commit_sha`, `squash_commit_sha`, `web_url` | [merge an MR](https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request) |
| merge.cancelAuto | `-X POST P/merge_requests/:iid/cancel_merge_when_pipeline_succeeds` | `merge_when_pipeline_succeeds` | same page |
| publish (draft MR) | `-X POST P_src/merge_requests -f source_branch=B -f target_branch=T -f title="Draft: …" -F description=@tmp -F remove_source_branch=true [-F target_project_id=N]` | `iid`, `web_url` | [create MR](https://docs.gitlab.com/api/merge_requests/#create-mr) |
| publish → ready | `graphql` `mutation{ mergeRequestSetDraft(input:{projectPath:$p, iid:$i, draft:false}){ errors } }` | `errors` | [mutation](https://docs.gitlab.com/api/graphql/reference/#mutationmergerequestsetdraft) |
| clone | `glab repo clone <path> <dir> -- --progress` (cli); `git clone <https url>` (token / none) | — | [repo clone](https://docs.gitlab.com/cli/repo/clone/) |
| link (opt-in) | `-X POST P/issues/:iid/notes -F body=@tmp` | `id` | notes |
| automation | see § Automations | | |

**Normalization notes** (each a fixture test):
- `WorkItem.id` = `iid` as string; `key` = `#12` (issue) / `!17` (MR); `kind` from endpoint.
  `state`: `opened`→`open`, `closed`→`closed`, `merged`→`merged`, `opened`+`draft`→`draft`;
  `locked` → `open` with `stateLabel:'locked'`. `state=closed` on MRs **excludes merged** [live] —
  the "closed" filter queries both where the UI means "not open".
- Body: GitLab Flavored Markdown passes through; relative upload links (`/uploads/…`) are absolutized
  against the **project** web URL; `bodyLoss` set for `[[_TOC_]]`, embedded diagrams. [docs: GLFM]
- Thread: `system:true` notes become timeline events only when no resource event covers the same
  change (resource events win; system-note prose is localized and never parsed for semantics).
- Diffs: no `---`/`+++` headers, count `+`/`-` positionally [live]; `collapsed`/`too_large`/empty
  `diff` → `truncated:true`, never `0/0` [live]. Same caps as GitHub (`DIFF_CAP` family).
- Pipeline glyph: `success`→passing; `failed`→failing; `created`,`waiting_for_resource`,`preparing`,
  `pending`,`running`,`scheduled`,`waiting_for_callback`→pending; `canceled`,`canceling`,`skipped`,
  `manual` and no pipeline→`null` [live]. GraphQL returns the enum upper-case — lower-cased first.

### Merge facet

Maps onto the existing `githubPrMergeStateSchema` fields (umbrella: reused under neutral names):

| cezar field | GitLab source |
| --- | --- |
| `mergeable` | `has_conflicts` → `conflicting`; `detailed_merge_status` `checking`/`unchecked` → `unknown`; else `mergeable` |
| `reviewDecision` | `approvals.approved` + `approvals_left` → `approved` / `review-required`; any reviewer `requested_changes` (17.x+) → `changes-requested` [assumption: field availability on Free] |
| `methods`/`defaultMethod` | project `merge_method` (`merge`/`rebase_merge`/`ff`) + `squash_option` (`always`/`default_on`/`default_off`/`never`) → `merge`, `squash`, `rebase` (ff/rebase_merge both map to `rebase`) |
| `eligibility`/`blockers` | `detailed_merge_status` [docs: merge status values]: `mergeable`→ready; `ci_still_running`,`checking`→pending; `not_approved`,`discussions_not_resolved`,`draft_status`,`ci_must_pass`,`need_rebase`,`conflict`,`blocked_status`,`requested_changes`,`external_status_checks`→blocked (one blocker each, code = the GitLab value); `not_open`→terminal; unknown values → `unknown` with the raw code |
| `canMerge` | `user.can_merge` |
| `canOverride` | always `false` — GitLab has no admin-bypass merge via REST |

**Auto-merge.** GitLab's "merge when pipeline succeeds" (renamed *auto-merge*) needs one additive,
provider-neutral field pair that GitHub can also fill: `autoMerge?: { available: boolean,
enabled: boolean }` in merge-state and `autoMerge?: boolean` in the merge request body. When the
pipeline is running and `autoMerge` is requested, cezar sends `auto_merge=true` on instances that
accept it, else `merge_when_pipeline_succeeds=true` (chosen from `version`, cached per host)
[assumption: the exact version the rename landed; G0 verifies]. Response `merged:false,
autoMergeEnabled:true` needs the 200 branch of the merge response widened — **an umbrella contract
change** (see report suggestions), because today it pins `merged: z.literal(true)`.

HTTP mapping of refusals: `405`/`406` → 409 with the blocker list; `409` (sha mismatch) → 409
"the branch moved"; `401`/`403` → 403 with the connection hint. Always pass `sha` so a moved head
never merges unseen code.

### Publish facet

Same prelude as GitHub (`preparePublish`: final autosave, conflicted-worktree refusal, push to the
push remote via `resolveTaskRemotes`). Then **one REST call** returns `web_url` — no regex over glab
output. Target branch = `run.baseBranch` normalized, default branch for a raw SHA. **Fork MRs**: when
the push remote's project differs from the base remote's, create on the source project with
`target_project_id` (looked up from the base project; cached). Title prefixed `Draft: `
([draft MRs](https://docs.gitlab.com/user/project/merge_requests/drafts/)); description carries the
cross-provider footer (§ Linking). The URL is validated against the instance origin before it is
stored on the run.

### Clone facet

`parseRepoRef` accepts `https://<gitlab host>[/<root>]/<path>` and `<host>/<path>` for any host
discovery recognises, with subgroups; the one-segment target-directory rule and `cleanupCheckout`'s
ownership proof stay untouched. cli: `glab repo clone` (configures glab as git credential helper so
fetch/push keep working [live #1226]); token/none: `git clone` with `GIT_TERMINAL_PROMPT=0` — the
PAT is **never** written into the clone URL or `.git/config`.

### Agent access and redaction

Manifest env names: `GITLAB_TOKEN`, `GITLAB_HOST`, `GLAB_CONFIG_DIR` — forwarded **only** when the
run opts in (umbrella). Redaction pattern for every documented prefix
([token prefixes](https://docs.gitlab.com/security/tokens/#token-prefixes)) [docs]:
`\bgl(?:pat|oas|dt|rt|rtr|cbt|ptt|ft|imt|agent|soat|ffct|wt)-[0-9A-Za-z_\-.]{20,}\b`.

## Connection and auth

| Strategy | Ready when | Settings flow |
| --- | --- | --- |
| `cli` | `glab` on PATH, version ≥ **1.50** [assumption: oldest with `api --hostname` + `--include` behaving as pinned], host signed in | Install (manifest hints: brew / winget / scoop / release `.deb`/`.rpm`) → **Sign in** opens `glab auth login --hostname <host>` in the user's terminal (`open-in-terminal.ts`) |
| `token` | managed record for the host exists and `GET /user` succeeds | write-only form: **Instance URL** (https, may include a path, e.g. `https://intranet.acme/gitlab`), **Access token** (secret; scopes `api` — `read_api` suffices for read-only, publish/merge then show "needs `api` scope"), **CA file** (optional absolute path) |

Docs for scopes: [PAT scopes](https://docs.gitlab.com/user/profile/personal_access_tokens/#personal-access-token-scopes).
A group/project access token works the same (it is a PAT-shaped `glpat-`). OAuth tokens via glab
are opaque to cezar. Expired token → reason *"GitLab rejected the token for <host> (401) — run
`glab auth login --hostname <host>`"* [live: readable reason].

## Contract additions (GitLab-specific, on top of the umbrella)

All in `packages/contract/src/integrations.ts`; none touch frozen `/github*` shapes.

- `integrationProviderIdSchema` already contains `gitlab`.
- `gitlabTokenFieldsSchema = { instanceUrl: httpsUrl (path allowed, no query/fragment), token: string.min(20), caFile?: absolute path }` — served through the manifest's schema-driven form.
- `changeRequestMergeStateSchema` (neutral name): **additive** `autoMerge?`, `approvals?: { required: number|null, given: number, approvedBy: string[] }`.
- Merge body: additive `autoMerge?: boolean`; response 200 branch gains `merged: false` + `autoMergeEnabled: true` (umbrella decision).
- `forgeInfoSchema.kind` / `backendCheckSchema.name` / `projects[].forge` gain `gitlab` / `glab`
  (umbrella-owned widenings; listed so GitLab's PR does not forget them).

## UI specifics

- Switcher label `GitLab · grp/sub/app`; self-managed shows the host (`GitLab · gitlab.acme.internal · grp/app`).
- Vocabulary from manifest: "merge request", key `!17`; filter chips *Issues / Merge requests*; MR
  rows show `Draft`, pipeline glyph, approvals `2/3`.
- Merge panel: method picker from project settings; **"Merge when pipeline succeeds"** button
  replaces "Merge" while the pipeline is running and `autoMerge.available`; "Cancel auto-merge"
  when enabled.
- Detail links: issues open `/-/issues/N` (GitLab 19 redirects to `/-/work_items/N` [live]); MR
  changes link `/-/merge_requests/N/diffs` [live].
- Bookmarklet matcher covers GitLab URL shapes on recognised hosts (gitlab.com CSP verified to allow
  navigation [live #1226]; self-managed CSP is admin-set — unverified).
- `clone-project-dialog.tsx` placeholder lists the recognised hosts.

## Automations

Event source `integrations/gitlab/events.ts` implements `AutomationEventSource` over the shared poll
cycle (cursor, receipts, leases, baselining unchanged). Advertised events — **each verified from
history**, per the umbrella rule:

| Neutral event | Candidate query | Verification |
| --- | --- | --- |
| `work_item.created` | `P/issues?created_after=<cursor>&order_by=created_at&sort=asc` | `created_at` > cursor |
| `work_item.labeled` / `.unlabeled` | for each filter label: `P/issues?labels=<L>&state=opened&updated_after=<cursor − lookback>` **plus** the stored membership set diff (GitLab does not always bump `updated_at` on label changes [live]) | `resource_label_events` row `action=add/remove`, `label.name=L`, `created_at` > cursor |
| `work_item.status_changed` | `P/issues?updated_after=<cursor>` | `resource_state_events` (`closed`/`reopened`) after cursor |
| `change_request.opened` | `P/merge_requests?created_after=<cursor>` | `created_at` |
| `change_request.merged` / `.closed` | `P/merge_requests?state=merged\|closed&updated_after=<cursor>` | `merged_at` / `resource_state_events` |

Not advertised in phase 3: `change_request.review_requested` and `review_submitted` — reviewer
assignment has no resource-event history in REST (only localized system notes) [assumption — see
open question 2]. Template tokens: `item.*` (umbrella) plus `item.namespace` (full project path) and
`item.iid`; `github.*` aliases are **not** populated for GitLab events (would lie about the source).
The fork's per-issue "one live task" and `Retry-After`/`RateLimit-Reset` cooldown carry over.
Budget: ≤ 2 list calls + ≤ 20 event calls per poll per integration, under gitlab.com's limit by two
orders of magnitude.

## Run bookkeeping reference patterns

Manifest `referencePatterns` (host set = discovered GitLab hosts + their instance roots):

- URL: `https?://<host>(?::\d+)?<root>/(?<path>[^\s]+?)/-/(?<kind>merge_requests|issues|work_items)/(?<n>\d+)` — `work_items` [live, 19.x].
- Keys: `!\d+` (MR), `<path>!\d+`, `<path>#\d+`; bare `#\d+` only when GitLab is the code host (umbrella).
- Worded: `merge request !N`, `MR !N`, `merge request #N` [live: fork], and the hand-off heading
  `Address GitLab merge request !N` / `Fix GitLab issue #N` — `lib/work-item-task.ts` and
  `task-refs.ts` change in one commit (documented coupling).
- `RunRecord.workItemRefs` entries `{ providerId:'gitlab', itemId:'17', key:'!17', kind:'change_request', url }`.

## Cross-provider linking

As a **work source**, GitLab supplies the footer `Closes <path>#<iid>` when the code host is GitLab
(same project → `Closes #12`), and a plain URL line when the code host is another provider (GitLab
cannot close an issue from a GitHub PR). Closing keywords per
[default closing pattern](https://docs.gitlab.com/user/project/issues/managing_issues/#default-closing-pattern) [docs].
As a **code host**, GitLab's MR description carries the other work source's footer (`PROJ-42`,
`AB#1234`, `Fixes TEAM-12`); GitLab's own Jira integration then links it when the instance has it
configured [docs: [Jira issue integration](https://docs.gitlab.com/integration/jira/)].
`link` facet (opt-in, off by default): note on the issue "cezar opened !17".

## Dry-run fixtures

`integrations/gitlab/fixtures/` — **raw REST JSON** (what both transports return), so one set feeds
dry-run and tests: `project.json` (subgroup path), `issues.page1/2.json`, `mrs.json` (draft, merged,
fork MR), `notes.json` (+ system notes), `label-events.json`, `state-events.json`,
`mr-detail.{mergeable,ci_running,not_approved,conflict}.json`, `approvals.json`, `diffs.json`
(collapsed + too_large rows), `pipelines.graphql.json`, `create-mr.json`, `merge.{ok,405,409}.json`,
`auth-status.{ok,logged-out,subpath}.txt`, `glab-config.yml` (with a fake token that must never
appear in any output). `CEZ_DRY_RUN=1` uses a fixture transport; draft MR returns
`<base>/-/merge_requests/777`.

## Implementation phases (umbrella phase 3)

Prereq: umbrella phase 1 (seam, registry, shared plumbing) merged.

- **G0 — verification spike (no product code):** re-check every **[docs]** row against its URL;
  record glab's prompt-suppression env name, the auto-merge param/version, `--include` output
  format; capture real fixtures from gitlab.com and one self-managed instance under a sub-path.
- **G1 — read path:** `integrations/gitlab/{index.ts,manifest.ts,discover.ts,transport.ts,schemas.ts,normalize.ts}`;
  `git-remotes.ts` additive `path`; `gitlab-hosts.ts` (sync config read, mirrors `github-hosts.ts`);
  registry line in `integrations/registry.ts`; workItems + changeRequests (list/search/get/thread/diff/checks).
- **G2 — code host:** `publish.ts`, `merge.ts` (+ auto-merge contract fields), status-by-branch,
  `clone` in `server/checkout.ts`, `workflows/run.ts` PR nodes (`createDraftPr`, `commentOnPr`,
  wait-for-CI) routed through the code-host integration — the gap the fork named.
- **G3 — host tooling:** `core/backend-detect.ts` `glab` probe from the manifest,
  `server-install/steps.ts` glab install/remove, `core/agent-env.ts` opt-in names,
  `core/secret-redaction.ts` pattern, `runs/store.ts` + `runs/task-refs.ts` patterns, bookmarklet.
- **G4 — automations:** `events.ts`, event options, cockpit trigger editor shows GitLab events.
- **G5 — token transport:** `HttpTransport` + Settings form + CA file; conformance suite run twice
  (glab fixture transport and HTTP mock) over the same fixtures.

Each phase is shippable alone; without glab and without a token the project stays plain-git.

## Tests

- `integrations/conformance.test.ts` (umbrella) passes for `gitlab` with both transports.
- `gitlab/discover.test.ts`: gitlab.com; self-managed via config.yml / `GITLAB_HOST`; token-store host;
  `gitlab.*` name → candidate only; subgroup paths; relative root ambiguity resolved by instance base;
  SSH vs HTTPS port/scheme; **no file read beyond config.yml, no network** (spy).
- `gitlab/transport.test.ts`: exit-0 404 → not-found; 429 → cooldown from `Retry-After`; field
  argv never shell-joined; large description via tmpfile; CA agent built only when `caFile` set;
  token never present in errors, logs, cache files.
- `gitlab/normalize.test.ts`: every state/glyph/merge-status mapping row above; `state=closed`
  excludes merged; collapsed diffs → truncated.
- `gitlab/publish.test.ts`: same-project and fork MR; URL host validation; conflicted worktree refusal.
- `gitlab/events.test.ts`: label added without `updated_at` bump still fires once; baseline does not
  replay history; unverifiable candidate dropped.
- `runs/task-refs.test.ts`, `runs/store.test.ts`: MR/issue/work_items URLs under a sub-path host.
- `secret-redaction.test.ts`: every manifest pattern registered (umbrella test) + each GitLab prefix.
- E2E: `packages/web/e2e/issues.e2e.ts` GitLab dry-run project — switcher, MR list, merge panel.
- Regression-proof rule (AGENTS.md): each **[live]** quirk test is shown red without its fix.

## Compatibility floor and backward compatibility

- Supported: gitlab.com and self-managed **GitLab ≥ 15.7** (MR `diffs` endpoint,
  `detailed_merge_status` from 15.6) [docs]. Older instances: availability `reason` names the
  version; read paths that do not need those endpoints still work [assumption].
- No frozen route changes; `/api/v1/github*` never serves GitLab data (GitLab is reachable only via
  `/integrations/*`). Additive widenings as listed in § Contract.
- `.ai/cezar/integrations.json` holds only optional host/role overrides; nothing GitLab-specific is
  required. Token records live in the umbrella's managed store; `ensureDataGitignore` unchanged.
- #1226 users: none on main; its `forge-hosts.json` cache is not read (discovery is now sync).

## Acceptance criteria

1. With glab signed in to gitlab.com and no config, a gitlab.com repo (incl. a subgroup) shows
   **GitLab** in the Issues switcher with issues and MRs, threads with label/state events, CI glyphs
   and diffs — zero cezar settings touched.
2. The same on a self-managed instance at `https://host/gitlab/` with a private CA configured in glab.
3. Review gate creates a **draft MR** (same-project and fork) and the run records `!N` and its URL.
4. Merge panel merges, squashes, and enables/cancels auto-merge; a moved head is refused.
5. A token-only connection (no glab) passes the same conformance suite.
6. A GitLab issue-label automation fires once per label add and never on baseline history.
7. No GitLab token appears in logs, run transcripts, cache files or API responses (test-enforced).
8. `CEZ_DRY_RUN=1` exercises every facet offline.

## Open questions

1. **Auto-merge contract:** widen the merge response's 200 branch (`merged:false, autoMergeEnabled`)
   or add a separate `POST …/auto-merge` route? (This spec proposes the former; umbrella owns it.)
2. **Reviewer events:** poll the `reviewers` array as a state diff (not history-verifiable, so it
   would bend the umbrella rule), or wait for a GitLab history endpoint? Proposed: wait.
3. **`skip_tls_verify`:** should the token transport ever offer it? Proposed: no — glab path only.
4. **Approvals on GitLab Free:** expose `approvals` only when the endpoint returns rules, or always?
5. **Push-option publish** (no glab, no token): ship it in G2 or defer until asked?
