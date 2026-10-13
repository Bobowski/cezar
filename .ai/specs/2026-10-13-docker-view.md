# Docker view — what is running on the machine, and whose it is

> Status: implemented (2026-10-13). Branch: `brutus`.
> Implementation: `packages/contract/src/docker.ts`, `packages/cezar/src/services/docker.ts`, the
> `dockerRoutes` family in `server/server.ts`, `packages/web/src/routes/services/docker-view.tsx`.
> Builds on: `2026-10-11-project-services.md` (which kept per-container rows out of v1, §8/§9).

## 1. Problem

Several projects on one machine each bring their own Postgres, Redis and search container, and
they publish the same host ports. Starting project A while project B's database is still up fails
with a port collision — or worse, connects A to B's data. On a laptop the answer is Docker
Desktop; on a VPS reached only through the cockpit there is no such window.

## 2. Behaviour

`/p/:projectId/services?view=docker` — a second tab on the Services page.

- **Every container on the machine**, running or stopped, grouped by compose project. Containers
  that belong to none form one last group.
- **Whose it is.** A stack's `com.docker.compose.project.working_dir` label is matched against
  the registered projects' roots (deepest root wins; a task worktree sits inside its project's
  root, so it resolves to that project). The stack of the project being viewed is listed first.
- **Port conflicts.** For each compose file discovery finds in THIS project, the host ports it
  publishes are read with `docker compose config --format json` (compose resolves env
  interpolation and `extends`; no daemon needed). A port a RUNNING container of another stack
  holds is a conflict, shown at the top with a button that stops the holder.
- **Actions.** Stop / start a stack (`docker compose -p <name> stop|start`) or one container.
  Nothing is removed, pulled or created: the view never runs `up`, `down` or `rm`.

## 3. States and who fires each transition

A container is `running` or not; the view claims nothing else. Transitions are fired by the user
here, by a pinned service's `docker compose up`, or by anything else on the machine — so the
server re-reads `docker ps` every 3 s **only while a view holds the `docker` topic** and publishes
a bare version counter when the set of running containers or published ports changes. Where the
bus is unusable the view polls the route instead. No view open means no `docker` process.

## 4. API (project-scoped, both mounts)

| Route | Purpose |
| --- | --- |
| `GET /docker` | `{ available, reason, stacks[], conflicts[], topic }` |
| `POST /docker/stacks/:name/start` · `/stop` | one compose project |
| `POST /docker/containers/:id/start` · `/stop` | one container |

A stack or container is addressable only if the current listing shows it (`404` otherwise); the
name and id are pattern-validated before they reach an argument array. Docker failing is
`available: false` with a reason on the read and `409 {error}` on an action — never a 5xx.

## 5. Exposure

Reading and stopping other projects' containers is a shell-level capability: every route, reads
included, follows the terminal policy (`CEZ_TERMINAL`, as services do) and refuses a task's own
credential — the run-token allowlist does not list the family either. No new `CEZ_*` variable.
`CEZ_DRY_RUN=1` never shells out to `docker`.

## 6. Not in v1

- Ports held by a process that is not a container (a native Postgres). The conflict list names
  containers only.
- Ports a STOPPED foreign stack would take: Docker reports published ports for running containers.
- Logs, exec, images, volumes, `down`/`rm`. A pinned `docker compose up` service already streams logs.
- cezar itself running in a container (needs the host's socket — the container spec's decision).
