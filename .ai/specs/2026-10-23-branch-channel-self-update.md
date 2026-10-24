# Self-update from a git branch — the `branch` channel, and a container that updates itself

> Status: implemented on brutus (2026-10-24); proposed 2026-10-23.
> Builds on: `2026-09-25-self-update-and-desktop.md` (the managed layout, channels, restart),
> `2026-10-10-cezar-in-a-container.md` (the image, `/data`, the entrypoint),
> `2026-10-19-repo-git-sync.md` (the bounded background fetch this copies),
> `2026-10-12-cockpit-authentication.md` (a hosted cockpit only moves forward).
> First item of the brutus backlog ("easy cezar updates, especially brutus on a VPS, without
> ssh"), which absorbs "fewer ssh tunnels for tools like the Stripe or Railway CLI".

## 1. Problem

Updating the cezar that runs on the VPS is, today, three commands over ssh on the host:
`git pull` of brutus into `/home/cezar/cezar`, `docker compose build`, `docker compose up -d`.
Everything that makes it ssh-only is a gap in what already exists:

- **The updater cannot see itself.** `src/self-update/` can install, activate and restart a
  managed install, but the image installs cezar with `npm install -g`, which `detectInstallKind`
  reports as `global-npm` and `capability()` turns into "update it with npm". The dialog on the
  VPS says exactly that and offers nothing.
- **No channel knows brutus.** `stable` and `nightly` are npm dist-tags; `development` is a
  worktree of a registered cezar repo or a PR's preview build. brutus is an unpublished branch,
  so even a managed install would have nothing to follow.
- **A restart is a container restart.** `restart.ts` re-execs from a terminal or exits 75 for a
  supervisor. In the container the server is the entrypoint's `exec`, so either path ends the
  container; Docker brings it back, and with it the inner `dockerd` restarts and every project
  service (ffp's Postgres, MinIO) is down until someone starts it again.
- **Tools die with the image.** `npm i -g @railway/cli` from the cockpit terminal lands in
  `/usr/local`, which the next rebuild replaces (docs/docker.md § Limits says so). The Stripe
  CLI is a binary with no npm package at all. Each one today is a Dockerfile line and an ssh.

The image rebuild itself stays an ssh operation — see §7 for why that is the right line — but it
must become rare: code updates and tool installs leave it.

## 2. Decisions

Taken 2026-10-23 with the owner, in the order the questions were asked.

| Question | Decision | Why |
| --- | --- | --- |
| Where does a new version come from | A git branch, fetched and **built in the container** | brutus is not published; no CI, no registry, no second moving part. The development channel already builds checkouts. |
| What restarts | **Only the cezar process** — the entrypoint relaunches it | The inner Docker daemon and the project services survive. Agents die and boot recovery (#367) brings their runs back, as today. |
| Image-level changes (Dockerfile, compose, Caddy, system tools) | Stay on ssh; **tools move to `/data`** so they stop needing a rebuild | A host-side sidecar with `docker.sock` is root on the host steered from a browser. Not worth it for a rare event. |
| When it applies | **Manually**, with a "new commits" badge | Zero-config: nothing deploys itself. "Update when idle" stays as the click's option. |
| Where the source clone lives | **The updater's own clone** under `CEZ_HOME` (`/data/cezar/source`), not a project | What is deployed from is never what an agent edits (trunk-based mode writes into a project's checkout). |
| The built artefact | **`npm pack` into `versions/<version>+<sha8>`** | Immutable, several side by side, rollback is a link flip — the same shape the registry channels use. |
| After an image rebuild, image version vs `current` | **The newer commit wins**, and says so | The image is a seed and a fallback. A rebuild with newer code must not be silently ignored, nor silently discard cockpit updates. |
| Tools | **PATH + npm prefix under `/data`**, installed from the terminal | One Dockerfile change, no UI. A catalog can come later (§7). |
| Scope of "follow a branch" | **A fourth channel, `branch`, on every managed install** | Also lets a local PC follow brutus without `npm run dev`. The container only adds the entrypoint and the seed. |
| A new version that crashes on boot | **Automatic rollback to the previous install** | Otherwise a bad commit is an ssh. |
| Checking for new commits | **On by default**, one bounded fetch, `CEZ_SELF_UPDATE_CHECK=0` turns it off | Same shape and precedent as repo auto-sync (AGENTS.md § Zero config). |
| Build vs running agents | **Build at once (`nice`), switch when idle** | A build is minutes on 8 CPU/12 GB; waiting for idle to even start it makes a long task a long deploy. |

## 3. The `branch` channel

### 3.1 Configuration

`updateChannel` gains `'branch'`. A branch channel needs to know which branch:

```jsonc
// ~/.cezar/config.json (workspace config)
{
  "updateChannel": "branch",
  "updateBranch": { "remote": "https://github.com/open-mercato/cezar.git", "branch": "brutus" }
}
```

Seeds, lowest precedence first: `CEZ_UPDATE_CHANNEL=branch` and
`CEZ_UPDATE_BRANCH=<remote>#<branch>` (the same precedence `CEZ_UPDATE_CHANNEL` has today — a
value saved from the dialog wins); in the container, the image's own source (§4.5). Both keys
are optional with `.catch`, like every workspace-config field. `remote` must parse as an
`https://` or `ssh://`/`git@` git URL; `branch` passes `isSafeGitRef`.

As built: precedence is resolved at READ time, and no seed is ever written. A save through the
dialog or `cezar update --channel` also writes `updateChannelSource: "user"`, and only a marked
save outranks the seeds: user save > `CEZ_UPDATE_*` > image source > an unmarked saved value. An
unmarked `stable`/`nightly`/`development` still counts as the user's (releases before the marker
saved only those, through the same dialog); an unmarked `branch` is an earlier build's boot seed
and ranks last, so a later `CEZ_UPDATE_CHANNEL=stable`, a new `CEZ_UPDATE_BRANCH` or an image
rebuilt from another branch is followed. A bare channel save keeps following the seeded branch;
only a save that names a branch pins it.

### 3.2 The source clone

`<CEZ_HOME>/source` — `/data/cezar/source` in the container, `~/.cezar/source` elsewhere. A
normal clone, `--single-branch`, created on first use, re-cloned when `remote` changes. Full
history, not shallow: the forward-only check (§3.6) wants ancestry, and the "what changed"
list (§3.4) wants `git diff --name-only`. `node_modules` is kept between builds; a build starts
with `git fetch`, `git checkout --detach <sha>`, `git reset --hard`, then
`git clean -fdx -e node_modules`: an earlier build's output (`dist/`, the web bundle) never
leaks into the next one, while every `node_modules` stays.

It is state: delete it and the next check clones again.

### 3.3 Checking

`SelfUpdateService.status()` already refreshes the registry cache on a timer; a branch channel
refreshes the clone the same way: one `git fetch <remote> <branch>` with a 15 s timeout, at most
every `REPO_FETCH_INTERVAL_MS` (5 min) and only while a cockpit is asking (the version chip's
status query; a closed cockpit fetches nothing). `?refresh=1` and the dialog's **Check** button
fetch now. `CEZ_SELF_UPDATE_CHECK=0` turns the background fetch off; **Check** still works.
Offline: `checkedAt` stays, `branch.error` says why, nothing else changes.

### 3.4 Status (contract)

`selfUpdateStatusSchema` gains, present only on the branch channel:

```ts
branch: {
  remote: string; branch: string;
  /** The commit the running version was built from; null for a registry install. */
  running: { sha: string; subject: string; at: string } | null;
  /** The branch tip as of the last fetch; null before the first. */
  tip: { sha: string; subject: string; at: string } | null;
  /** Commits on the tip the running build does not have. 0 when up to date. */
  behind: number;
  /** false when `running` is not an ancestor of `tip` (a force-push, a rebase). */
  fastForward: boolean;
  /** Paths under docker/ the pending commits touch — a rebuild via ssh is also due. */
  touchesImage: string[];
  fetchedAt: string | null;
  error?: string;
}
```

`updateAvailable` becomes the install id `<version>+<sha8>` when `behind > 0`, so the chip and
the "update available" plumbing need no new branch of logic. `installedVersionSchema.source`
and the manifest gain `'branch'`, and the manifest records `commit: { sha, subject, at, branch }`
— what §4.2 compares and what the dialog shows beside each installed build.

### 3.5 Applying

`POST /workspace/self-update/apply` with `version: "<version>+<sha8>"` (fits the existing id
regex). The job, logged line by line into `job.log` like an npm install:

1. `git fetch`, `git checkout --detach <sha>`, `git reset --hard` in the source clone.
2. `buildCheckout` (checkouts.ts): `npm install` when the lockfile changed, `build:server`,
   `build:web`. Under `nice -n 10` where `nice` exists (never on Windows); one job per process
   (`SelfUpdateBusyError` as today), and one build in the clone across processes (below).
3. `npm pack -w @open-mercato/cezar` and `installSpec` into `versions/<version>+<sha8>` with a
   `branch` manifest — the `installFromLocal` path with the id and manifest it needs.
4. `activate`, then restart — immediately, or **when idle** (`scheduleWhenIdle`, the existing
   poll) when the request asks or runs are active. The build (1–3) never waits for idle; only
   the link flip and restart do.

A failed build leaves `current` untouched and the clone on the attempted sha; the next attempt
resets it. Retention: after a successful activate, `branch` installs beyond the three newest
are removed (`removeInstalled`; never `current`, `previous`, the pruning process's own install,
or the one `serve` recorded at boot in `versions/.running`). Registry installs are not pruned.

As built, the server's job and a CLI `cezar update` share the clone, so steps 1–3 run under a
cross-process lock, `<CEZ_HOME>/source.lock` (`branch.ts`): pid, time, the process's start
time (Linux `/proc/<pid>/stat`) and a per-process token, written whole — to a temp file
hard-linked into place, so it is never seen half-written. A lock is held while its pid runs
and is the process that wrote it: the same token for this process, the same start time for
another. A holder that cannot be verified that way (no `/proc`) counts as stale after two
hours; a file that does not parse yet counts as held for 10 s. A stale lock is taken over by an
atomic rename, so of two processes only one wins. While another process holds it, an apply
fails with "another cezar is building in the updater's clone" and the clone's remote is never
swapped under that build.

### 3.6 Forward-only on a hosted cockpit

`forwardOnlyRefusal` compares npm publish times; for a branch target it compares **committer
dates**: a hosted cockpit refuses a target committed before the running build. Ancestry is
reported (`fastForward`), not enforced: a branch that was rebased or merged onto still carries
the guards that rule exists to protect (they live on `main`, which brutus merges), while an
older commit may not. A local cockpit keeps the full picker, as today.

As built (review round 2): the committer date alone let a hosted cockpit apply any commit object
the clone held — one a force-push dropped, or one left from a branch followed earlier. A hosted
apply of a branch build is now refused unless (1) it is committed no earlier than the running
build, (2) the followed branch's tip reaches it (`merge-base --is-ancestor <target>
origin/<branch>`, "is not on <branch>"), and (3) when the clone has the running commit, the
running commit is its ancestor ("does not descend from the running build"). Rule 2 also gates
every BUILD, local or hosted: the clone is never built from a commit its branch does not reach.
A local cockpit keeps the full picker for anything that IS on the branch. After a force-push a
hosted cockpit therefore needs the host (`cezar use <id>`, or `cezar update` there) to move on.
The other direction too: from a running branch build, a REGISTRY target must have been
published after the running build's commit (its install time when it records none) — semver
and the running version's own publish date would let it step back to a release older than the
code it runs.

### 3.7 The dialog

A fourth toggle, **Branch**. Its panel shows remote and branch, the running commit, the tip,
"N commits behind" (or "up to date"), a one-line warning when `touchesImage` is non-empty
("these commits also change `docker/Dockerfile` — rebuild the image over ssh when convenient"),
a note when `fastForward` is false, and the usual **Update** / **Update when idle** pair. The
"pick a version" list shows the installed `branch` builds by commit, for rollback by hand.
The channel toggle and the remote/branch fields are editable only when `trustedOperator()`
holds (it does on a local cockpit and on a hosted one with sign-in; `PUT …/channel` answers 409
otherwise, like agent-config writes).

### 3.8 CLI

`cezar update` honours the channel: on `branch` it fetches, builds, installs and activates,
and prints what it did; it never restarts a server. `cezar update --check` prints the status
and exits. `cezar versions` lists `branch` builds with their commit.

## 4. The container

### 4.1 The image installs into the managed layout

The runtime stage installs the tarball to `/opt/cezar/<version>+image/` with a manifest (source
`image`, plus the commit of §4.4 when known) instead of `npm install -g`. On every boot the
entrypoint links it into the volume — `/data/cezar/versions/<version>+image.<sha8> →
/opt/cezar/…` — so `listInstalled` sees it and `detectInstallKind` answers `managed` for
whatever `current` points at. A global `cezar` on PATH remains, as a launcher (`launcher.ts`'s
POSIX script with `CEZ_HOME` baked), so `docker compose exec -u node cezar cezar auth setup` keeps
working. As built, the launcher refuses `update`/`install`/`use`/`link`/`serve` as root (the entrypoint, `CEZ_ENTRYPOINT=1`, excepted) with a `-u node`
hint: run as root they would create a root-owned `/data/cezar/source` or `versions/` entry; `serve` itself also writes `versions/.running` only as the install's owner.

### 4.2 Which version boots

The entrypoint, before starting the server:

- no `current` → activate the image's install;
- `current` exists → compare its manifest's date with the image's `commit.at`: the newer one is
  activated, and the choice is logged with both dates (`cezar: starting 0.17.0+a1b2c3d4 (branch,
  committed 2026-10-23…) — newer than the image's 0.17.0+image.e5f6… (committed 2026-10-20…)`).
  As built, `current` is dated by `commit.at`, else (a registry, local or link install) by the
  registry `publishedAt` its manifest records, else by `installedAt` — counting a commitless
  install as always newer would stop image rebuilds from deploying code;
- the image carries no commit (built without §4.4's args) → `current` stays; logged too.
  As built, an image commit date that does not parse counts the same: unknown age, `current` stays.

### 4.3 The supervisor loop

The entrypoint's final `exec` becomes a loop, and the image sets `CEZ_SUPERVISED=1` so
`restart.ts` exits 75 instead of re-exec'ing:

```sh
while :; do
  started=$(date +%s)
  setpriv --reuid=node --regid=node --init-groups node "$(current_entry)" serve ...
  code=$?
  [ "$code" = 75 ] && continue                       # update: relaunch from the new `current`
  if [ "$code" != 0 ] && [ $(( $(date +%s) - started )) -lt 30 ] && previous_exists; then
    relink_previous; record_rollback "$code"; continue   # crash on boot: back to what ran before
  fi
  exit "$code"
done
```

`previous` is the install `current` pointed at before the last activate (a `previous` link
beside `current`, written by `activate`). A rollback is recorded in
`/data/cezar/rollback.json` (`{ from, to, exitCode, at }`); the status route reports it until
the next successful apply, and the dialog shows "rolled back from X: it exited with N within
30 s". As built, "just activated" is state, not the loop's memory: every `activate` (the server's,
`cezar update` from the CLI, the boot choice) writes `versions/.fresh` naming the id it switched
to, and the supervisor's first launch of that id consumes it and arms the 30 s guard — so a CLI
update followed by a container restart is guarded like a dialog update. One rollback per boot sequence — a `previous` that also crashes exits the loop and
Docker's restart policy takes over, which is today's behaviour.

The container keeps `init: true`: tini stays PID 1, the loop is its child, and the inner
`dockerd` — started earlier by the same entrypoint — is untouched by anything in the loop.

### 4.4 Image metadata

`.dockerignore` excludes `.git`, so the build cannot ask git. The Dockerfile takes
`ARG CEZ_SOURCE_COMMIT CEZ_SOURCE_BRANCH CEZ_SOURCE_REMOTE CEZ_SOURCE_COMMITTED_AT`, writes them
to `/opt/cezar/source.json`, and `compose.yml` passes them through from the environment
(`${CEZ_SOURCE_COMMIT:-}`). docs/docker.md shows the one-liner; the VPS redeploy script sets
them. Absent, the image is "a build of unknown age" (§4.2 third case) — degraded, not broken.
Rejected: un-ignoring `.git/HEAD` and refs — packed refs make it unreliable for one field.

### 4.5 Seeding the channel

First boot with no `updateChannel` saved and `/opt/cezar/source.json` present: the entrypoint
exports `CEZ_UPDATE_CHANNEL=branch` and `CEZ_UPDATE_BRANCH=<remote>#<branch>` from it, which the
service treats as the seed it already knows. A saved channel always wins, so an operator who
switched to `stable` is not switched back by a rebuild. Nothing is written into the config
(§3.1 as built); the `cezar` launcher repeats the same export, so `docker compose exec -u node
cezar cezar update` follows the same branch.

### 4.6 Tools under `/data`

Dockerfile, after its own global installs:

```dockerfile
ENV PATH=/data/bin:/data/npm/bin:$PATH NPM_CONFIG_PREFIX=/data/npm
```

The entrypoint creates and chowns `/data/bin` and `/data/npm`. `npm i -g @railway/cli` from the
cockpit terminal now lands in the volume and survives a rebuild; a release binary (the Stripe
CLI) goes to `/data/bin`. Agents see the same PATH (`agent-env.ts` already allowlists it). The
image's own `/usr/local/bin` stays on PATH behind them, so a `/data` install shadows an image one
of the same name — which is what "I installed a newer one" should mean. docs/docker.md § Limits
is rewritten accordingly.

### 4.7 What still needs ssh, and how the cockpit says so

Dockerfile, `compose*.yml`, `Caddyfile`, `entrypoint.sh`, apt packages, the Node major, Sysbox and
the host. The updater does not pretend otherwise: `touchesImage` (§3.4) lists the `docker/` paths
the pending commits change, and the dialog says a rebuild is also due. The code update still
applies — it is the same tarball the new image would carry.

## 5. Security

- **Who can apply** is unchanged: the route family is workspace-level and a hosted cockpit sits
  behind cezar's sign-in (spec 2026-10-12). Setting the remote is a trusted-operator write
  (§3.7) — the same line agent-config draws, for the same reason: a remote URL is code the
  server will run.
- **Forward only** on a hosted cockpit, by committer date (§3.6).
- **The rollback** is the one path that moves backwards, and it is not a request: it runs in the
  entrypoint, only when the version that was just activated dies within 30 s, and only to the
  install that was running moments before — already trusted. Making a build crash on boot
  requires a push to the followed branch, which is already full control.
- **Credentials:** the fetch uses whatever git in the container already has (`/data/ssh`,
  `gh` auth) — nothing new is stored. A public repo needs none.
- **The clone is never served or browsed**: it is not a project, not under the browse root.

## 6. Zero config

- The background fetch is **default-on** and bounded exactly like repo auto-sync: one
  `git fetch` of one branch, at most every five minutes, only while a cockpit asks,
  `CEZ_SELF_UPDATE_CHECK=0` turns it off. AGENTS.md § Zero config gets the matching
  owner-approved line; `.env.example` and `docs/reference.md` document the variable.
- Nothing applies itself. Nothing restarts without a click (or the idle poll after one).
- New state only: `source/`, `source.lock`, `versions/*+<sha8>`, `previous`, `versions/.fresh`,
  `versions/.running`, `rollback.json`, `/data/bin`, `/data/npm`. Delete any of it and the next run recreates what it needs.
- `CEZ_UPDATE_BRANCH` joins `.env.example` beside `CEZ_UPDATE_CHANNEL`.

## 7. Not done here

- **Rebuilding the image from the cockpit** (a host-side agent). Decided against (§2).
- **A Tools catalog** in Settings (stripe, railway, vercel, supabase, flyctl with one button).
  §4.6 is the floor it would stand on.
- **Auto-apply** (a "when idle, always" switch). Manual first; revisit once a month of manual
  updates has shown what a surprise restart would cost.
- **Build admission** against `2026-10-13-host-pressure-admission` — `nice` is the whole policy.
- **Switching the Node major** without a rebuild; **Caddy** and the overlays.
- **A published image** — still a release decision (container spec §6).

## 8. Verification

Unit (vitest, `packages/cezar/src/self-update/`):

- channel resolution: user-saved config > `CEZ_UPDATE_*` > container seed > an unmarked save; an
  invalid remote or ref is dropped with the config's usual `.catch`;
- `branch` status from a fixture clone: `behind`, `fastForward` false after a force-push,
  `touchesImage` from a commit that edits `docker/Dockerfile`;
- forward-only by committer date, branch reachability and (when the clone has it) descent from
  the running commit — each refusal tested;
- apply pipeline with a stubbed `runNpm`: checkout → build → pack → install → activate order,
  a failing build leaves `current` and `previous` untouched, retention keeps three;
- entrypoint loop as a shell test with a fake `node` (exit 75 → relaunch from the new link;
  exit 1 at 2 s → `previous` relinked and `rollback.json` written; exit 1 at 60 s → loop exits;
  a second crash → loop exits);
- `contract-parity`, `typed-bodies` and the dialog's tests extended for the new fields and
  the fourth toggle. The regression tests are proven red without the fix (AGENTS.md).

On the VPS, in this order:

1. rebuild once over ssh with §4.4's args; the dialog shows the Branch panel, "up to date",
   install kind `managed`;
2. push a one-line commit on brutus → badge within five minutes → **Update** → health answers,
   `GET /workspace/self-update` shows the new sha, `docker ps` inside shows ffp's services never
   restarted, the agents' logins and the owner account are intact;
3. push a commit that throws at boot → **Update** → the dialog reports the rollback, the old sha
   serves; push the fix → **Update** → clean;
4. `npm i -g @railway/cli` from the terminal, rebuild the image over ssh, `railway --version`
   still answers; the rebuilt image is older than `current` → log says `current` kept;
5. a commit touching `docker/Dockerfile` → the dialog says a rebuild is also due.

## 9. Open questions

1. Should `PUT …/channel` accept the remote URL from the cockpit at all on a hosted cockpit, or
   only the channel, with the remote fixed by the image/env? Proposed: accept under
   `trustedOperator()` (§3.7); the owner may prefer env-only on hosted.
2. Full clone vs `--depth` with `--deepen` on demand. Proposed full (§3.2); brutus history is
   small enough that the first clone is seconds.
3. Does "idle" for the switch count queued runs as busy? Proposed: the existing `idle` of the
   semaphore, unchanged — the question belongs to `scheduleWhenIdle`, not here.
