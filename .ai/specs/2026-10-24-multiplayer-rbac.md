# Multiplayer — several users on one cezar: roles per project, invitations, and each user's own agent accounts

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `2026-10-12-cockpit-authentication.md` (§10 built the hooks: users with ids and a
> `role`, a principal on every request, one authorization point, an audit log; v1 has one role,
> `owner`), `2026-07-29-agent-profiles.md` (agent accounts and the env var that relocates each
> agent's home), `2026-10-24-cezar-mcp-server.md` (API tokens, per user), `2026-10-24-settings-bundles.md`.
> Backlog item: "multiplayer RBAC — a team on one project (one big VPS), a team across VPSes,
> shared workflows and other features".

## 1. Problem

One VPS, one owner. A second person — a teammate, a client who should watch, a reviewer —
either gets the owner's password or nothing. The auth spec left the door open on purpose;
this walks through it. "A team across VPSes" is the settings-bundles spec plus the hub model:
each VPS is a team's instance.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| First cut | **Several users, three roles per project, one instance; each user brings their own agent accounts** | The owner's call. Per-user agent logins mean each person's tokens, limits and costs are theirs. |
| Other people's tasks | **Everything visible; messages and review only on your own tasks and tasks shared with you; the owner can do everything** | A team sees the whole board; nobody steers another's agent uninvited. Terminal and file edit stay owner-only. |

## 3. Users, roles, invitations

- **Users** are rows in the auth store with `role: 'owner' | 'member' | 'viewer'` **per
  project** (`projectRoles: Record<projectId, role>`) plus a workspace-level flag `owner`
  (exactly as today's single owner: everything, everywhere). A member of no project sees an
  empty cockpit.
- **Invitations**: Settings → Users → **Invite**: name, projects and roles → a one-time link
  (`/join#code=…`, 48 h, the setup-code mechanism reused) where the invitee sets password and
  TOTP. Owners can change roles, disable and delete users; a deleted user's sessions, tokens and
  agent accounts go with them.
- **Roles**:

| | viewer | member | owner |
| --- | --- | --- | --- |
| Read tasks, threads, diffs, Code (read-only), Services, Docker | ✓ | ✓ | ✓ |
| Create tasks, chat, send messages / review / commit / PR on **own or shared** tasks | | ✓ | ✓ |
| Same on **any** task | | | ✓ |
| Workflows, skills, personas, MCP, automations, integrations (write) | | ✓ | ✓ |
| Project settings, env files, secrets, worktree scripts | | | ✓ |
| Terminal, file edit, Docker mutations, self-update, backup, users, branding | | | ✓ |

A task has `ownerUserId` and `sharedWith: userId[]` (the author or an owner can share;
"share with project" = everyone). Runs created by automations belong to the owner who enabled
the automation; chat runs to their author.

## 4. Each user's own agents

Agent accounts (`~/.cezar/agent-accounts.json`) become per user: the store is keyed by
`userId`, each account's home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`…, the profiles spec's
relocation) lives under `<CEZ_HOME>/users/<userId>/agents/<accountId>/`. A run uses the
accounts of the user who created it; a project may pin a default account per backend **per
user** (Settings → Agents shows "your accounts"). Logging in an agent from the cockpit
(`claude` / `codex login` in the terminal) is replaced for non-owners by the existing
device-auth flow driven from Settings → Agents (the Codex device flow the VPS already uses;
Claude's OAuth token paste), because the terminal is owner-only. Costs in the dashboards are
attributed by user.

Without an account of their own for the backend a workflow asks for, a member's task refuses
to start with "sign in to Claude under Settings → Agents" — never falls back to the owner's.

## 5. Enforcement

One place, as the auth spec built it: the guard resolves the principal and the project from
the route, and a **policy table** keyed by `(role, routeFamily, verb, ownership)` answers.
Ownership is read from the run record for run-scoped routes. Handlers stay unaware. The audit
log records user, role and outcome per request. WebSocket topics and SSE streams are filtered
per principal where they carry per-task data (threads: visible to all; nothing hidden is
streamed because everything is visible in this cut).

## 6. API

```
GET/POST/PUT/DELETE /auth/users, /auth/users/:id            owner
POST /auth/invitations → { url }; POST /auth/join            invitee
PUT  /runs/:id/share { userIds | 'project' }                 author or owner
GET  /auth/session                                            + role per project
```

Agent-account routes gain the implicit user scope (the caller's). Contract in `auth.ts`.

## 7. Security

- The policy table is the only authorization; a test enumerates every route family × role and
  pins the table, so a new family cannot ship unclassified (the parity-test idea applied to
  authorization).
- Per-user agent homes are `0700` directories owned by the cezar user; a run's child process
  sees only its own user's home through the env the runner builds.
- Invitations are single-use and expire; the audit log records who invited whom.
- Owners remain the only principals with shell-equivalent power (terminal, file edit, hooks),
  which keeps the agent-config RCE line where it is.

## 8. Zero config

A fresh cezar still has one owner and no users page to fill. Multiplayer appears when the
owner invites someone.

## 9. Not done here

- Teams across instances (bundles + one instance per team).
- SSO, passkeys, groups.
- Per-user secrets, per-user projects dirs, per-user quotas beyond the ghost/dispatch budgets.
- Hiding tasks (everything is visible in this cut).

## 10. Verification

- Unit: the policy table against every route family (generated list), ownership checks,
  invitation lifecycle, per-user agent store and home paths, the no-fallback rule, cost
  attribution, audit entries.
- Cockpit: role-aware UI (buttons hidden for viewers, "shared" badge, Users page).
- VPS: invite a member; they sign in, add their own Codex login via device flow, start a task
  on fancy-fence-panels, cannot message the owner's task until it is shared, cannot open the
  terminal; the audit shows both users.
