# App Spec: AI Gateways

Date: 2026-10-28
Status: Draft for owner review; documentation only, not authorization to implement.
Scope: evolution of Cezar's existing LLM provider connections, not a new application.
Reference design: [LLM provider connections from the earlier proposal](https://github.com/open-mercato/cezar/blob/544d0c76/.ai/specs/2026-10-27-llm-provider-connections.md).

## Branch isolation and implementation baseline

This PR starts independently from `origin/main` at `4040b404b3e7ab8a34f6383c8d0a4f995861e977`. Its initial commit contains only this spec and its review notes. No implementation commits from [the earlier provider-connections PR #1726](https://github.com/open-mercato/cezar/pull/1726) are included, and merging that PR is not a prerequisite for this PR.

The investigation/reviews below used reference implementation `544d0c76`, which is not in this starting `main`. Statements about existing `LlmProviders`, gateway contracts/CLI/routing and their tests describe that reference branch. Shared Cezar infrastructure (workspace storage, SecretStore, runner interfaces, settings shell) is available on the base, but reference-only gateway behavior must be implemented or deliberately ported into this PR with verification if it remains absent from `main`. Do not copy the earlier branch wholesale. Re-evaluate G1–G4 estimates against the base before implementation; 8–14 commits estimates reuse of the reference design, not proof that its implementation is already merged. Prior review verdicts cover the design and do not certify an implementation on this isolated branch.

The entire implementation will be added to this same PR in later commits. This initial delivery makes no runtime behavior changes.

This document records the conversation's requirements and the proposed operating rules. Once approved, it owns the AI Gateways product behavior; the baseline remains evidence of current behavior until implementation ships. No feature briefs or implementation are included.

## 1. Business Context

### 1.1 Outcome and decision provenance

The operator of a local or VPS-hosted Cezar should configure API connections once and reuse them across coding agents and projects. In the reference implementation the UI calls these LLM providers, offers create/remove only, treats OpenRouter as a special type, and requires an explicit connection choice on each task.

**Explicit user requirements:**

- Rename the feature to **AI Gateways** and give it a separate section in **General Settings**.
- List gateways with an ON/OFF switch; support adding and editing gateways.
- Supply OpenRouter as an initial, editable seed record, not a privileged built-in provider type.
- Keep the existing secret-storage/keychain pattern.
- Add **Default AI gateway** to each coding agent's settings.
- Preserve programmatic configuration for VPS deployment.

**Proposed rules, not separately owner-confirmed:** disabled/keyless seed; ON means available rather than globally selected; native setup remains each agent's initial default; task overrides; no silent fallback; stable connection binding across continuations; disable does not kill a running process. These are specified below so review has a concrete target.

This is an existing-product capability, not a monetization proposal. Paying customer, commercial flywheel, and financial ROI targets were not supplied; this document does not invent them. Operational targets below are proposed acceptance measures, not measured savings. No telemetry is added.

### 1.2 Goals and non-goals

Targets: configure a gateway and an agent default once; create subsequent tasks without reselecting the gateway; repeat a provisioning update without creating another gateway; produce zero unrequested credential/account fallbacks in the regression matrix.

Out of scope: running an inference proxy, load balancing, automatic provider failover, cost-based routing, new accounts/roles, a new secret vault, native-login migration, scheduled API tasks, new provider protocols, and production deployment manifests. No network request or billable turn is caused by the OpenRouter seed.

### 1.3 Ubiquitous language

| Term | Meaning | Source / lifetime |
|---|---|---|
| Agent / runner | Coding-agent program, e.g. Claude Code or Codex | Existing runner registry |
| AI gateway | Named connection to an API endpoint, including a direct provider endpoint | Workspace metadata; shared across projects |
| Protocol | Wire format: Chat Completions, Responses, or Anthropic Messages | Editable gateway capabilities |
| Native setup | Agent's own config and selected native account; it may itself use an external API | Existing profile/config resolution |
| Agent default | Workspace-level native choice or gateway reference for one runner | Persists until operator changes it |
| Task selection | Inherit agent default, explicit native setup, or explicit gateway | Creation/explicit continuation input |
| Resolved binding | Actual native/gateway choice used by a task for a runner | Persisted before launch; stable across continuation |
| Routing revision | Identity of endpoint/protocol/auth settings that own a native session | Changes on routing edits, not renames or secret rotation |
| Seed | One-time creation of an ordinary editable record | Initialization/migration; never resurrects a deleted record |

### 1.4 Domain model and invariants

Conceptual field names below do not require renaming existing persisted fields or public endpoints.

| Entity / field | Type / multiplicity | Required | Rule |
|---|---|---|---|
| Gateway.id | UUID, single | System-set on create | Immutable; preserve existing provider IDs and secret associations |
| Gateway.name | Text, single, 1–80 trimmed chars | Yes | Editable display label; not an identity key |
| Gateway.baseUrl | HTTP(S) URL, single, max 2048 chars | Yes | Existing URL validation: no credentials, query or fragment |
| Gateway.protocols | Non-empty set of existing protocol enum | Yes | At least one; compatibility depends on this data, not name/host/kind |
| Gateway.auth | Object: `protocols: Record<Protocol, AuthMode>`, `catalog: AuthMode`; `AuthMode = bearer or x-api-key` | Yes; exactly one entry per supported protocol plus catalog | Bearer means Authorization: Bearer; x-api-key means the existing Anthropic API-key header mode. No arbitrary header names, executable commands or templates |
| Gateway.enabled | Boolean | Yes; proposed default false for new records | Enabled and readable key are separate facts |
| Gateway.routingRevision | Opaque system-generated value, single | System-maintained | Changes when URL, supported protocols or auth changes |
| Gateway.hasApiKey | Boolean, derived | Response only | Means stored key exists; not a claim that upstream accepts it |
| Gateway secret | SecretStore value, single | Required to enable/use, optional while disabled | Write-only; existing workspace scope and `cezar` audience |
| AgentDefault.runner | Existing RunnerId, single | Yes | One default per runner |
| AgentDefault.choice | Native or gateway UUID, single | Yes when set | Absent means native for an unconfigured agent |
| TaskSelection | Default / native / gateway UUID, single | New callers may omit to inherit | Explicit native must be representable separately from omission |
| ResolvedBinding | Runner + native profile or gateway UUID + routing revision + selected protocol | Before process launch | Persist selected identity and wire protocol, never secret values |
| Seed completion | Optional boolean marker in workspace config, single | System-owned | Written with seed metadata in the same merge-write; remains true after deletion |

One gateway can expose multiple protocols. The runner adapter selects a supported format deterministically; Claude Code requires Messages, Codex requires Responses, Cursor remains native-only. Multi-protocol runners retain documented native preferences. The selected protocol is pinned in each resolved gateway binding; a later adapter-preference change cannot reinterpret it. If that protocol is removed or unsupported, reject launch until an explicit compatible selection is made.

OpenRouter seed values must reproduce the current supported runner behavior through ordinary protocol/auth data. Remove routing decisions based on `kind === 'openrouter'`, including compatibility, Claude auth and catalog auth. Preserve omission of models explicitly declaring no tool support through generic catalog metadata handling; absent tool metadata is not an automatic rejection. Seed endpoint/protocol behavior needs fixture evidence before release; this spec does not claim live vendor verification.

All config writes use existing workspace merge-write/atomic-file discipline. The UI never grants a stronger capability than the server. Missing/deleted/disabled gateways, incompatible protocols and unreadable secrets reject the launch; they never select another account or gateway.

## 2. Identity Model

| Persona | Surface | Access and scope |
|---|---|---|
| Cezar operator | General Settings and agent settings | Same permissions as existing workspace provider management; all projects in this Cezar workspace |
| Task author | New Task / Continue | Select compatible usable gateway or native setup; no secret read-back |
| VPS provisioner | Local CLI or existing protected HTTP API | Same workspace store and validation; OS user and `CEZ_HOME` select local scope |

These are usage personas, not new application roles. Cezar has no new login or tenant boundary. Preserve the existing origin/host guards, hosted deployment access controls, native-file editing restrictions and hosting model-policy locks. No external portal, demo users or passwords are introduced.

## 3. Workflows

### WF1 — Configure a reusable gateway

Journey: General Settings → AI Gateways → edit seed or add connection → save secret/settings → enable → choose it for a task.
Starts with the operator opening gateway settings; ends with a usable connection. Excludes agent defaults and running a proxy.
Measure: one saved connection serves two supported agents without entering the key twice. Saved/enabled means configured, not verified upstream access. Catalog loading is demand-driven: timeout, denied credentials or unsupported `/models` produces a repair/retry message and no native substitution; successful catalog resolution plus a valid explicit model makes the connection selectable for launch.

Edge cases: missing key permits disabled draft but rejects enable; invalid URL rejects save with no mutation; closing an unsaved form changes nothing; failed secret/config persistence never reports a successful update; simultaneous edits must not lose unrelated connections.

| Step | Existing capability | Gap |
|---|---|---|
| View/create/remove | `LlmProviders`, contract, current settings form | Move/rename surface; add editing and state |
| Save secret | `SecretStore` | Reuse; define preserve/replace semantics |
| Initialize OpenRouter | Workspace migrations | One-time, keyless disabled seed; deduplicate existing OpenRouter connections |
| Use connection | Runner routing adapter | Replace kind-based branches with protocol/auth data |

### WF2 — Choose an agent default and start a task

Journey: Agent settings → Default AI gateway → save → New Task → resolve choice/model → launch.
Starts with changing a runner's default; ends with a task bound to the intended gateway or native setup. Excludes auto-selecting a model or changing already-existing tasks.
Measure: after one default assignment, two new tasks for that runner inherit it without another gateway selection; explicit native override still works.

Edge cases: disabled/incompatible option is unavailable; stale picker is revalidated server-side; missing gateway model blocks start rather than using native model defaults; changing runner recalculates available choices; policy-locked hosted installations reject unsupported overrides consistently.

| Step | Existing capability | Gap |
|---|---|---|
| Save per-agent choice | Workspace config and agent settings | Optional per-runner gateway default |
| Resolve selection | Workflow manager / run store | Shared resolver; persist actual binding |
| List models / launch | Existing model endpoint and runner factory | Use resolved gateway for catalog, validation, naming and launch |

### WF3 — Maintain routing without silently changing task ownership

Journey: edit/disable gateway or change agent default → running tasks retain current process → next launch validates saved binding → resume or explicit recovery.
Starts with a gateway/default edit; ends when affected tasks either continue on a valid binding or show actionable recovery. Excludes forced process termination and automatic failover.
Measure: zero implicit gateway switches in continuation, restart recovery and dispatch tests.

Edge cases: deleting a referenced gateway leaves an explicit unavailable reference; disabling does not kill an already-running process; changing routing opens a fresh native session with portable context; rotating a key affects future launches, not existing process env; failed edits preserve previous usable configuration or report a recoverable unavailable state, never silently fall back.

| Step | Existing capability | Gap |
|---|---|---|
| Edit/delete | Workspace store / SecretStore | Preserve ID; invalidate catalog on settings/key changes |
| Continue/recover | Existing account/backend/provider affinity | Add route revision and explicit native binding |
| Report availability | Provider gate and UI | Disabled/deleted/unreadable reason; operator can re-enable, repair, or explicitly switch |

### WF4 — Provision a VPS without cockpit clicks

Journey: establish persistent `CEZ_HOME` → create gateway once/save returned ID → update metadata/key by ID → assign agent default → create task.
Starts with provisioning configuration; ends with the same behavior as cockpit setup. Excludes cloud infrastructure and secret-manager integrations.
Measure: repeating update/default-assignment commands changes no IDs and creates no duplicate records; no per-agent native config files require manual authoring.

Edge cases: bootstrap and service using different homes see different state; read-only state returns a failure without preventing ordinary Cezar boot; missing key file prevents decrypt/use; retry of create after lost response requires list/reconciliation rather than blind recreation; a key is never accepted as an argv literal or printed in command output.

| Step | Existing capability | Gap |
|---|---|---|
| Bootstrap/list/create | Existing `llm-providers` CLI | Keep compatibility; support new gateway metadata |
| Repeat updates | Current ID-backed store | Update/enable/disable and agent-default operations with JSON output |
| Secret delivery | stdin + existing vault/keychain/file fallback | Reuse unchanged |

Reality check: each workflow must complete through both validation and actual runner launch in a controlled fixture environment. UI-only editing, a switch ignored at launch, or defaults applied only in the browser do not complete these workflows.

## 3.5 UI Architecture

```text
General Settings
  AI Gateways                         [Add gateway]
    OpenRouter       [OFF] [Edit] [Remove]
    Company Gateway  [ ON] [Edit] [Remove]
  Agents
    Claude Code → Default AI gateway [Native / own config ▾]
    Codex       → Default AI gateway [Company Gateway    ▾]
```

Use existing settings-shell navigation, forms, labels, switches, buttons, dialogs, inline errors and TanStack Query. Proposed global page: `/settings/ai-gateways`; preserve existing agent settings URLs. No dashboard or custom design system.

Gateway editor: name, API base URL, supported API formats, protocol/catalog auth settings, replacement key and enabled state. Hide no OpenRouter-only privileged fields. Existing key displays “API key saved”; blank replacement preserves it. Secret deletion is not inferred from a blank field. An inaccessible stored key has a repair message rather than a ready badge.

New Task offers `Default — <resolved label>`, `Native / own config`, and compatible enabled gateway names. Continue initially shows the task's saved connection; adopting a current default is an explicit action. Unsupported runners show “AI gateways are not supported by this agent”. A removed/disabled selected gateway remains visible as unavailable instead of disappearing into Native.

Fresh workspace: OpenRouter OFF, key missing, edit action. After operator deletes every gateway: empty list with Add gateway; restart does not repopulate. Read/loading errors show Retry; never render them as an empty saved list. Keyboard labels, focus/error handling, mobile layout and light/dark themes follow existing components. From cockpit Settings, AI Gateways and the agent's default control are reachable within three navigation clicks, excluding form entry.

## 4. Workflow Gap Analysis

Evidence: [capability catalog](app-spec-notes/ai-gateways-capability-catalog.md). Local implementation was inspected; no external platform repository or tracker is configured for this spec. Estimates are planning ranges in atomic, testable commits, not a cost commitment.

| Work package | Workflow | Existing mechanism | Gap score / commits | Scope |
|---|---|---|---|---|
| G1 Metadata/edit/enable + generic routing + migration/seed marker | WF1, WF3 | LlmProviders, contract, routing, migrations | 4 / 3–5 | Cezar itself |
| G2 Settings surface and ordinary seed UX | WF1 | Existing provider/settings components | 2 / 1–2 | Cezar itself |
| G3 Defaults, immutable choices, continuation affinity | WF2, WF3 | RunManager, run store, API/client, composer | 4 / 3–5 | Cezar itself |
| G4 Provisioning operations and documentation | WF4 | Existing local CLI/store | 2 / 1–2 | Cezar itself |

Deduplicated estimate: 8–14 commits. These packages are implementation boundaries, not independent release promises. G1/G3 are too coupled for parallel editing of shared contracts or `workflows/run.ts`. No separate proxy service, database, reusable framework or upstream package is warranted.

## 4.5 Module Architecture and Resolution Rules

Reuse `packages/contract` for Zod definitions; extend `workspace/llm-providers.ts` and `workspace/config.ts` for gateway/default state; keep secrets in `workspace/secrets.ts`; keep CLI translation in `core/llm-provider-routing.ts` and process entry in `core/runner-factory.ts`. Extend the existing server family, API client, settings and composer. Internal filenames/legacy fields need not be renamed just to match the UI label.

Resolution order for a new task: explicit native/gateway override → selected runner's workspace default → native if no default is configured. An unavailable configured default is an error, not an absent default. Apply server-side, including direct API callers and supported headless launch paths; never depend on the browser having pre-resolved the choice.

Resolve and persist all statically known workflow-runner choices when the task is accepted; validate again immediately before each process launch. In mixed-runner workflows an explicit task override applies to the selected task runner; other runners use their own saved bindings. For a runner introduced later through an explicit switch, resolve its default once and persist before launch. Do not reread defaults for an existing binding. Same-runner dispatch inherits the parent's resolved choice, including native; a different-runner child resolves that runner's default. Naming and terminal takeover use the task's resolved choice too.

Before any agent process or paid naming turn, preflight all statically known workflow steps: each gateway-bound step needs an explicit compatible model. Use the task model for its selected runner and existing workflow `step.model` for secondary runners. If one is missing, reject the entire start with step ID, runner and gateway, and direct the author to set that step model in the existing workflow editor or inline API step definition. Do not run earlier paid steps first. A different-runner dispatched child likewise requires its own explicit gateway model and is rejected before child launch if absent. No default-model feature or new multi-runner composer is implied.

Task creation pins native explicitly as well as gateway selection. Legacy records without gateway metadata continue as native; new global defaults must not reinterpret old records. New input must distinguish inherit/native/explicit gateway; keep the existing `llmProviderId` input as a supported explicit selection and reject contradictory old/new fields.

At launch: validate binding + enabled state + runner compatibility + readable key + explicit gateway model. Resolve one coherent routing snapshot and key for the launch. A disable prevents launches validated after the disable has committed; already-authorized launches and running processes may finish. Do not promise upstream cancellation or credential revocation from this switch.

Resume only when runner, native account/gateway identity, selected protocol and routing revision match the session owner. A routing edit keeps gateway UUID and pinned protocol. At the next launch validate the current route, persist its current routing revision as the task’s active binding, and start a fresh session with portable conversation context; previous step/session ownership metadata remains unchanged. Subsequent continuations may resume that new revision. If the pinned protocol was removed, require explicit compatible reselection instead. Merely renaming a gateway, changing defaults or replacing its key must not cause an unrelated provider switch. Isolate generated configuration by routing revision where native files could otherwise be overwritten underneath another session; preserve native session locations for unchanged routing/model changes according to each runner's existing contract.

Mutation effects are bounded: gateway edit invalidates gateway/model queries; default edit invalidates defaults and unsubmitted composer resolution; launch writes binding metadata before emitting normal run events. Reuse existing cache reconciliation and event mechanisms. No new notification bus, polling loop or domain-event framework. Failed/stale client writes must not clobber unrelated records.

Secret update retains the existing key when omitted. Reject malformed input before writes. Metadata/key writes span separate stores: never advertise an update as successful until both are usable. On failure restore the previous usable pair, or persist a repair-required/unavailable condition enforced after restart and offer a specific repair action. Concurrent same-gateway edits and launch reads must not expose a key/settings pair belonging to neither completed update. The feature design must choose a bounded locking/versioning or write-state mechanism using existing persistence primitives; do not claim a filesystem transaction already exists across the stores. URL/protocol edits and credential updates invalidate cached model catalogs.

Seed runs once through existing workspace initialization/migration, atomically with its own completion marker in the same workspace merge-write. The current migration runner writes its general schema version separately, so that version alone is not sufficient for this guarantee; a seed-specific optional marker is required. On upgrade, keep existing connections/IDs/secrets, translate OpenRouter behavior into generic data and treat existing usable connections as enabled. Do not add a duplicate seed when an existing OpenRouter connection already covers it. After initial completion, later deletion or renaming never triggers reseeding. Read-only/corrupt homes retain existing graceful boot behavior.

Scheduling restrictions remain: resolve defaults before deferred-start validation; a gateway selected explicitly or through a default is still rejected for deferred API execution. Existing automation launches must use the same resolver/validation and cannot bypass this restriction. Hosting model locks remain authoritative. A deleted default reference stays unavailable until repaired or explicitly changed to native.

## 5. User Stories and Cross-Story Impact

All personas and surfaces below are those in §2/§3.5; no new identity system.

| Story | Persona, action and measurable success | Happy path | Alternate path | Failure and resulting state |
|---|---|---|---|---|
| US1 / WF1 | Operator edits seeded OpenRouter or adds gateway; one reusable record | Save key/settings, enable, select for task | Save disabled without key; delete seed permanently | Invalid input leaves state unchanged; write failure is explicit, no ready badge |
| US2 / WF3 | Operator disables or edits gateway without a silent account switch | OFF prevents subsequent validated launches; current process finishes | Re-enable; rename; rotate key; edit route opens fresh session next launch | Deleted reference shows unavailable; no fallback; failed update reports recoverable state |
| US3 / WF2 | Operator assigns runner default; two new tasks inherit it | Select compatible enabled gateway in agent settings | Set native; another agent retains its own default | Stale/disabled/incompatible reference rejected or shown unavailable, never silently cleared |
| US4 / WF2 | Task author overrides default and starts intended model | Default resolves, catalog/model chosen, binding saved | Explicit native; explicit different gateway; mixed-runner workflow | Preflight missing models for all known steps before any paid turn; name the step and repair via workflow editor/API; policy/key/compatibility errors block launch |
| US5 / WF3 | Task author continues/restarts/dispatches with predictable ownership | Existing saved binding retained despite global-default changes | Explicit runner/gateway switch opens fresh native session with context | Removed/disabled binding blocks next launch; user repairs or explicitly reselects; task history preserved |
| US6 / WF4 | VPS provisioner configures gateway/default without UI; repeat update makes zero duplicates | Create once, save ID, repeat update by ID, assign default, submit task | Existing keychain or file fallback; existing legacy CLI name | Wrong home or missing decryption key produces explicit failure; secrets absent from output; ambiguous create is reconciled with list |

Seed evaluation uses US1. Demo-account/password and sample-inference stories are inapplicable: this is an existing local application feature, not a reference app with demo users.

| Change | Affected stories / precondition | Required consistency |
|---|---|---|
| US1 create/seed/delete | US3, US4, US6 need stable IDs | No duplicate seed; deletion retains unavailable references and never recreates automatically |
| US2 disable | US3–US6 previously saw usable gateway | Revalidate launches; current sessions finish; no implicit native fallback |
| US2 route/key edit | US4–US6 catalog/session assumptions | Invalidate catalog; route revision gates resume; missing key blocks use |
| US3 default edit | US4 unsubmitted tasks; US5 existing tasks | New tasks inherit new choice; saved bindings never change retroactively |
| US4 accepted task | US5 continuation/recovery; US2 concurrent edit | Persist actual native/gateway binding before launch; coherent launch snapshot |
| US5 explicit switch/dispatch | US4 model/runner compatibility | Re-resolve selected runner only; persist ownership; preserve portable context |
| US6 repeated/concurrent update | US1–US5 metadata/key state | Update by immutable ID; merge unrelated records; report partial-store failures honestly |

## 6. Story Gap Analysis

| Story | Capability ladder match | Shared work / estimate |
|---|---|---|
| US1 | Existing provider CRUD/vault + seed/config + UI extension | G1/G2, 4–7 commits shared with US2 |
| US2 | Existing stores/session machinery + new state/revision rules | G1/G3, shared, not additive |
| US3 | Existing settings/config; new per-runner reference and picker | G3, 3–5 commits shared with US4/US5 |
| US4 | Existing launch/catalog/validators; shared resolver extension | G3, shared |
| US5 | Existing continuation/dispatch/handoff; affinity extension | G3, shared |
| US6 | Existing CLI/vault; update/default operations | G4, 1–2 commits |

All named mechanisms are from the reference-checkout capability catalog; availability on this isolated base is qualified at the top of this document, and upstream vendor behavior remains unverified. Review estimates are provisional. Detailed work boundaries are in [implementation notes](app-spec-notes/ai-gateways-work-packages.md); they are not feature specs.

## 7. Phasing and Acceptance

Deliver one complete release covering WF1–WF4: a global gateway list without enforced launch behavior or defaults without provisioning would only deliver part of the agreed outcome. G1–G4 may be developed in sequential atomic commits behind the existing working behavior; release only after integration checks. Estimated total 8–14 commits, no new service/dependency or default network activity.

Business acceptance:

- [ ] General Settings contains AI Gateways; every supported agent exposes Default AI gateway.
- [ ] Fresh state contains one ordinary editable OpenRouter record, disabled and keyless; zero seed network requests.
- [ ] Restart preserves edits/deletion; upgrade preserves existing IDs, keys and working connections.
- [ ] Add/edit/disable/enable/remove work end-to-end; blank replacement key preserves current key.
- [ ] Default/native/explicit gateway choices are visibly distinct and resolve identically from UI and API/CLI.
- [ ] Models come from the selected connection; missing/incompatible selection has an actionable error.
- [ ] VPS update-by-ID and default assignment are repeatable without duplicate records or credential output.

Domain acceptance, authored by the independent challenger and evaluated by the PM:

- [ ] UI, direct API and supported headless creation resolve explicit choice → runner default → native identically. Native/gateway bindings persist before launch; defaults cannot rewrite accepted or legacy tasks.
- [ ] Missing, deleted, disabled, incompatible or unreadable gateways block affected launches with repair guidance, including defaults; no alternate account/gateway is substituted.
- [ ] Before any paid naming/agent turn, every known gateway-bound step has a compatible explicit model; failure identifies step, runner and gateway and launches no earlier step.
- [ ] Continue/recovery/terminal retain saved ownership; same-runner dispatch inherits it; different-runner children require their own compatible gateway model. Explicit switches preserve context without resuming another route/account's native session.
- [ ] Disable timing matches the documented launch boundary. Routing edits persist the current revision and start a fresh session; rename/key rotation do not switch route ownership. Removed pinned protocols require explicit reselection.
- [ ] Omitted keys preserve secrets. Invalid writes mutate nothing. Failed cross-store writes restore the prior pair or remain unavailable across restart; concurrent operations cannot expose an unintended key/settings combination or lose unrelated records.
- [ ] Fresh/concurrent initialization creates one keyless disabled ordinary OpenRouter without requests; upgrade preserves IDs/keys/behavior; restart and later edits/deletion never duplicate or resurrect it.
- [ ] Repeated provisioning updates create no duplicates or credential output. Inherited gateways respect deferred/hosted restrictions; native defaults and graceful boot remain intact.

PM disposition: all eight criteria accepted because they protect the requested selection, editing and VPS workflows. No event-sourcing layer, immediate process-kill semantics, automatic failover, new default-model feature or cross-store database is required. Exact recovery/serialization mechanism belongs to the feature design, with the observable guarantees above mandatory.

Verification plan: contract parity and typed bodies; store/seed salvage and concurrent writes; key-preserve/rotation/failure cases; routing fixtures for all supported runners; new/continue/recovery/mixed-workflow/dispatch/naming/terminal/headless paths; deferred-policy guards; frontend enabled/disabled/missing/error states and keyboard use; a VPS-style temporary-home CLI smoke. Use mock/local endpoints and fake secrets. Live inference is separate and requires explicit credentials/authorization.

## 8. Cross-Spec Conflicts and Compatibility

| Existing contract | Change / resolution |
|---|---|
| `2026-10-27-llm-provider-connections.md`: native labelled Default | New tasks distinguish inherited Default from explicit Native; old tasks remain native if no saved gateway |
| Existing OpenRouter type and single protocol | Translate to generic protocol/auth settings while preserving IDs, secrets and runner behavior; new UI exposes no privileged type |
| Current create/remove CLI/API | Extend additively; old command/routes remain accepted; do not rename persisted state for presentation alone |
| Provider affinity on UUID | Add routing revision for endpoint/auth/protocol edits; preserve portable context on new sessions |
| Zero-config / no default cost widening | Seed disabled, native initial defaults, no requests until an authorized use; no new required config/env |
| Existing deferred execution and hosting model policy | Enforce after default resolution; no bypass by omitting explicit provider input |

Compatibility serializer must define how old create inputs map to generic settings. New functionality remains accessible through existing routes or additive versioned routes; chained route builders and shared Zod middleware remain mandatory. Legacy Continue's explicit native behavior must be preserved. Downgrade is not a supported way to enforce OFF or per-agent defaults: older binaries do not understand those guarantees; stop gateway tasks before downgrade and document that limit. Never rewrite historical NDJSON or migrate task histories destructively.

## 9. Quality Gate

Not a reference app: no demo identities, portal, new modules or business analytics. Reuse the current vault, settings components, workspace writer, runner adapters and test setup. Documentation-only validation for this authoring task is distinct from future runtime verification.

## 10. Decisions and Open Questions

| Item | Status / consequence |
|---|---|
| Name, location, ON/OFF, editable seed, secret pattern, per-agent default | Explicit user requirements; §1.1 |
| Seed OFF, no auto-selection, no kill on disable, stable bindings | Proposed operating rules from conversation; owner review needed before implementation |
| Business payer/flywheel/financial target | Not provided; deliberately not invented. No claim of commercial validation; outside this request to record existing feature decisions |
| Default model per gateway/agent | Not requested; initial scope requires a valid model at task creation, no automatic native model fallback |
| Native agent configs beyond gateway routing | Existing behavior preserved; full merge/copy of personal native config is outside this change |
| OpenRouter protocol/auth and model metadata | Local code inspected; upstream live compatibility must be verified with fixtures/documentation during implementation |
| Exact new wire/CLI syntax and concurrent-edit conflict mechanism | Feature-design detail; retain compatibility and invariants above, avoid inventing required new knobs |
| External platform/tracker research | No `platform.repo` configured; not performed, no external dependency assumed |

## Review and Changelog

- 2026-10-28: Initial draft records the user's AI Gateways and per-agent defaults direction. No code, feature briefs, commits or deployment changes.
- Independent reviews: Phase 0 domain/identity, Phase 1 workflows + architect checkpoint 1, Phase 2 stories + architect checkpoint 2, and Phase 4 rollout/acceptance completed. No CRITICAL findings; all technical warnings incorporated. Final verdict: ready for owner review, not implementation approval.
- Review evidence: [domain](app-spec-notes/ai-gateways-review-domain.md), [workflows](app-spec-notes/ai-gateways-review-workflows.md), [stories](app-spec-notes/ai-gateways-review-stories.md), [final gate](app-spec-notes/ai-gateways-review-final.md).
- Skill source: locally cached `open-mercato/skills` commit `b6885a83dc0877ca2c96b66b8562384c63dd5035`, `skills/om-app-spec-writing/SKILL.md`. Used the existing-product scope requested by the user; no invented commercial validation or downstream feature-spec handoff.
- Documentation validation: Markdown local links, balanced code fences, whitespace and required numbered sections checked. No runtime tests or live provider calls; no production or credential changes.

- 2026-10-28: Prepared a specification-only initial commit for an independent implementation PR based on main; qualified reference-branch evidence and estimates, with no dependency on merging PR #1726.
