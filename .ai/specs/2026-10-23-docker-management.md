# Docker management — images, volumes, stack teardown, logs, exec and disk reclaim

> Status: implemented (2026-10-24). Branch: `brutus`.
> Implementation: `packages/contract/src/docker.ts`, `packages/cezar/src/services/docker-manage.ts`
> (parsers, Reclaim planner), `services/docker-logs.ts` (the follower), the `dockerRoutes` family in
> `server/server.ts`, `packages/web/src/routes/services/docker-*.tsx`. Where the build differs from the
> text below, §9 says so.
> Builds on: `2026-10-13-docker-view.md` (the view, its `docker` topic, the 3 s re-read while a
> view holds it), `2026-10-11-project-services.md` (pinned `docker compose up` services),
> `2026-10-10-worktree-lifecycle-events.md` (teardown scripts on worktree removal),
> `2026-10-10-cezar-in-a-container.md` §4 (the daemon INSIDE the container is the one this talks to).
> Backlog item: "better Docker management — creating/removing images".

## 1. Problem

The Docker view answers "what is running and whose is it" and can stop or start it. It
deliberately never removes, prunes, pulls or creates, and shows no images, volumes or logs
(docker-view §6). On the VPS that leaves four things on ssh:

- **Disk.** One shared daemon for every project and every task worktree. Each ffp task builds
  its own stack (`ffp-<port>` project with its own Postgres and MinIO); a discarded task's
  `beforeRemove` script tears it down, but a stack started by hand, a stale image, the build
  cache and volumes of stacks whose worktree is already gone all stay. The disk filled once
  during the VPS prep, with nothing in the cockpit to say so.
- **Teardown.** `stop` leaves containers, networks and volumes in place. Removing a stack the
  user no longer wants means `docker compose down` in a terminal.
- **Logs.** Only a pinned service streams its `docker compose up` output; a container someone
  else started (an agent, a script) has no log surface.
- **Exec.** "Open psql in the task's database" is a terminal command the user has to compose.

"Creating images" from the backlog turned out to be covered: lifecycle scripts (`afterCreate`)
already build and start a task's stack; nothing here builds or pulls.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Scope beyond containers | **Images, volumes, `down`/`rm` of stacks, logs and exec** | All four are the ssh reasons above. |
| "Creating images" | **Out of scope** — lifecycle scripts cover start/build | The list item was shorthand; removal is the need. |
| How far removal goes | **Everything, Docker Desktop style**: force-remove of used and running objects is allowed | The owner's call. The cockpit warns about what is in use and by which task; it does not refuse. |
| Disk | **Usage in the view and in Machine glance, one Reclaim button** that shows what it would free before it runs | Removes dangling images, build cache, and stacks of task worktrees that no longer exist. No schedule. |

## 3. Behaviour

Still `/p/:projectId/services?view=docker`. The page grows from one list into four sub-views on a
toggle group (**Containers · Images · Volumes · Disk**), all machine-wide like today, with the
current project's objects first.

### 3.1 Containers

As today, plus per stack: **Down** (`docker compose -p <name> down`, with a checkbox "also
remove its volumes" → `--volumes`) and **Remove** for a stack that compose does not know (plain
`docker rm -f` of its containers). Per container: **Remove** (`rm`, `-f` when running — the
confirm says it is running), **Logs**, **Exec**.

The confirm dialog is the whole safety: it names the stack's project and, when the stack's
working dir is a task worktree whose run is `running`/`queued`, says so in red ("task ffp-570 is
running in it"). A stack with volumes shows the volume names it will delete. Nothing is refused.

### 3.2 Images

`docker image ls --format json` + `docker image inspect` for the used-by list: repository:tag,
id, size, created, **used by** (containers, running or stopped), dangling. Per image **Remove**
(`-f` when in use, the confirm lists the containers). A filter chip: unused · dangling · all.

### 3.3 Volumes

`docker volume ls --format json` with `docker system df -v` for sizes: name, driver, size,
stack/project (compose labels, resolved through the same `projectOf` as containers), **used by**.
Per volume **Remove** (`docker volume rm`, `-f`). A volume with a size and no container is the
"orphaned task database" case this exists for; the confirm asks to type the volume's name when it
is non-empty and has no owner container — the one place a typed confirm is kept, because there
is no undo for data.

### 3.4 Logs

`docker logs --tail 500 --follow <id>` streamed over the WebSocket bus as a `docker-logs:<id>`
topic (demand-driven: the process starts on the first subscriber and is killed on the last
unsubscribe, the pattern ws.ts already enforces). Rendered in the same log pane pinned services
use. Hosted and local alike — logs are what a terminal already shows.

### 3.5 Exec

**Exec** opens the cockpit terminal (the Code page's terminal pane) with `docker exec -it <id>
<shell>` already running, `sh` falling back from `bash`. It is a terminal command, so it is
gated exactly as the terminal is (`terminalEnabled`: a local cockpit, or a hosted one that opted
in; the VPS image sets `CEZ_TERMINAL=1`). No new route executes commands in a container.

### 3.6 Disk

`docker system df --format json` → images / containers / volumes / build cache, each with total
and reclaimable, plus the daemon's data root free space (`df` of `/var/lib/docker`). The same
four numbers appear in Machine glance as one line ("Docker 41 GB, 12 GB reclaimable") with a
warning tone above 85 % of the data root.

**Reclaim** opens a dialog that lists, with sizes, exactly what it will do and lets each line be
unchecked:

1. dangling images (`image prune`),
2. build cache (`builder prune`),
3. stacks whose compose working dir no longer exists on disk — a task worktree that was removed
   while its stack was up (`compose down --volumes` per stack, named one by one),
4. stopped containers of those stacks' images.

Never: volumes of a stack whose directory exists, images in use, anything of a running task.
The result (freed bytes) is shown; the view re-reads.

## 4. API (project-scoped, both mounts, chained onto `dockerRoutes`)

```
GET    /docker/images                         → { available, reason, images: DockerImage[] }
DELETE /docker/images/:id          ?force=1   → { ok } | { error }
GET    /docker/volumes                        → { available, reason, volumes: DockerVolume[] }
DELETE /docker/volumes/:name       ?force=1   → { ok } | { error }
POST   /docker/stacks/:name/down   { volumes?: boolean }
DELETE /docker/containers/:id      ?force=1
GET    /docker/disk                           → DockerDisk (df + data root)
POST   /docker/reclaim/plan                   → ReclaimPlan (what and how much)
POST   /docker/reclaim             { steps: ReclaimStep[] }  → { freedBytes, log }
```

Schemas in `packages/contract/src/docker.ts` (one zod per shape, type inferred); ids and names
validated by the existing param regexes (`dockerContainerParamsSchema`, stack name regex, a new
volume-name regex `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`). The log topic `docker-logs:<id>`
is registered in `ws.ts` beside `docker`. `BACKWARD_COMPATIBILITY.md` §2 lists the routes.

## 5. Security

- Every mutation is a trusted-operator action (`trustedOperator()`), like the existing
  stop/start — on the VPS that is the signed-in owner.
- `docker logs` output can hold secrets an app printed; it goes through the same secret
  redaction the run log uses (`core/secret-redaction.ts`) before leaving the server.
- Exec is the terminal, with the terminal's gate; nothing here widens it.
- In the container, every command hits the inner daemon (the socket the image already
  exposes to `node`); nothing reaches the host's.

## 6. Zero config

Nothing to configure. Reclaim is a click, never a timer. All new state is Docker's own.

## 7. Not done here

- Scheduled pruning. The Reclaim dialog is the whole policy.
- Build, pull, `up` from the view (lifecycle scripts and pinned services do that).
- Compose file editing, image history, registry logins.
- Ports held by non-container processes (docker-view §6, unchanged).

## 8. Verification

- Unit: parsers for `image ls`, `volume ls`, `system df` JSON (fixtures from Docker 29);
  `groupStacks`-style ownership for volumes; the reclaim planner on a fixture (a stack whose dir
  is gone is listed, one whose dir exists is not; a running task's stack is never listed).
- Contract parity for every new route; `bc-route-inventory`.
- Cockpit: the four sub-views render from fixtures; confirm dialogs name the running task; the
  typed confirm appears only for a non-empty ownerless volume.
- VPS: discard a task with its stack up by hand first → Reclaim lists that stack; Down of an
  ffp task stack with volumes removes `ffp-<port>_pg` et al.; Logs of the main Postgres
  streams; Exec opens `psql` in the terminal; Machine glance shows the Docker line.

## 9. As built (2026-10-24)

- **Logs content rides HTTP, not the bus.** `docker-logs:<id>` carries `{cursor}` only, and the
  bytes come from one more route, `GET /docker/containers/:id/logs?cursor=`, the way terminal and
  service output already do: topics are workspace-level, and a hosted cockpit (the VPS) opens no
  socket at all, so it polls that same read. The follower lives while a subscriber holds the topic
  (the last release kills it) or a poller read it within 15 s.
- **Used-by for images** comes from `docker container inspect` (`.Image`, the digest), matched
  against `image ls --no-trunc`, rather than `image inspect`: a tag can move while a container
  still runs the old image.
- **"A stack compose does not know"** is one whose working dir is gone, or the standalone group:
  those get Remove (`rm -f` of each container) instead of Down. Down runs in the stack's dir when
  it exists (compose reads its file), else in the temp dir so no stray `compose.yml` is picked up.
- **A dir is "gone" only when this host can judge it** (`dirState`: a WSL path seen from Windows is
  `unknown`), and Reclaim lists `gone` stacks only.
- **Step 4 is folded into step 3.** A gone stack's stopped containers carry its
  `com.docker.compose.project` label and go with that stack. Nothing is proposed on its image
  digest alone: an unrelated stopped `docker run postgres:16` is someone else's. The `container`
  step kind stays in the contract and is never planned.
- **Reclaim re-plans on apply** and runs only the steps the fresh plan still holds; a step that
  dropped out is logged as skipped.
- The page is `/p/:projectId/docker` (the Docker tab moved there), sub-view in `?tab=`.
  Exec opens `/code?terminal=<session>` on a main-checkout terminal with the command typed in.
- Machine glance asks `GET /docker/disk` once per visit, and only where the terminal policy lets
  the Docker view read.
- **What "force" does is what Docker allows.** Image removal is always `image rm -f` (every tag
  goes; stopped users do not block). Docker refuses that while a container *runs* from the image,
  so `?force=1` stops those containers first. A volume is refused while any container references
  it, stopped or running, `-f` or not, so `?force=1` removes those containers (`rm -f`) first.
  Without `force` an in-use object is a 409 and nothing runs; the confirm states the step.
