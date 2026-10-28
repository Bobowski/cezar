# AI Gateways — deduplicated work boundaries

Planning estimate from reference branch `544d0c76`. The independent PR starts at main `4040b404` with documentation only; reference-only gateway foundations must also be implemented here if still absent. Re-estimate before implementation; do not treat the earlier PR as a merge prerequisite.

| Package | Atomic change boundaries | Stories | Estimate |
|---|---|---|---|
| G1 | Generic protocol/auth contract and compatibility adapter; update/enable store+API with secret rules; seed/legacy migration and revision-aware config isolation | US1, US2, US5 | 3–5 commits |
| G2 | Dedicated global settings page and editor; agent-independent enabled/unavailable/seed UX and UI coverage | US1, US2 | 1–2 commits |
| G3 | Per-runner defaults contract/resolver; native/gateway binding persistence; composer + lifecycle/dispatch/naming/handoff/headless integration and guards | US3, US4, US5 | 3–5 commits |
| G4 | Existing CLI update/enable/default assignment; provisioning docs and isolated-home smoke | US6 | 1–2 commits |

WF1 uses G1/G2; WF2 uses G3; WF3 shares G1/G3; WF4 uses G4. Shared commits are counted once: 8–14 total. No promised per-workflow additive totals. A release must preserve the working default path while covering all four workflows; atomic development commits are not independently advertised incomplete user features.

G1 and G3 exceed a one-change estimate because current provider kind, task/session affinity, contracts and multiple launch paths carry real behavior. Reuse current stores/adapters rather than introducing a routing framework. No cloud deployment manifests, required config file or third-party dependency are included.
