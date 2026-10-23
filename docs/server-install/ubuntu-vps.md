# Remote access — Ubuntu / Debian VPS

Host the cezar cockpit on a bare Ubuntu/Debian server, reachable over the
internet over HTTPS, behind cezar's own sign-in.

**How it's wired:** cezar itself stays **loopback-bound** (`127.0.0.1:4321`,
`CEZ_REMOTE=1`). **nginx** is the only public surface — it terminates TLS and
proxies to cezar, WebSocket upgrades included. **cezar signs you in itself**: a
password plus a code from an authenticator app, one session per device. A
systemd service keeps cezar running and restarts it on boot.

```
  internet ──HTTPS──► nginx (:443)  ──proxy──►  cezar (127.0.0.1:4321)
                      Let's Encrypt              sign-in + sessions, systemd service
```

Signed in, you have the whole cockpit — the terminal, file editing and agent
config included (spec `.ai/specs/2026-10-12-cockpit-authentication.md`).

The wizard never escalates silently: **every privileged command is printed**,
and you choose to run it via `sudo` or paste it into a root shell yourself. Each
command is verified before the installer moves on.

---

## Prerequisites

- Ubuntu/Debian VPS with `apt`, reachable over SSH.
- A **normal, sudo-capable user** (the wizard refuses to run as root).
- At least one logged-in agent CLI on that user — `claude`, `codex`, or
  OpenCode (experimental). (The installer can install `gh` and the npm-based CLIs for you.)
- A **domain** with a DNS `A`/`AAAA` record pointing at the box. cezar's sign-in needs HTTPS, so
  with it the domain is required, not optional.
- An **authenticator app** on your phone (1Password, Google Authenticator, Authy…).
- **Ports 80/443 free.** If another reverse proxy already owns them (Dokploy,
  Coolify, Caddy…), don't run the default install — see
  [The box already has a reverse proxy](#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy).

> Tools installed in `~/.local/bin` or via nvm are found automatically — the
> installer merges your **login-shell PATH** before probing, so `claude`/`gh`
> are detected even when launched non-interactively.

---

## Install

From a published release:

```bash
npx cezar-run server-install --platform ubuntu-vps
```

Or from a git checkout on the box:

```bash
git clone https://github.com/open-mercato/cezar && cd cezar
npm install && npm run build
node packages/cezar/dist/index.js server-install --platform ubuntu-vps
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects `claude` / `codex` / `opencode` / `gh` / `git`; offers to install the missing ones. At least one agent CLI is required. |
| **Reverse proxy** | Installs **nginx**, asks **how people sign in** (below), writes an SSE- and WebSocket-safe proxy vhost (request bodies up to 32 MB, cezar's own limit), and — if `ufw` is active — allows `Nginx Full` (ports 80/443). With cezar's own sign-in it **starts the service first** and writes the site only once an anonymous request to it is refused (401). A site `nginx -t` rejects is not left in place: the previous one is put back and the step fails. |
| **Domain + SSL** | Points the vhost's `server_name` at your domain, then runs `certbot --nginx` for a Let's Encrypt certificate with auto-redirect. On a re-run certbot's TLS lines are carried into the rewritten site, so HTTPS stays up (and port 80 keeps answering even when certbot added no redirect block). **Required** with cezar's own sign-in; optional (and skippable) with Basic-Auth. |
| **Service** | Installs a **systemd** unit (rootless `--user` + linger where possible, else a system unit), **starts cezar now**, enables it on boot, and waits for it to answer on the loopback port. On a re-run a unit whose content changed is **restarted** (and the restart is proven by a new PID); an unchanged one is left running. A unit that differs only in its `PATH` line (the installer was run from another shell) is rewritten but **not** restarted — the new `PATH` applies on the next restart. |
| **Verify** | Confirms an anonymous API request is refused (401) **and** that an authenticated one reaches *this* install — a real end-to-end check, not just "nginx is up". With cezar's own sign-in it then prints the **one-time link that creates your account**. |

### How people sign in

The reverse-proxy step asks once and remembers the answer:

- **cezar's own sign-in** (the default) — a password and an authenticator code,
  a session per device, and a device list you can sign out from. nginx
  authenticates nobody; it only rate-limits the sign-in routes. Needs the domain
  and SSL step.
- **HTTP Basic-Auth in nginx** — one shared password in an `htpasswd` file, as
  before this choice existed. Works without a domain. The service then runs with
  `CEZ_AUTH=0`, and the terminal, file editing and agent-config writes stay off
  unless you opt in (`CEZ_TERMINAL=1`, `CEZ_FILE_EDIT=1`). `--yes` always takes
  this one, because it also skips the SSL step.

Switching an existing install from Basic-Auth to cezar's sign-in
(`--reconfigure nginx-proxy,ssl,autostart`) never leaves the cockpit without a
login: the installer rewrites the unit and restarts the service first, checks
that an anonymous `GET /api/v1/health` on loopback answers 401, and only then
removes `auth_basic`. If that check fails the step stops and says so — the
Basic-Auth site is still the one serving.

### Creating your account

With cezar's own sign-in the install ends with a link:

```
https://agents.example.dev/setup#code=…
```

Open it within 15 minutes. You choose a username and password, scan a QR code
with your authenticator app, and save ten recovery codes. That account is the
owner. After that, every device signs in with the password and a code.

On the server, later:

```bash
cezar auth status          # who exists
cezar auth setup           # a fresh link, while no account exists yet
cezar auth reset <user>    # lost the password or the authenticator: sign that user out
                           # everywhere and print a link to set both again
```

There is no email recovery and no way to replace the authenticator from the
browser — both go through SSH on purpose.

### The privileged-command prompt

For each root action you're asked:

- **"I'll run it myself as root"** (default) — the installer prints the exact
  command; you paste it into a root shell, then confirm. File writes show the
  **decoded** file content first, so nothing is hidden inside base64.
- **"Run it now via sudo"** — the installer runs it for you and streams output.

Your choice is remembered for the rest of the run.

---

## The box already has a reverse proxy (Dokploy, Coolify, Caddy…)

The default install above assumes cezar owns the HTTP front. If something else
already serves **:80/:443** — Dokploy/Coolify (which run **Traefik** in Docker),
a hand-rolled nginx, Caddy — installing cezar's nginx would fight it for those
ports. Use `--external-proxy`:

```bash
npx cezar-run server-install --platform ubuntu-vps \
  --external-proxy --domain cezar.example.com --bind-host 172.17.0.1
```

That installs **the service only** — no nginx, no certbot. Steps run:
`deps → autostart → identity`. Your proxy terminates TLS; the installer asks
whether cezar signs people in (the default) or your proxy does.

```
internet ──HTTPS──► your proxy (Traefik/Caddy/nginx) ──► cezar (172.17.0.1:4321)
                    TLS is YOURS to configure                  sign-in, systemd service
```

With cezar's own sign-in the proxy needs no auth middleware. It does need to
terminate TLS, send `X-Forwarded-Proto: https` with the original `Host`, and
pass WebSocket upgrades for `/api/v1/ws` — Traefik and Caddy do all three by
default.

> ⚠️ **If you choose "my reverse proxy authenticates"**, the service runs with
> `CEZ_AUTH=0` and cezar authenticates nobody: anyone who can reach the bound
> host:port can run agents on your box. Put auth on the proxy. In either mode,
> keep the port off the public internet (ufw / cloud firewall).

### Which `--bind-host`?

| Your proxy runs… | `--bind-host` | Why |
|---|---|---|
| **in a container** (Dokploy/Coolify → Traefik) | `172.17.0.1` (docker bridge) | a container cannot dial the host's `127.0.0.1` |
| **on the host** (nginx, Caddy, HAProxy) | omit (defaults to `127.0.0.1`) | loopback is reachable and stays private |

Check your bridge address with `ip -brief addr show docker0`.

### Wiring it to Dokploy / Traefik

Traefik needs a route to a **host** address, so use a file-provider config
(the installer prints this snippet, filled in, at the end of the run):

```yaml
http:
  routers:
    cezar:
      rule: "Host(`cezar.example.com`)"
      entryPoints: [websecure]
      service: cezar
      tls: { certResolver: letsencrypt }
  services:
    cezar:
      loadBalancer:
        servers: [{ url: "http://172.17.0.1:4321" }]
```

That is the whole config with cezar's own sign-in. If you chose to let the proxy
authenticate instead, add a `basicAuth` (or SSO) middleware to the router — the
installer prints that variant when you pick it.

`server-deploy` and `server-uninstall` work the same in this mode (uninstall
only removes the service — it never touches the proxy it doesn't own).

---

## Updating / redeploying a new version

Once a new cezar is available (a fresh local build, or a newly published
release), reload the running service with one standardized command:

> **Upgrading an install made before cezar had its own sign-in?** Its nginx still
> asks for the Basic-Auth password, and the cezar it restarts into now asks for
> an account as well. `server-deploy` says so and changes nothing. Either run
> `cezar auth setup` and then drop the proxy login with
> `server-install --platform ubuntu-vps --reconfigure nginx-proxy,ssl,autostart`,
> or add `Environment=CEZ_AUTH=0` to the service to keep only Basic-Auth.

```bash
npx cezar-run server-deploy --platform ubuntu-vps
#   from a checkout:  node packages/cezar/dist/index.js server-deploy --platform ubuntu-vps
#   npm script:       npm run server-deploy -- --platform ubuntu-vps
```

`server-deploy` reloads systemd, **restarts the cezar service**, waits for it to
answer, and re-runs the same authenticated end-to-end check as install — so a
green deploy means the cockpit is actually serving the new version.

- **From a checkout** the service runs `<node> <repo>/packages/cezar/dist/index.js` — so build
  first, then deploy: `git pull && npm run build && npx cezar-run server-deploy --platform ubuntu-vps`.
- **Via npx** the service runs `npx --yes cezar-cli` (the original alias of the
  same package, whichever alias launched the installer). npx caches the resolved
  package under `~/.npm/_npx` and reuses it on restart, so `server-deploy` first
  **clears that cached `cezar-cli` build** and then restarts — the next launch
  re-resolves the latest published version. (Before this, a restart silently
  kept running the cached version — see #696.) `server-deploy` alone is enough.
- **A restart that fails, fails the deploy.** A non-zero `systemctl restart`, or a
  restart that leaves the *same* process serving (same PID and start time), exits
  non-zero with no "complete" line instead of reporting success over stale code —
  so cron/CI can trust the exit status. (Before this, the port answering was the
  whole check, and the old process answered it too — see #912.)

The installer is also **idempotent** if you need to change the setup itself:

- `--reconfigure <ids>` — force specific steps (`deps,nginx-proxy,ssl,autostart,identity`).
- `--reinstall` — force **every** step (rewrites the unit, htpasswd, vhost…).
- `--reconfigure ssl` — add HTTPS to an existing HTTP-only install (needs a domain).

> Use `--reconfigure autostart` (not just `server-deploy`) when the **unit file
> itself** changed — e.g. after upgrading the installer — since a restart alone
> won't rewrite it. It rewrites the unit and, when the content changed, restarts
> the service — running tasks are interrupted, as with `server-deploy`. A change to
> the `PATH` line alone does not restart; run `server-deploy` to apply it.

---

## Hosting several cockpits on one box (multiple domains)

One VPS can run **several independent cezar cockpits**, one per domain. Each
instance gets its **own** loopback port, nginx site, htpasswd, systemd service,
and state file — they share only nginx and certbot, which route by `Host`
header. Pass `--domain` to select or create an instance:

```bash
# first cockpit — the default instance (loopback :4321, ~/.cezar/server.json)
npx cezar-run server-install --platform ubuntu-vps

# a SECOND, fully independent cockpit for another domain
npx cezar-run server-install --platform ubuntu-vps --domain shop.example.com
```

Because instances are **keyed by domain**, running `server-install` again with a
**new** `--domain` never resumes or overwrites an existing install — it stands
up a fresh instance. Run it again with the **same** `--domain` to resume or
reconfigure that instance.

What differs per instance:

| Instance | State file | nginx site | htpasswd | systemd unit | Loopback port |
|----------|-----------|-----------|----------|--------------|---------------|
| default (no `--domain`) | `~/.cezar/server.json` | `…/sites-available/cezar` | `/etc/cezar/htpasswd` | `cezar.service` | `4321` |
| `--domain shop.example.com` | `~/.cezar/server-instances/shop-example-com.json` | `…/cezar-shop-example-com` | `/etc/cezar/htpasswd-shop-example-com` | `cezar-shop-example-com.service` | auto (next free, e.g. `4322`) |

- **Port** — a new instance auto-picks the next free loopback port (`4321`,
  `4322`, …). Override with `--port <n>`. Each cockpit still serves loopback-only;
  nginx is the single public surface for all of them.
- **Login** — with cezar's own sign-in, the cockpits on one host share their
  **accounts** (`~/.cezar/auth.json` belongs to the OS user) and keep separate
  **sessions**: one account, signed in per domain. With Basic-Auth each instance
  has its own htpasswd, so every cockpit can have a different password.
- **Deploy / uninstall** — pass the same `--domain` to target that instance:

  ```bash
  npx cezar-run server-deploy    --platform ubuntu-vps --domain shop.example.com
  npx cezar-run server-uninstall --platform ubuntu-vps --domain shop.example.com
  ```

  A named-instance uninstall removes only that instance's owned artifacts and
  deletes its state file; the other cockpits and the shared nginx/certbot are
  left running. (Uninstalling the **default** instance does not remove a shared
  nginx that a named instance still needs — it lists it for manual removal.)

> Interactive installs help here too: if a cockpit already exists and you run
> `server-install` with no `--domain`, the wizard asks whether you want to set up
> a **second instance for a new domain** or manage the existing one — so the
> common "it just asks me to reinstall" case now has an obvious path forward.

---

## Previewing a task's app (the preview gateway)

On a hosted cockpit the workspace's Browser column cannot frame `http://localhost:3000`: in your
browser that address is your own computer, not the VPS. The **preview gateway** closes the gap.
You name a pool of ports; when you open a local address in the Browser column, cezar re-serves
that app on one of them and frames it. It is off until you set it up — the installer does not do
this for you.

Three things have to agree: cezar's pool, the front that forwards it, and the firewall.

**1. Give cezar a pool.** Add to the service's environment (`systemctl edit cezar`, then
`systemctl restart cezar`):

```ini
[Service]
Environment=CEZ_PREVIEW_PORTS=18500-18519
Environment=CEZ_PREVIEW_PUBLIC_PORTS=8500-8519
```

cezar listens on `127.0.0.1:18500…18519`; browsers reach them as `:8500…8519`. The two ranges
differ because nginx, on the same host, cannot bind a port cezar already holds.

**2. Forward the ports from nginx**, with the cockpit's own certificate and **without**
`auth_basic` — the gateway authenticates every request itself, and a second login prompt inside
a frame would never be answered:

```nginx
map $server_port $cez_preview_upstream { ~^(\d+)$ 1$1; }   # 8500 -> 18500

server {
    listen 8500-8519 ssl;                  # a port range needs nginx 1.15.10 or newer
    server_name cezar.example.com;
    ssl_certificate     /etc/letsencrypt/live/cezar.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cezar.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:$cez_preview_upstream;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;       # hot reload is a WebSocket
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }
}
```

**3. Open the ports**: `ufw allow 8500:8519/tcp`, and the same range in any cloud firewall.

What to expect:

- A preview is opened with a one-time ticket only the logged-in cockpit can obtain, exchanged
  for a cookie scoped to that one port. A request with neither gets `401` and never reaches the
  app.
- Each previewed app has its own port, so its own origin. It cannot read the cockpit, and the
  cockpit's API refuses its requests like any other foreign origin's.
- The app's own absolute addresses are not rewritten. A storefront configured to call its API at
  `http://localhost:9000` will make that call from your browser, to your machine. Open the API in
  a second Browser tab to learn its gateway address, and point the app at that.
- Design Mode stays local-only.

> This wiring is documented from the gateway's behaviour, which is covered by the test suite. The
> nginx block above has not been exercised on a live VPS yet — treat a first setup as a trial and
> check `nginx -t` before reloading.

---

## Uninstall

```bash
node packages/cezar/dist/index.js server-uninstall --platform ubuntu-vps
```

Removes what cezar **owns**: the nginx vhost, htpasswd, systemd unit, and boot
linger (when this install enabled it); the distro's default nginx site is
re-enabled if the install disabled it. Shared tools it merely *lists* for you
to remove by hand (agent CLIs, `gh`, and — when this install added them —
`nginx` and `certbot` packages, plus the TLS certificate: pulling a cert can
break other vhosts).

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `502 Bad Gateway` | cezar isn't running. `systemctl status cezar` / `journalctl -u cezar -n 50`. |
| `status=203/EXEC — Unable to locate executable` | An old unit with a bare `ExecStart`. Re-run `--reconfigure autostart`; the unit now uses an absolute `<node> <entry>`. |
| "no gh / claude installed" but you have them | Launched from a non-login shell without `~/.local/bin`/nvm on PATH. The current installer merges your login-shell PATH; update and re-run. |
| certbot "verification failed" but it succeeded | Fixed — verification now reads the world-readable nginx vhost, not root-only `/etc/letsencrypt/live`. |
| Cockpit unreachable, nginx fine | Ports 80/443 blocked. Check `ufw status` **and** any cloud firewall (Hetzner/AWS security groups). |
| Cockpit loads, but every action fails with `403 forbidden: cross-origin request rejected` | You reach nginx through a forwarded port (a VM, NAT, `box:8080` to `:80`) and the vhost forwards `Host $host`, which drops that port. Fixed for new installs; `server-deploy` leaves an existing vhost as it is, so edit it once: `sudo sed -i 's/proxy_set_header Host \$host;/proxy_set_header Host $http_host;/' /etc/nginx/sites-available/cezar*`, then `sudo nginx -t && sudo systemctl reload nginx`. This one-line migration is the exception to the vhost's "do not edit by hand" header: `--reconfigure nginx-proxy` would regenerate the line too, but it rewrites the whole vhost (dropping certbot's TLS edits) and asks for a new cockpit password. |
| nginx won't start: `Address already in use` | Another proxy (Dokploy/Coolify → Traefik, Caddy) owns :80/:443. Re-run with `--external-proxy` (see above). `sudo ss -ltnp \| grep -E ':80\|:443'` shows who holds them. |
| `run server-install as a normal sudo-capable user, not root` | You're `root`. `adduser cezar && usermod -aG sudo cezar`, `su - cezar`, log your agent CLI in **as that user**, then re-run. |
| External-proxy install: proxy returns 502 | Traefik runs in a container and can't reach `127.0.0.1`. Reinstall with `--bind-host 172.17.0.1` (or your `docker0` address). |
| `server-deploy` fails with `Failed to connect to bus: No medium found` | `systemctl --user` has no D-Bus session — the deploy ran through `sudo -u <user>`, cron or an SSH root script, which give no login session. Use `sudo -i -u <user> …` (or `machinectl shell <user>@`), or export `XDG_RUNTIME_DIR=/run/user/$(id -u <user>)` and `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` first. Until #912 this was only a warning and the deploy still reported success. |
| `cezar.service did not actually restart — PID … is still serving` | The restart command returned but the process never changed, so the cockpit is still on the old code. `systemctl --user status cezar` / `journalctl --user -u cezar -n 50` shows why; restart it by hand to see the real error. |
| `cezar on 127.0.0.1:<port> is not enforcing its own sign-in` | The installer refused to remove nginx's login because the running service answered an anonymous request. The site was not changed. Usually an `Environment=CEZ_AUTH=0` left in the unit by hand, or a service that failed to restart: `systemctl --user status cezar`, fix, re-run. |
| `The new site is not in place … nginx -t rejected it` | nginx refused the generated site (its own error is printed above — often another site on the box using the same names). The previous site was put back and is still serving. |
| Cockpit stuck on an old version after `server-deploy` | npx-based unit whose cache wasn't refreshed (fixed in #696 — `server-deploy` now clears it). Manual: `rm -rf ~/.npm/_npx` as the service user, then `sudo systemctl restart cezar-<instance>`. |

← Back to [Remote access overview](./README.md)
