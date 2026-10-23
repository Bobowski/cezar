# Backup and restore — an encrypted snapshot of everything a rebuild cannot recreate

> Status: proposed (2026-10-23), not built. Branch: `brutus`.
> Builds on: `2026-10-10-cezar-in-a-container.md` (what lives in `/data` and `/projects`),
> `2026-10-12-cockpit-authentication.md` (the `/setup` page before an owner exists),
> `2026-10-12-project-env-files.md` and `2026-10-21-env-references.md` (the untracked project
> files worth keeping), `2026-10-23-branch-channel-self-update.md` (updates; a backup is not one).
> Added to the backlog on 2026-10-23 as part of the VPS group.

## 1. Problem

The first backup of the VPS was a shell pipeline over ssh: `tar` of the `data` volume streamed
into `age`, copied to a laptop, decrypted once to prove it. It works and it is exactly the kind
of thing nobody repeats. What a rebuilt VPS cannot get back from git: the owner account, the
agents' logins, the `gh` login, the git identity and signing key, the project registry and
every task's history, plus the untracked files inside each project — `.env`, `.ai/cezar/`
(workflows, lifecycle scripts, `config.local.json`) — which are the hours of setup that made
fancy-fence-panels work.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Contents | **`/data` plus each project's untracked files** (`.env*`, `.ai/cezar/`, `config.local.json`); never the repositories | Small, and a full rebuild: repos come back from a clone. |
| Destination | **Download from the cockpit always; an S3-compatible target optionally** | Zero config keeps working; off-box copies are what a backup is for. |
| Schedule | **Manual; nightly opt-in only once a remote target exists**, with retention | Nothing leaves the machine by default. |
| Restore | **From the `/setup` page of a fresh cockpit**, before an owner account exists; the CLI too | One ssh per VPS lifetime becomes none. |

## 3. The archive

`cezar-backup-<host>-<yyyymmddThhmmZ>.tar.zst.age`:

```
manifest.json          { version, createdAt, cezarVersion, host, projects: [{ id, root, remote, branch }], sizes }
data/                  CEZ_HOME (= /data/cezar): registry, runs, automations, skills cache…
agents/claude/ codex/ gh/ ssh/ gitconfig      the agents' and git's state under /data
projects/<id>/         ONLY untracked, non-ignored-by-cezar files of that project:
                         .env, .env.*, .ai/cezar/** (minus worktrees/), config.local.json
```

What a project contributes is computed as `git ls-files --others --exclude-standard` filtered
to that allowlist, so build output and `node_modules` never qualify. Task worktrees are not
included: they are branches.

**Encryption** is age (the format the manual backup used, so the existing file stays readable
with the same tooling), produced in-process with `age-encryption` (the TypeScript
implementation of the format) — no binary in the image. Recipient: an `age1…` public key the
owner pastes once into Settings → Backup (generated on their machine with `age-keygen`); until
one is set, the button asks for it. A passphrase (scrypt) recipient is the alternative for
someone without age on their machine. The private key or passphrase is never stored.

Compression: zstd through Node's built-in `zlib` (Node 22.15+ ships `zstdCompress`), level 3.

## 4. Behaviour

**Settings → Backup** (workspace-level, trusted operator):

- **Backup now** → a job (one at a time, like a self-update job, with a log) writes the archive
  to `<CEZ_HOME>/backups/<name>` and offers it as a download; the row shows size and age. The
  five newest local archives are kept; older ones are deleted after a successful new one.
- **Remote target** (optional): endpoint, bucket, prefix, access key id, secret, region —
  S3-compatible (R2, B2, MinIO, AWS). Stored in `<CEZ_HOME>/backup-target.json`, `0600`, the
  secret in the same file (it is the one place a cezar-held secret is unavoidable; the vault
  spec's policy applies when it lands). **Test** does a HEAD on the bucket. With a target set,
  every archive is uploaded after it is written; the row shows "uploaded".
- **Nightly** (shown only with a target): a toggle and a retention count (default 14). Runs
  through the automations scheduler as a built-in schedule, in idle, and deletes the oldest
  remote archives beyond the count. Off by default.
- **Restore here** (an existing cockpit): upload an archive and the identity/passphrase →
  the job verifies the manifest, stops accepting new runs, extracts into place and restarts the
  process (the self-update restart). Projects in the manifest that are not on disk are cloned
  from their recorded remote first.

**`/setup` on a fresh cockpit** gets a second card beside "Create the owner account":
**Restore from a backup**. It takes the archive and the identity, runs the same restore job and
ends on the sign-in page with the restored owner. The setup code (`/setup#code=…`) still gates
the page; nothing is restorable by an anonymous visitor.

**CLI:** `cezar backup create [--out <file>]`, `cezar backup restore <file>` (prompts for the
identity on stdin), `cezar backup list`.

## 5. API (workspace-level, single-mount)

```
GET    /workspace/backup                     → status: recipient set?, target set?, nightly, archives[], job
PUT    /workspace/backup/recipient           { recipient }         (age1… or { passphrase: true })
PUT    /workspace/backup/target              { endpoint, bucket, prefix?, region?, accessKeyId, secretAccessKey } | null
POST   /workspace/backup/target/test
PUT    /workspace/backup/schedule            { nightly: boolean, keep: number }
POST   /workspace/backup                     → starts the job
GET    /workspace/backup/archives/:name      → the file (download)
POST   /workspace/backup/restore             multipart: archive + identity  (also mounted for /setup with the setup code)
```

Zod in `packages/contract/src/backup.ts`; archive names validated against the pattern above.

## 6. Security

- Everything is behind sign-in and `trustedOperator()`; `/setup`'s restore is behind the
  one-time setup code.
- The identity or passphrase for a restore is read from the request, used, and dropped; it
  is never logged or written. The archive is decrypted to a temp dir under `CEZ_HOME`, never
  to `/tmp` shared with agents.
- The remote target's secret is stored `0600` in `CEZ_HOME`; the UI never echoes it back
  (the status says "set").
- A restore replaces the owner account with the archive's: that is the point, and the page
  says so before it runs.

## 7. Zero config

- No recipient, no target, no schedule by default; the page says what each unlocks.
- New state only: `backups/`, `backup-target.json`, `backup.json` (recipient + schedule).
- `CEZ_BACKUP_DIR` is not introduced; the directory lives under `CEZ_HOME`.

## 8. Not done here

- Including repositories or worktrees (clone them).
- Incremental or deduplicated backups.
- Cross-cezar sync (a backup is not a sync — see the multi-cezar spec).
- A backup before every self-update — the owner chose manual + nightly; the updater keeps
  `previous` for code, and data is append-mostly.

## 9. Verification

- Unit: the project allowlist against a fixture repo (an `.env` and `.ai/cezar/workflows` in,
  `node_modules` and `worktrees/` out); manifest round-trip; encrypt → decrypt with a known
  age identity (test vector); the S3 client against a local MinIO in the container test env;
  retention keeps N.
- Restore: a fixture archive restored into an empty `CEZ_HOME` yields a config that
  `loadWorkspaceConfig` accepts and an owner that can sign in (auth store tests).
- Contract parity, BC inventory.
- VPS: Backup now → download → `age -d` on the laptop lists the expected entries; set an R2
  target → Test → nightly on → next morning one object; fresh container with empty volumes →
  `/setup` → Restore → sign in with the old owner, fancy-fence-panels listed with its `.env`.
