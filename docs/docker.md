# cezar in a container

One image holds cezar and what a project needs to be built in it — git, a compiler toolchain,
Node, Python, the coding-agent CLI, and a Docker daemon of its own for the project's services.
Your machine needs Docker and a browser. Nothing else is installed on it, and it behaves the
same on Windows, macOS, Linux and a VPS.

```bash
docker compose -f docker/compose.yml up -d --build
```

Then open <http://localhost:4321>.

> **Status:** the image builds and boots (inner Docker daemon, `claude`, `gh`, cezar's sign-in),
> and the VPS overlay below has been run end to end on a workstation (`CEZ_DOMAIN=localhost`):
> sign-in, a real agent task in a worktree with its own services, and previews through the
> gateway. It has not run on a live VPS with a public certificate yet.

## First run

**Log the agent in.** Either pass a credential through the environment — put it in a `.env`
file beside `docker/compose.yml`:

```bash
ANTHROPIC_API_KEY=sk-ant-...        # or CLAUDE_CODE_OAUTH_TOKEN=...
GITHUB_TOKEN=ghp_...                # optional: issues, PRs, draft PRs
```

or log in once from inside the container; the login is kept in the `data` volume:

```bash
docker compose -f docker/compose.yml exec -u node cezar claude
```

```bash
docker compose -f docker/compose.yml exec -u node cezar gh auth login
```

**Tell git who you are**, once — agents' commits carry your identity already, but a commit you
make in the cockpit's terminal needs it (kept in the `data` volume):

```bash
docker compose -f docker/compose.yml exec -u node cezar sh -c 'git config --global user.name "Your Name" && git config --global user.email you@example.com'
```

**Add a project.** In the cockpit, clone a repository — it lands in `/projects`, a volume. The
cockpit is the editor, the terminal and the browser for it; there is no folder on your machine
to open in something else, by design.

**Give it its secrets.** Create the project's `.env` files in the Code view or the terminal, in
the project's main checkout. Every task worktree gets a copy of the gitignored ones
automatically (see [reference → env files](reference.md)).

## What works the way it does locally

| | In the container |
| --- | --- |
| Tasks, worktrees, review, draft PRs | Unchanged. |
| Terminal in a task | On. The shell is inside the container, in the task's worktree, as user `node`. |
| Editing files in the Code view | On. |
| A project's services (`docker compose up` for its Postgres, Redis…) | Run on the container's **own** Docker daemon, so `localhost:5432` means to the app what it means on a developer's machine. |
| Previewing a task's app in the Browser column | Through the [preview gateway](server-install/ubuntu-vps.md#previewing-a-tasks-app-the-preview-gateway): type `localhost:3000`, and it is framed from `localhost:85xx`. Up to twenty apps at once. |
| Running the same app in several tasks | Each task has `CEZ_TASK_SLOT` and `CEZ_TASK_PORT_BASE` ([reference](reference.md#running-the-same-app-in-several-tasks-at-once-the-task-slot)). |
| Design Mode | Not available — it needs a cockpit on the same machine as the app. |
| "Open in editor / terminal / file manager" | Not available — there is no host machine to open them on. |

## What is where

| Volume | Holds | Lose it and… |
| --- | --- | --- |
| `data` → `/data` | cezar's registry and task history, the agents' logins, `gh` login, git identity, SSH keys | you log in again and re-add projects |
| `projects` → `/projects` | the repositories and their task worktrees | you clone again; anything not pushed is gone |
| `docker` → `/var/lib/docker` | images and data of the projects' own services | they are pulled and seeded again |

Upgrading is a rebuild: `docker compose -f docker/compose.yml up -d --build`. The volumes stay.

## Security, plainly

- Locally the cockpit and the preview ports are published on **`127.0.0.1` only** — this
  container hands out a shell; never widen those addresses. On a server use
  `compose.vps.yml`, which publishes nothing of cezar's and puts Caddy (TLS) and cezar's own
  sign-in in front.
- The container is **`privileged`**, for its inner Docker daemon. An agent's commands run as the
  unprivileged user `node`, but that user drives the inner daemon, and a privileged container it
  starts sees the host's block devices (verified: `docker run --privileged alpine ls /dev` lists
  them). **Whoever controls an agent — you, or text the agent reads (an issue, a web page, a
  dependency) — can become root on the host.** On a laptop that is the same trust you give any
  agent; on a server it is the whole server. See [Security checklist](#security-checklist-for-a-vps).
- To run without the inner daemon, remove `privileged: true` and set `CEZ_DOCKER=0`. cezar runs;
  projects that need their own services will not start them.

## On a VPS

A Linux box with Docker, a domain whose `A` record points at it, and ports 80, 443 and
8500-8519 open. The overlay `docker/compose.vps.yml` adds **Caddy**, which fetches a Let's
Encrypt certificate and forwards the cockpit (`https://<domain>`) and the preview gateway
(`https://<domain>:8500-8519`) to the container. The host needs Docker and [Sysbox](#sysbox-the-inner-daemon-without-privileged), nothing else.

```bash
git clone https://github.com/open-mercato/cezar && cd cezar
echo "CEZ_DOMAIN=agents.example.dev" > docker/.env
docker compose -f docker/compose.yml -f docker/compose.vps.yml -f docker/compose.sysbox.yml up -d --build
docker compose -f docker/compose.yml exec -u node cezar cezar auth setup
```

The last command prints a one-time `/setup#code=…` link: open it on `https://<domain>` within
15 minutes to create the owner account (password + authenticator app). Every request is behind
that sign-in; the gateway's ports admit only a ticket the signed-in cockpit hands out.

The VPS must be a full virtual machine (KVM — an OpenVZ/LXC container cannot run Sysbox or a
nested daemon), with kernel 5.12 or newer.

### Sysbox: the inner daemon without `privileged`

On a VPS run the container under [Sysbox](https://github.com/nestybox/sysbox): its Docker
daemon then lives in a user namespace, and a container an agent starts — `--privileged` or not —
cannot reach the host. `docker/compose.sysbox.yml` switches the runtime; it goes last:

```bash
docker compose -f docker/compose.yml -f docker/compose.vps.yml -f docker/compose.sysbox.yml up -d --build
```

Install it once on the host (Ubuntu 22.04+/Debian 11+, kernel 5.12 or newer — `uname -r`), from
the `.deb` on the project's [releases page](https://github.com/nestybox/sysbox/releases) for your
architecture:

```bash
docker rm -f $(docker ps -aq)          # the installer restarts Docker; nothing may be running
sudo apt-get install -y jq ./sysbox-ce_<version>.linux_amd64.deb
sudo systemctl status sysbox --no-pager
docker info | grep -i runtimes         # lists sysbox-runc
```

Prove it before you rely on it — every line is expected to behave as commented:

```bash
c="docker compose -f docker/compose.yml exec -u node cezar"
$c docker info --format '{{.ServerVersion}}'                                   # the inner daemon runs
$c docker run --rm --privileged alpine sh -c 'ls /dev | grep -E "^(sd|vd|nvme)"'   # prints nothing
docker inspect cezar-cezar-1 --format '{{.HostConfig.Privileged}} {{.HostConfig.Runtime}}'  # false sysbox-runc
```

Without Sysbox (a workstation, Docker Desktop) leave the overlay out: the container stays
`privileged`, with the reach described under [Security, plainly](#security-plainly).

### Security checklist for a VPS

Verified on the overlay (2026-10-21, `CEZ_DOMAIN=localhost`) unless marked **on the box**:

| Check | Expected | How |
| --- | --- | --- |
| Only Caddy is published | `80`, `443`, `8500-8519`; cezar's container has no host ports | `docker ps` |
| Every API route without a session | `401` (SSE, files, agent-config, health included) | `curl -k https://<domain>/api/v1/health` |
| Cross-origin write, WS without session | `403` | |
| HTTP | `308` to the same path on `https://<domain>` | `curl -I http://<domain>/x` |
| Cockpit headers | HSTS, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff` | `curl -kI https://<domain>/` |
| Sign-in throttling | `429` + `Retry-After` after five failures, forged `X-Forwarded-For` ignored | |
| **On the box:** the address cezar records | your real IP, not a Docker gateway (`172.x.0.1`) | `docker compose … exec cezar tail /data/cezar/auth-audit.ndjson` after a sign-in from your phone. A gateway address means every client shares one throttle key, so a stranger's failures delay yours. |
| Preview port without its cookie | `401`, also with a forged ticket | `curl -k https://<domain>:8500/` |
| Preview targets | only loopback `http://`; never cezar, a pool port, another host | |
| Cookies across preview ports | the app never receives `__Host-cez_session` and cannot overwrite it | |
| Second account / setup link | refused once the owner exists | `cezar auth setup` |
| Telemetry | nothing sent without a yes | |

What the box itself needs:

- **Sysbox** ([above](#sysbox-the-inner-daemon-without-privileged)), proven with its three checks.
  Even so, keep the VPS for cezar alone: the agents and `gh` hold your logins, and a box that
  serves nothing else has nothing else to lose.
- **SSH by key only**, root login off. `cezar auth reset`/`setup` are run over SSH
  (`docker compose -f docker/compose.yml exec -u node cezar cezar auth …`) — the box is the root
  of trust for the cockpit's accounts.
- **Firewall:** allow `22`, `80`, `443`, `8500-8519`. Docker opens published ports past `ufw`
  on its own, so nothing else must be published: never add `ports:` to the `cezar` service.
- **Backups.** Settings → Backup (spec `.ai/specs/2026-10-23-backup-restore.md`) writes an age-
  encrypted archive of `/data` plus each project's untracked `.env*` and `.ai/cezar/` files: paste
  an `age1…` public key once (`age-keygen` on your laptop), then **Back up now** and download it,
  or set an S3-compatible bucket (R2, B2, MinIO) and switch **Nightly** on. A rebuilt box restores
  from the `/setup` page before any account exists — the setup code still gates it — or with
  `cezar backup restore <file>`. The archive opens with `age -d -i key.txt f.age | zstd -d | tar t`.
  Caddy caps request bodies at 32 MB except on the two restore uploads
  (`/api/v1/auth/setup/restore`, `/api/v1/workspace/backup/restore`), which get 1 GiB — cezar's
  own cap; a hand-written proxy in front of cezar needs the same exception.
  The manual way still works: the `data` volume holds the agents' and `gh` logins and the
  cockpit's accounts — a backup of it is a secret; keep it encrypted and off the box:

  ```bash
  docker run --rm -v cezar_data:/data:ro -v "$PWD:/backup" alpine tar czf /backup/cezar-data.tgz -C /data .
  ```

  Restore is the same `tar xzf` into the volume (tested: identical files, `0600` kept). For
  `projects` the backup is `git push` — anything not pushed lives only there. `docker` holds the
  projects' service data, which seeds rebuild.
- **Upgrading** is `git pull` and `docker compose -f docker/compose.yml -f docker/compose.vps.yml up -d --build`.
  The volumes survive it: accounts, logins, projects and task history stay.

## Limits

- An app that calls its own backend by an absolute address (`http://localhost:9000` baked into
  a frontend bundle) makes that call from your browser, where port 9000 is not published. Open
  the backend in a second Browser tab to learn its gateway address and point the app at it.
- The image ships Node 22. A project that pins another version can switch with `n auto` (reads
  `.nvmrc`) from the terminal, as root: `docker compose exec cezar n 20`.
- Claude Code and Codex CLIs are preinstalled. Other agent CLIs can be installed with
  `docker compose exec cezar npm i -g …`; they are gone after a rebuild.
