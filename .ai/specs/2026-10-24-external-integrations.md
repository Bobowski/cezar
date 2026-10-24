# External integrations beyond TesterArmy — cards defined by manifests: setup as a task, secrets, MCP, webhooks

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `2026-10-10-e2e-one-click-setup.md` (the pattern: a card, a setup task in a worktree,
> check steps that prove it — `e2e-setup.ts`, `tester-army-e2e-card.tsx`), the project secrets
> store, `2026-10-24-easy-mcp.md` (catalog servers), `2026-10-23-github-events.md` (the hook
> route, namespaced for other senders), `2026-10-10-preview-gateway.md` (a public port per task),
> `2026-09-14-automations-redesign.md` (tracker/GitHub pollers; a third source kind).
> Backlog item: "extend external integrations — beyond tester.army".

## 1. Problem

Settings → External integrations has one tab and one card. The pattern behind it is good —
cezar sets a tool up the way it does any work, as a task the user reviews — but it is written as
one component and one server module. Each new integration would be another pair.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Kinds wanted | **Deploy/hosting, in-project services, other test frameworks, communication.** |
| Shape of each | **A card = a manifest**: a setup task, the secrets it needs, optional MCP servers from the catalog, optional webhook into the project, optional automation source. No per-integration server code. |
| First batch | **Vercel, Railway, Stripe, Resend, Sentry, Playwright, Slack.** |

## 3. The manifest

`packages/cezar/src/integrations/catalog/<id>.ts` (typed, validated by `integrationManifestSchema`;
a repo may add its own under `.ai/cezar/integrations/<id>.json`):

```ts
{
  id: 'stripe', kind: 'service', name: 'Stripe', logo, docs,
  detect: { files: ['stripe.config.*'], deps: ['stripe'] },           // "already present" badge
  secrets: [{ name: 'STRIPE_SECRET_KEY', test: true }, { name: 'STRIPE_WEBHOOK_SECRET', optional: true }],
  setup: { prompt: 'Install the Stripe SDK…', checks: ['npm run typecheck'], workflowFile: '.ai/cezar/workflows/stripe-smoke.yaml' },
  mcp: [{ catalog: 'stripe', scope: 'project' }],
  webhook: { path: 'stripe', forward: 'task-gateway' },                // Stripe → cezar → the task's app
  automation: { source: 'sentry-issues' },                             // only Sentry/Slack in v1
  skills: ['stripe-testing'],                                          // skills the setup task writes
}
```

The card UI is generic: logo, state (not set up / setting up: task link / set up / present
without cezar), the secrets fields (project secrets picker), **Set up**, and the extras the
manifest declares (Add MCP, Register webhook, Enable automation source).

## 4. What each piece does

- **Setup** = `startRun` with an ad-hoc workflow built from the manifest, exactly as
  `e2e-setup.ts` does: an agent step with the prompt and the secrets bound (audience `checks`),
  then the check steps. Ends at review; the user merges.
- **Secrets** are the existing store; a manifest only names them. A `test: true` secret is
  labelled as a test-mode key and the setup prompt says so.
- **MCP** entries are added through the easy-mcp routes with the secrets as references.
- **Webhook** registers `POST /api/v1/hooks/<integration>/<hookId>` (the github-events hook
  route generalised: id + per-sender signature verification — Stripe's `Stripe-Signature`,
  Slack's signing secret, Sentry's HMAC). `forward: 'task-gateway'` relays the verified
  payload to the chosen task's app through its gateway port (so `stripe listen` is not
  needed on the VPS); `forward: 'automation'` turns it into an automation event.
- **Automation source**: Sentry issues and Slack mentions become a third poller kind beside
  GitHub and trackers, with the manifest naming the API and the event shapes; the automations
  editor shows them like tracker events.

## 5. The first batch, in one line each

| Card | kind | setup task | extras |
| --- | --- | --- | --- |
| Vercel | deploy | link the repo, `vercel.json`, preview deploy per task branch via the CLI with a token secret; the deploy URL is posted into the task thread | MCP (Vercel) |
| Railway | deploy | service + env from the project's env references; per-task preview environment | MCP (Railway) |
| Stripe | service | SDK, test keys, webhook endpoint in the app, a smoke workflow | MCP, webhook→task |
| Resend | service | SDK, sandbox domain, a test send check | MCP |
| Sentry | service | SDK + DSN secret, source maps step | automation source (new issue → task), MCP |
| Playwright | test | `npm init playwright`, a smoke spec, a check step `npx playwright test` | — |
| Slack | communication | an app manifest the user installs; cezar posts review/waiting notices to a channel and relays thread replies back as messages | webhook→automation |

## 6. API

```
GET  /integrations                    → { items: IntegrationState[] }   (manifest + detected + secrets set + task)
POST /integrations/:id/setup          { secrets? }  → { runId }
POST /integrations/:id/webhook        → { url }      POST /integrations/:id/webhook/delete
POST /hooks/:integration/:hookId      (unauthenticated, signature-verified; from github-events)
```

Project-scoped, both mounts; `e2e` routes are migrated onto this family with TesterArmy as the
first manifest (its card keeps its behaviour).

## 7. Security

- Hook routes verify the sender's signature before anything; payloads to a task's app are
  relayed, never interpreted, and only to the task the operator chose.
- Secrets are referenced, never written into manifests, prompts or worktrees (the `checks`
  audience binding the e2e card already uses).
- A repo-provided manifest cannot name a command — only a prompt, checks, catalog ids and
  secret names.

## 8. Zero config

Cards are inert until clicked. Detection is file-based and local. No webhook, MCP or
automation exists until the operator adds it.

## 9. Not done here

- Native API clients per vendor (the agent and MCP do the vendor work).
- Discord, Telegram, Cypress, Maestro, Fly, Cloudflare — manifests to add later.
- A marketplace.

## 10. Verification

- Unit: manifest schema; the workflow built from a manifest equals the e2e one for the
  TesterArmy manifest (golden); detection; signature verifiers per sender with vendor test
  vectors; relay to a gateway port; the Sentry poller on fixtures.
- Cockpit: the generic card renders every state; the e2e card test suite passes unchanged.
- VPS: Stripe card on fancy-fence-panels → setup task → review → register webhook → a Stripe
  test event reaches the task's app through the gateway; Slack card posts a review notice.
