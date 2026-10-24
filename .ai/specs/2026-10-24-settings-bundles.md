# Settings bundles — carrying a cezar's configuration to another cezar, instead of syncing state

> Status: proposed (2026-10-24), not built. Branch: `brutus`.
> Builds on: `2026-07-20-multi-project-workspace.md` (`~/.cezar/config.json`), the committable
> half of `.ai/cezar/` (workflows, skills; `data-gitignore.ts` allowlist), `2026-10-24-easy-mcp.md`
> (`mcp.json`), `2026-10-24-personas.md` (`agents/`), `2026-10-23-backup-restore.md` (which
> carries everything, for one machine), `2026-10-24-cezar-mcp-server.md` (tokens, for a mirror later).
> Backlog item: "context/state management between cezars (single account) — sync tasks,
> workflows, settings between VPSes, VPS + local, two locals".

## 1. Problem

The owner runs cezar on a VPS and on a PC, and will run it on a second VPS. Workflows written on
one are typed again on the other; the MCP servers, personas, automations and project settings
likewise. The backlog asked for synchronisation of tasks and workflows between instances.

## 2. Decision

**The hub model.** One cezar instance is the truth for a project's tasks; other machines are
browsers of it. What travels between instances is **configuration, as a bundle** — never run
state, never worktrees. Chosen over two-way sync because cezar's state is local JSON by
design (no database, no account) and a replicated task log with conflict resolution would be a
different product. A read-only mirror of a remote instance's tasks in a local cockpit is noted
as a possible later step on top of API tokens; it is not in this spec.

## 3. What a bundle holds

Two scopes, two files:

| Scope | Contents | Source of truth |
| --- | --- | --- |
| **Project** (`cezar-project-<name>.bundle.json`) | `.ai/cezar/workflows/**`, `skills/**`, `agents/**`, `mcp.json` (references only), `automations.json` (definitions, not state), `config.json` (project settings: base branch, worktree lifecycle scripts, branch naming, start recipe), `integrations/**` | The repository — most of it is already committable, and the recommended transport is **git**: commit `.ai/cezar/` and the other instance has it on clone. The bundle is for what is not committed, or for a project that is not a git remote both sides share. |
| **Workspace** (`cezar-workspace.bundle.json`) | Composer defaults, resources (`maxParallel`, memory), release channel, branding (name, colours; logo and icons as base64), notification preferences, keyboard settings, prompt templates, the MCP catalog's private entries **without values**, global skills and personas | `~/.cezar/config.json` and friends |

Never in a bundle: run records, threads, worktrees, secrets' values, agent logins, API tokens,
the project registry's paths (they differ per machine), the owner account.

## 4. Behaviour

- **Settings → Export**: pick scopes; download the bundle(s). Secret references stay as
  `${{ secrets.NAME }}` and the bundle lists the names it needs.
- **Settings → Import**: upload; a diff view per entry (new / changed / same) with checkboxes;
  apply writes the files through the same routes the UI uses (so validation and the config
  lock apply); missing secrets are listed with a link to create them.
- **CLI**: `cezar bundle export [--project <id>] [--workspace] -o <file>`,
  `cezar bundle import <file> [--yes]` — the way to move settings to a VPS over `scp` + one
  command, and the way an automation could keep two instances aligned if the owner ever wants
  that (not built here).
- **git first**: the Export page says, for a project, "everything in this bundle except
  `config.local.json` is already in your repository under `.ai/cezar/` — commit it and the other
  instance has it", with the list of uncommitted files.

## 5. API

```
GET  /workspace/bundle                      → the workspace bundle (download)
POST /workspace/bundle                      { bundle, select: string[] }  → applied entries
GET  /bundle                                → the project bundle (project-scoped, both mounts)
POST /bundle                                { bundle, select }
POST /bundle/preview                        → the diff view
```

`bundleSchema` in `contract/bundle.ts`: versioned, with per-entry `{ path, kind, content }`.

## 6. Security

- No secret values, tokens, logins or account data ever enter a bundle; the exporter has an
  allowlist, not a denylist, and a test pins that a secret value never appears.
- Import is a trusted-operator action; every entry is written through its own validated route.
- A bundle from an untrusted source is code (workflows run commands): the import diff shows
  every command line and the page says so.

## 7. Zero config

Nothing runs on its own. No sync daemon, no polling, no account.

## 8. Not done here

- Two-way or automatic sync.
- A read-only mirror of remote instances (needs API tokens; possible later).
- Moving tasks or threads between instances (a backup restores a whole instance; a task is
  a branch on the shared remote).

## 9. Verification

- Unit: allowlist export of a fixture project and workspace; a secret value in a fixture file
  never appears in the bundle; import preview classification; apply through routes with a
  conflicting entry rejected and the rest applied; CLI round-trip.
- VPS ↔ PC: export the fancy-fence-panels project bundle on the PC, import on the VPS, the
  workflows and personas appear; the uncommitted-files hint lists `config.local.json` only.
