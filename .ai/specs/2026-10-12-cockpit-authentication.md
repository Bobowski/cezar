# Cockpit authentication — a login cezar owns

> Status: all four phases implemented (2026-10-12) on `brutus`. NOT yet run on a real VPS: the
> installer changes are covered by unit tests against a stubbed runner, and the nginx site was
> never passed through `nginx -t` (§13). The three
> decisions in §12 were taken the same day. A hosted cockpit can be set up, signed in to and
> managed from the browser; the hosted gates and the installer have not moved yet (§13).
> Implementation: `packages/cezar/src/auth/` (`service.ts`, `store.ts`, `guard.ts`, `routes.ts`,
> `password.ts`, `totp.ts`, `run-tokens.ts`, `host-key.ts`, `cli.ts`), the guard and the upgrade
> hook in `server/server.ts`, `authEnforced` in `server/capabilities.ts`,
> `packages/contract/src/auth.ts`. Proof: `server/auth-guard.test.ts`.
> Cockpit: `packages/web/src/components/auth/` (`auth-gate.tsx`, `login-screen.tsx`,
> `setup-screen.tsx`), `src/api/auth.ts`, `src/routes/settings/security-section.tsx`.

## 1. Problem

A hosted cockpit has no authentication of its own. The perimeter is whatever the reverse proxy
does — nginx `auth_basic` in the stock install — and cezar cannot tell who is on the other side.
Three things follow from that today:

- **The useful half of the workspace is off on a VPS.** Terminal, file editing and agent-config
  writes are refused in hosted mode (`CEZ_TERMINAL`, `CEZ_FILE_EDIT`, the `PUT /agent-config`
  409) precisely because "anyone the proxy admits" is the only identity there is.
- **Remote mode opens no WebSocket**, because a browser WebSocket cannot carry Basic-Auth
  explicitly; it falls back to HTTP long reads.
- **Basic-Auth has no session.** No logout, no expiry, no second factor, no per-device revoke,
  no rate limit, and the password travels on every request.

The target: cezar at `https://agents.example.dev`, every device signs in once with a password
and a second factor, and a signed-in device has the full cockpit. A local `npx cezar` is
untouched.

## 2. Non-goals

- RBAC, invitations, team workspaces. §10 keeps the door open; nothing here builds them.
- TLS. cezar still binds loopback and a front still terminates HTTPS.
- Isolating agents from the host user — see §3, "what this does not defend".
- SSO / OIDC. `CEZ_AUTH=0` (§4) is how a deployment that already has one keeps it.

## 3. Threat model

Defended:

| Threat | Defence |
| --- | --- |
| Anonymous network caller reaches the API, SSE or a WebSocket | One guard before every route and every upgrade (§6); proven by a test that walks the route manifest |
| Password guessing / credential stuffing | scrypt, per-account and per-address backoff, global concurrency cap (§5.4) |
| Stolen or phished password | Mandatory TOTP (§5.2) |
| Stolen session cookie | `HttpOnly`, `Secure`, `__Host-` prefix, idle + absolute expiry, per-device revoke (§5.3) |
| CSRF | `SameSite=Strict` plus the existing #426 same-authority write guard, which becomes load-bearing |
| A previewed app driving the cockpit | Session cookie stripped by the preview gateway; origin guard rejects its writes and its WS (§7) |
| "First visitor claims the instance" | Setup needs a one-time code minted on the box (§5.1) |
| Leaked store file | Passwords, session tokens and recovery codes are stored hashed |

**Not defended, by construction:** an agent runs as the same OS user as cezar. It can read and
write `~/.cezar/`, so a prompt-injected agent can rewrite the user store or read the TOTP seed.
Authentication closes the NETWORK perimeter; it does not make an agent less than the host user.
That needs a separate OS user or the container work (`2026-10-10-cezar-in-a-container.md`) and
is a prerequisite for real multi-tenant RBAC, not for this spec.

## 4. When it is on

`CEZ_AUTH`, a tri-state on the same pattern as `CEZ_TERMINAL`:

| Value | Local cockpit | Hosted cockpit (`CEZ_REMOTE=1` or non-loopback bind) |
| --- | --- | --- |
| unset | off — exactly today | **on** |
| `1` | on | on |
| `0` | off | off — the proxy owns auth, today's behaviour and today's hosted gates |

No knob is required: local stays zero-config, and a hosted cockpit with no user yet serves
only the setup flow (fails closed, never open). `authEnforced(env, bindHost)` lives beside the
other predicates in `capabilities.ts`. A cockpit learns the mode from `GET /api/v1/auth/session`
rather than from `capabilities`: health is not readable before sign-in, so it could not say.

Signing in over a public address requires HTTPS as the browser sees it (`X-Forwarded-Proto`);
over plain HTTP the login and setup routes refuse with a reason rather than set a non-`Secure`
cookie. The exception is a loopback `Host` — a local `CEZ_AUTH=1`, or a container published on
the viewer's own machine — where plain HTTP is all there is.

## 5. Mechanism

### 5.1 Setup and recovery — the box is the root of trust

- `cezar auth setup` (run over SSH on the host) mints a one-time code — 32 random bytes, 15
  minutes, single use, held hashed — and prints `https://<host>/setup#code=…`. The code rides
  in the fragment so it never reaches an access log. `server-install` prints the same link as
  its last step.
- The setup screen takes a username and password, enrols TOTP, and shows recovery codes once.
  The first user is `owner`.
- `cezar auth reset <user>` on the host clears that user's password, second factor and
  sessions and prints a new setup link. There is no e-mail and no web "forgot password".

### 5.2 Credentials

- **Password:** `node:crypto` scrypt (N=2^17, r=8, p=1), 16-byte salt, parameters stored with
  the hash so they can be raised later. Minimum 12 characters; no composition rules. Unknown
  usernames burn the same scrypt work, so timing does not enumerate accounts.
- **TOTP (RFC 6238):** SHA-1, 6 digits, 30 s, ±1 step, implemented on `node:crypto` and pinned
  to the RFC test vectors. The last accepted step is stored per user so a code cannot be
  replayed. The seed has to be stored recoverable; it lives in the `0600` store.
- **Recovery codes:** ten, single use, stored hashed, regenerable from Settings.
- No new runtime dependency. Passkeys (WebAuthn) are the better second factor and are deferred
  only because they need one (§11); the store models factors as a list so adding them is
  additive.

### 5.3 Sessions

- Login is two steps: password → a 5-minute pending ticket (memory only) → TOTP or recovery
  code → session. The session token is issued only after the second step.
- Token: 32 random bytes, opaque, stored as SHA-256. Cookie `__Host-cez_session`; `HttpOnly;
  Secure; SameSite=Strict; Path=/`. Over plain HTTP on loopback the name drops the prefix and
  `Secure`, and that plain cookie is honoured for a loopback `Host` only — arriving for a public
  host it is a planted one.
- Idle expiry 7 days (sliding), absolute 30 days. Each session records a device label, created
  and last-seen time. Settings → Security lists them and revokes one or all.
- Changing the password, the second factor or the recovery codes requires a fresh second-factor
  check and revokes every other session. Built for the password and the recovery codes;
  replacing the AUTHENTICATOR is deliberately host-only (`cezar auth reset`), so a hijacked
  session can never swap the second factor.

### 5.4 Throttling

Failures back off exponentially per account and per client address, capped at 15 minutes, never
a hard lock (a lock is a denial of service against the only owner). Concurrent scrypt
verifications are capped. The client address is the last `X-Forwarded-For` hop — the one the
front appended — and is trusted only because cezar binds loopback. State is in memory.

### 5.5 Storage — new state, written, never required

| File | Holds |
| --- | --- |
| `~/.cezar/auth.json` | users: id, name, role, password hash, factors, recovery-code hashes |
| `~/.cezar/auth-sessions.json` | session hashes and metadata; `auth-sessions-<instance>.json` for a `--domain` instance, so two cockpits on one host do not rewrite each other's |
| `~/.cezar/auth-host.key` | the credential a shell on the host shows its own cockpit (§7) |
| `~/.cezar/auth-audit.ndjson` | append-only: setup, login, failure, revoke, reset |

Own files for the reason `agent-accounts.json` has one: a cezar that has never heard of auth
cannot drop them. Same house rules — `.catch` per field, `.passthrough()`, per-entry salvage,
atomic tmp+rename at `0600`, resolved through `cezarHomeDir()`. One deliberate difference: a
corrupt or unreadable `auth.json` while auth is enforced **fails closed** to the setup-code flow
instead of degrading to "no auth"; the boot still succeeds.

## 6. Enforcement — one guard, proven mechanically

A single middleware after the #426 origin guard resolves a **principal** onto the hono context
and answers `401 { error }` when there is none. Public while auth is on: the static shell,
`/api/v1/auth/session` (returns `{ authenticated, setupRequired }` only), `/api/v1/auth/login*`
and `/api/v1/auth/setup`. `/api/v1/health` is NOT public in this mode — it carries `repoRoot`,
the project list and the remote.

Every listener and every upgrade path has to be covered, and the #811 lesson applies — find the
sites by construction, not by memory:

- the main HTTP app (all `/api/v1` and `/api/v1/p/:projectId` routes, SSE included);
- `verifyWsUpgrade` → the session cookie is checked before the handshake;
- the preview gateway listeners — keep their own ticket (§7);
- the Design Mode proxy — loopback-only, unreachable in hosted mode; assert that.

Tests that make this hold: a manifest walk in the style of `route-parity.test.ts` asserting
every registered route answers 401 without a session and is not 401 with one; the same for the
WS handshake; and a test that fails when a new `createServer`/`on('upgrade')` appears outside an
allowlist. Auth routes are chained into a family builder with schemas in `packages/contract`
like every other route.

## 7. What the session changes elsewhere

**The two questions `localHandoff` conflates get separate names.** "Is the viewer on this
machine?" stays `localHandoff` (open-in-editor, Finder, the bookmarklet, framing
`localhost` directly). "Is the caller a trusted operator?" becomes `trustedOperator =
localHandoff || authEnforced` (`trustedOperator()` in `capabilities.ts`). Every hosted-mode check
in `server.ts` was classified into one of the two; the table is what moved, the list under it is
what deliberately did not:

| Gate | Today (hosted) | With auth enforced |
| --- | --- | --- |
| Terminal (`CEZ_TERMINAL` unset) | off | on |
| File edit (`CEZ_FILE_EDIT` unset) | off | on |
| `PUT /agent-config/:id` | 409 | allowed |
| Open in editor / Finder / terminal app | 409 | 409 — a machine property |
| `GET /agent-config` `editable`, home-directory config files | false / 409 | true / served |
| Preview | via gateway | via gateway, unchanged |
| Browser WebSocket | not opened | opened once the proxy is proven to pass upgrades |

Left on `localHandoff`, on purpose:

- **Open in editor / Finder / terminal app, provider "connect" in a host terminal** — there is
  no such machine on the viewer's side.
- **`/health` `repoRoot` and self-update paths trimmed to a basename** — a documented value in
  BACKWARD_COMPATIBILITY.md §2; not worth a second meaning.
- **The folder picker confined to `CEZ_BROWSE_ROOT`** — still the right default for a server.
- **Self-update is forward-only** — more load-bearing than before: a downgrade to a build that
  predates sign-in would remove it.
- **Agent accounts (`/workspace/agent-profiles`)** — still withheld and read-only when hosted.
  The family mixes trust with machine actions (open a file in an app, start a login in a host
  terminal) and needs its own pass; a second agent login on a VPS is done from the cockpit
  terminal meanwhile.

**The browser WebSocket** (built in phase 4). The server gates the handshake on the session, and
the cookie rides it, so a signed-in hosted cockpit can have the socket — if its proxy passes
upgrades, which is not cezar's to know. The cockpit therefore asks once per page
(`probeSocket`, `packages/web/src/api/socket-transport.ts`): one handshake, closed at once. Yes →
health, host usage, the tracker watch and the terminal bell move to the socket. No, or no answer
in five seconds → they stay on the HTTP reads they have always had in hosted mode, and nothing
retries. A cockpit behind Basic-Auth never asks. Without the probe a proxy that drops upgrades
would leave the terminal waiting on a bell that cannot ring.

**Preview gateway.** Cookies are scoped by host, not port, so the browser sends the cockpit's
session cookie to every preview port. The gateway must strip `__Host-cez_session` from what the
app receives, exactly as it strips its own. The app's scripts still cannot use the session: the
cookie is `HttpOnly`, the #426 guard rejects writes whose `Origin` authority differs from
`Host`, CORS hides read responses, and `verifyWsUpgrade` rejects a foreign-authority WS.

**Agents calling the cockpit.** `cez task`, `cez tracker` and `cez automation` reach
`CEZ_API_URL` on loopback with no credential, and so does any other local process. With auth
enforced, loopback gets no exemption. Each run receives `CEZ_API_TOKEN` in its environment:
random, held hashed in memory, bound to the run and its project, valid while the run is live,
and accepted only on the agent routes those CLIs use. The field must be set at BOTH `ActiveRun`
construction sites (`execute` and `runContinuation`). Shell commands a human runs on the host
(`cezar runs list`) authenticate with a `0600` key file under `~/.cezar/`.

As built, the token is stateless — `claims.HMAC(claims)` under a key that lives only in the
process — so there is no registry for the two construction sites to disagree about: both reach
`agentEnv`, which mints. The guard checks the signature, that the run is still active, and the
route against an allowlist of exactly what the three CLIs call (`runTokenAllows`). A restart
rotates the key. The host key is never offered to a task (`withCockpitAuth` skips it when
`CEZ_TASK_ID` is set), though a task can read the file — see §3.

**Installer.** New `ubuntu-vps` installs write an nginx vhost with TLS and the proxy but no
`auth_basic`, add `limit_req` on `/api/v1/auth/`, and end with the setup link. `--external-proxy`
keeps working; its docs gain "or set `CEZ_AUTH=0` if your proxy authenticates".

## 8. Cockpit

- `AuthGate` wraps the app ABOVE the event stream and every query. It asks
  `GET /auth/session` once; signed out, it renders sign-in or setup and mounts nothing of the
  cockpit, so a signed-out tab opens no stream and collects no 401s. Sign-in and setup are
  screens, not routes: the URL is never touched, which is what "preserving the return path"
  comes to. A local cockpit pays one request and sees no screen; a server that cannot answer
  the question is treated as "no sign-in", since the server is the one enforcing.
- Any `401` outside `/auth/*` is reported once by the shared `fetch` (`onUnauthorized`); the
  gate re-asks the session and the sign-in screen replaces the cockpit.
- Setup is three steps — account, authenticator (QR, the key, a 6-digit field), recovery codes —
  and the cockpit opens only after the user confirms they saved the codes.
- Settings (global) → Security, listed only when someone is signed in: change password,
  regenerate recovery codes, the device list with per-device and all-others sign-out.
- The cockpit menu gains "Signed in as …", Security and Sign out. Nothing renders in a local
  cockpit with auth off.
- Two cockpit dependencies: `input-otp` (shadcn's InputOTP) and `uqr` (the QR matrix, drawn as
  one SVG path — no HTML is injected).

## 9. Upgrading an existing hosted install

This is the one place the default path changes for someone who already has a working setup
(AGENTS.md § Changing a mechanism that already works). After upgrading, an nginx+htpasswd
install shows cezar's setup screen behind the Basic-Auth prompt until someone runs
`cezar auth setup` on the host. Nothing is exposed that was not before — the proxy login is
still there — but the cockpit is unusable until that step. `server-deploy` detects the case,
prints the link, and offers to remove `auth_basic` once an owner exists. `CEZ_AUTH=0` restores
the previous behaviour exactly. Recorded in `BACKWARD_COMPATIBILITY.md` and the CHANGELOG.

## 9a. The installer, as built

`ubuntu-vps` asks one new question — who signs people in — and records it as `signIn` in
`server.json`:

| `signIn` | nginx site | SSL step | unit | last step |
| --- | --- | --- | --- | --- |
| `cezar` (default for a person) | no `auth_basic`; `limit_req` on `/auth/(login\|setup)` | **required** | unchanged | verifies 401 for anonymous, 200 for the host key against THIS install, then prints the setup link |
| `proxy` (and always under `--yes`) | `auth_basic` + htpasswd, as before | optional | `Environment=CEZ_AUTH=0` | the Basic-Auth verify, unchanged |
| absent (a record from before) | untouched | — | untouched | `server-deploy` explains the double login and changes nothing |

- Both sites now pass WebSocket upgrades through a `map` on `$http_upgrade` that leaves the
  empty `Connection` header in place for everything else, so SSE keep-alive is as it was. The
  `map` and the rate-limit zone are named after the instance: two cockpits can share one nginx.
- `--yes` keeps `proxy` because it also skips the SSL step, and cezar's sign-in cannot work
  over plain HTTP — the non-interactive install is byte-for-byte what it was, plus the
  explicit `CEZ_AUTH=0`.
- `--external-proxy` asks the same question in the service step. With `cezar` the printed
  proxy config has no auth middleware and the proxy is asked for TLS, `X-Forwarded-Proto` and
  WebSocket upgrades instead.
- The verify step uses the host key through `curl -K -`, so it never appears in argv.
- `macosx-ngrok` sets `CEZ_AUTH=0`: ngrok's `--basic-auth` is that platform's login.
- Cockpits on one host share accounts (one `auth.json` per OS user) and keep separate sessions.

## 10. Room for RBAC and teams

Built now because retrofitting it is the expensive part:

- Users have a stable id and a `role` field; v1 has one role, `owner`.
- Every request carries a principal: `{ kind: 'user' | 'run' | 'host', userId?, role, runId? }`.
- Authorization is decided in ONE place, the guard: an owner may call everything, a run
  principal only its allowlist. RBAC replaces that decision with a policy table keyed on the
  principal's role; no handler authorizes on its own today, so none has to be found later.
- The audit log records the principal.

Not built: more than one user, invitations, per-project roles, shared team state.

## 11. Phases

1. **Core — DONE.** Store, scrypt, TOTP, sessions, throttling, the guard, auth routes +
   contract, `cezar auth setup|reset|status`, run tokens, the host key, the WebSocket gate,
   gateway cookie stripping (pulled forward from phase 3: without it phase 1 would have handed
   the session to every previewed app), the manifest-walk tests.
2. **Cockpit — DONE.** Login, setup, second factor, Settings → Security, 401 handling, and the
   three routes Security needed (`/auth/password`, `/auth/recovery-codes`,
   `/auth/sessions/revoke-others`).
3. **Re-keying — DONE.** `trustedOperator`; terminal, file edit and agent-config moved; every
   other hosted gate classified and left (§7).
4. **Installer, WebSocket and docs — DONE** (§9a). nginx without `auth_basic` and WITH
   WebSocket upgrades, the probed browser socket, `server-deploy` migration,
   `.env.example`, `docs/reference.md`, `docs/server-install/*`, `BACKWARD_COMPATIBILITY.md`.
5. **Later** — passkeys, more users, RBAC, teams, agent isolation.

Each phase lands green on the five validation gates; phase 3 does not land before phase 1's
manifest-walk test exists.

## 12. Decisions (owner, 2026-10-12)

1. **Hosted default is ON** (§4, §9). The safe default is not a flag; the cost is one manual
   step for existing hosted installs.
2. **TOTP is mandatory** whenever auth is on. The account guards a shell, and an optional second
   factor is one nobody enrols.
3. **`brutus` only.** Not proposed upstream, so AGENTS.md § Zero config is not amended here. If
   that changes, this needs ratification there: it reverses "cezar has no authentication" and,
   in phase 3, the agent-config 409.

## 13. Known gaps

- The sign-in flow was driven end to end in a browser over loopback (plain cookie). The
  `__Host-` cookie behind real TLS is covered by tests only, not by a live deployment.
- The hosted WebSocket was exercised through the Vite dev proxy only, not through nginx.
- Live preview on a hosted cockpit still needs the preview gateway configured by hand
  (`CEZ_PREVIEW_PORTS` + the nginx port range); the installer does not do it.
- Agent accounts are still read-only on a hosted cockpit (§7).
- **Nothing in phase 4 has run on a real server.** The installer is tested against a stubbed
  command runner; the generated nginx site has not been through `nginx -t`, certbot has not
  edited it, and no browser has signed in through it. The first real install is the test.
- A container that binds a non-loopback host is "hosted", so it now asks for setup. That is the
  intended default, and a change for anyone already running one — `CEZ_AUTH=0` restores it.
- The test suite pins `CEZ_AUTH=0` (`packages/cezar/vitest.setup.ts`) because dozens of suites
  flip `CEZ_REMOTE=1` to reach a hosted gate; the auth suites delete the pin.
