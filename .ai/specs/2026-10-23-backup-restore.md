# Backup and restore — an encrypted snapshot of everything a rebuild cannot recreate

> Status: built (2026-10-24) — see §10 As built. Branch: `brutus`.
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
POST   /workspace/backup/restore             raw archive body + x-cezar-backup-identity  (also mounted for /setup with x-cezar-setup-code)
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
  Restore an archive over 32 MB through Caddy: `docker/Caddyfile` gives the two restore routes
  `max_size 1GiB` and keeps 32 MB elsewhere (no test reads docker files, so this is a manual check).

## 10. As built (2026-10-24)

Code: `packages/cezar/src/backup/` (`tar.ts`, `codec.ts`, `collect.ts`, `s3.ts`, `state.ts`,
`restore.ts`, `service.ts`, `routes.ts`, `cli.ts`), `packages/contract/src/backup.ts`,
`packages/web/src/routes/settings/backup-section.tsx`, `packages/web/src/components/auth/setup-restore-card.tsx`.

- **age:** `age-encryption@0.3.1`, pinned exactly, streaming (`Encrypter.encrypt(ReadableStream)`).
  Recipients `age1…` and `age1pq1…`; the passphrase recipient is scrypt at age's default work
  factor. A pasted `age-keygen` file (comments included) is accepted as the identity.
- **zstd:** Node's `zlib.createZstdCompress`, level 3. A Node without it (older than 22.15/23.8)
  writes `.tar.gz.age` and says so in the job log; the reader sniffs the magic bytes, so either
  archive restores anywhere zstd is available. The tar is a minimal ustar + PAX writer/reader of
  our own (regular files and directories; symlinks are skipped).
- **Project allowlist:** `git ls-files --others` **without** `--exclude-standard`, restricted by
  pathspec to the allowlist and re-checked in `projectFileQualifies`. With `--exclude-standard`
  the files worth keeping — `.env` and the run history under `.ai/cezar/` — are exactly the
  ignored ones and would never qualify; the allowlist, not the ignore rules, is what keeps
  `node_modules` and build output out. `.env*` at any depth, `.ai/cezar/**` minus `worktrees/`,
  a root `config.local.json`.
- **`data/` and `agents/`:** `CEZ_HOME` minus `backups/`, `versions/`, `bin/`, `cache/`, `npm-cache/`,
  `uploads/`, `.restore*`, locks and temp files. Agents come from `agentStateLocations()`
  (`paths.ts`): `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GH_CONFIG_DIR`, `~/.ssh`, `GIT_CONFIG_GLOBAL`,
  each falling back to the tool's default outside the container; Claude's `.claude.json` rides
  as `agents/claude.json` when it lives beside its dir.
- **Restore** needs an idle workspace — a running or queued task is a 409 before the upload is
  read (review 2026-10-24; `/setup` has no runs by definition) — then holds run admission
  (`WorkspaceSemaphore.holdAdmission`) from its first step, stages under `CEZ_HOME/.restore-<job>`,
  verifies the manifest, then overlays: a file in the archive replaces the one on
  disk, nothing else is deleted — a directory where the archive has a file, and a link or file
  where it has a directory, are kept and named in the job log, never removed or written through.
  A project's files go back only to the root this machine's registry records for that id, or under
  its projects directory (`projectsDir` / `CEZ_PROJECTS_DIR`) — both read BEFORE the archive's
  `config.json` is placed, so a fresh `/setup` vouches only for the projects directory — never to
  whatever absolute path the manifest names, and each one passes `projectFileQualifies` again
  (review 2026-10-24, round 2).
  **Run history merges, it is never replaced** (review round 3): a project's `.ai/cezar/runs.json`
  folds the archive's records into this machine's — a record only here stays, one only in the
  archive is added, one in both takes the archive's copy only when its newest timestamp is later
  (a run record has no `updatedAt`) — and a `runs/<id>.ndjson` goes in only where this machine
  has none or a shorter one. The restore then leaves `CEZ_HOME/restore-marker.json`; the next
  `serve` consumes it before any store opens, and for that whole process `pruneOrphans`, the
  lifecycle's orphan cleanup and the layouts backstop list what they would remove instead of
  removing it.
  **No archived run is live:** the archive's copy of a `queued`/`running`/`waiting` record is
  written `failed` with `interrupted — captured by backup <name> while it was <status>` (the
  live record is untouched), and a restore settles any live row an older archive still carries,
  so boot recovery on the restored host never re-queues or resumes one.
  The restart re-execs the running entry (the managed `current`
  only for a managed install). The CLI restore never restarts anything.
- **Nightly** is a built-in item on the workspace automations timer (`builtins` on
  `WorkspaceAutomationScheduler`): 03:00 server time, retried every 10 minutes while the workspace
  is busy, once per night otherwise (a failure is recorded in `lastError`). It needs an `age1…`
  recipient (a passphrase is never stored) and a target; under `CEZ_AUTOMATIONS=0` there is no
  timer and the status says so. Remote retention counts only this host's archives under the prefix.
- **S3:** SigV4 by hand (pinned to AWS's worked GET example), path-style URLs, the payload hashed
  before the PUT. Default region `us-east-1`. `s3.test.ts` runs against an in-memory S3 always
  and against a real endpoint only with `BACKUP_S3_TEST_ENDPOINT` set (skipped otherwise).
- **`/setup`:** `POST /api/v1/auth/setup/restore` (public by path; setup code, enforced sign-in,
  HTTPS or loopback, no owner yet) answers `{ job }`; the page follows it with
  `GET /api/v1/auth/setup/restore?job=` — the unguessable id is the only handle — and moves to
  sign-in once the restarted cockpit answers.
- **Uploads** are the archive as the raw body (not multipart), the identity in the
  `x-cezar-backup-identity` header (base64) and, for `/setup`, the code in `x-cezar-setup-code`.
  Every gate — trust or enforced sign-in, HTTPS, no owner yet, `Content-Length` present and at
  most 1 GiB, the setup code and its throttle — answers from headers before a byte is read; the
  body then streams to `CEZ_HOME/.restore-upload-*`, cut off past its declared length. The guard
  serves `POST /auth/setup/restore` anonymously only while no owner exists (review 2026-10-24).
- **Not done:** a passphrase prompt that hides input in the CLI (it reads a line or stdin); listing
  remote archives in the cockpit; restoring onto a machine whose project roots differ.
