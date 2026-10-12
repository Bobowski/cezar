import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHostKey } from '../../auth/host-key.ts';
import { issueSetupCode } from '../../auth/store.ts';
import { CANCEL, PreflightError, type InstallContext, type InstallStep, type PlatformStrategy, type StepArtifact } from '../types.ts';
import {
  depCheckStep,
  generatePassword,
  owned,
  shared,
  shquote,
  StepAborted,
  StepCancelled,
  StepSkipped,
  sudoStep,
  verifyCommand,
  type VerifyFailure,
} from '../steps.ts';

/**
 * The `ubuntu-vps` strategy: stand up an authenticated, proxied cezar on a bare
 * Ubuntu/Debian VPS. cezar itself stays loopback-bound; nginx is the single
 * public surface (TLS + htpasswd identity) forwarding to 127.0.0.1:<port>.
 *
 * Phase 1 ships deps → nginx+htpasswd → identity-verify (and their `undo`s).
 * Phase 2 appends the optional SSL and autostart steps to `steps()`.
 */

/**
 * Instance-scoped artifact paths. The `default` instance (a host with no
 * `--domain`, i.e. every pre-multi-instance install) keeps the original,
 * un-suffixed names so it upgrades in place; a named (domain-keyed) instance
 * suffixes the nginx site, htpasswd, and systemd unit with its slug so several
 * cockpits coexist on one host without colliding. `undefined`/`'default'` both
 * resolve to the legacy names.
 */
function inst(ctx: InstallContext): string {
  return ctx.instance && ctx.instance !== 'default' ? ctx.instance : 'default';
}
function vhostAvailable(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? '/etc/nginx/sites-available/cezar' : `/etc/nginx/sites-available/cezar-${i}`;
}
function vhostEnabled(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? '/etc/nginx/sites-enabled/cezar' : `/etc/nginx/sites-enabled/cezar-${i}`;
}
function htpasswdPath(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? '/etc/cezar/htpasswd' : `/etc/cezar/htpasswd-${i}`;
}
function unitName(ctx: InstallContext): string {
  const i = inst(ctx);
  return i === 'default' ? 'cezar.service' : `cezar-${i}.service`;
}

/** Best-effort current OS username, suggested as the default cockpit login. */
function currentUsername(): string {
  try {
    return userInfo().username || 'ops';
  } catch {
    return 'ops';
  }
}

/**
 * True when ufw is installed and enabled. `ufw status` needs root and the
 * installer is mandatorily non-root, so it always failed — instead read
 * `/etc/ufw/ufw.conf` (world-readable), whose `ENABLED=yes` is the same truth
 * `ufw enable` maintains.
 */
async function ufwIsActive(ctx: InstallContext): Promise<boolean> {
  const r = await ctx.runner.capture('sh', [
    '-c',
    'grep -qi "^ENABLED=yes" /etc/ufw/ufw.conf 2>/dev/null && echo ufw-enabled || true',
  ]);
  return r.stdout.includes('ufw-enabled');
}

/** The HTTP status curl saw for a request ("000" = could not connect / no response). */
async function curlCode(ctx: InstallContext, args: string[], opts?: { input?: string }): Promise<string> {
  const r = await ctx.runner.capture('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...args], opts);
  return r.stdout.trim() || '000';
}

/** Capture an HTTP response body and status without putting credentials in argv. */
async function curlResponse(ctx: InstallContext, args: string[], opts?: { input?: string }): Promise<{ code: string; body: string }> {
  const r = await ctx.runner.capture('curl', ['-s', ...args, '-w', '\n%{http_code}'], opts);
  const lines = r.stdout.split('\n');
  const code = lines.pop()?.trim() || '000';
  return { code, body: lines.join('\n') };
}

/**
 * Name of the process listening on `port`, or null when nothing is. Best effort
 * (`ss` output varies, and without root the process name may be hidden) — used
 * only to make a port collision explainable, never to gate the install.
 */
export async function portListener(ctx: InstallContext, port: number): Promise<string | null> {
  if (ctx.dryRun) return null;
  const r = await ctx.runner.capture('ss', ['-ltnp', `( sport = :${port} )`]);
  if (r.code !== 0) return null;
  const line = r.stdout.split('\n').find((l) => /LISTEN/.test(l));
  if (!line) return null;
  // `users:(("docker-proxy",pid=123,fd=4))` → docker-proxy; unnamed → "another process".
  return /users:\(\("([^"]+)"/.exec(line)?.[1] ?? 'another process';
}

/** The interface the cockpit listens on — loopback unless an external-proxy
 *  install bound it somewhere the proxy can reach (e.g. the docker bridge). */
export function upstreamHost(ctx: InstallContext): string {
  return ctx.state.bindHost?.trim() || '127.0.0.1';
}

/** True once cezar answers on <host>:<port> (any HTTP status = the process is up). */
async function isCezarUp(ctx: InstallContext, port: number): Promise<boolean> {
  const code = await curlCode(ctx, [`http://${upstreamHost(ctx)}:${port}/`]);
  return code !== '000';
}

/** Poll the upstream until cezar responds or the attempts run out. */
async function waitForCezar(ctx: InstallContext, port: number, attempts = 15): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isCezarUp(ctx, port)) return true;
    // `sleep 1` via the runner keeps this testable (no real timers in unit tests).
    if (i < attempts - 1) await ctx.runner.capture('sh', ['-c', 'sleep 1']);
  }
  return false;
}

/**
 * After a service is enabled, wait for cezar to actually answer on the loopback
 * port. A running unit that crash-loops (bad WorkingDirectory, missing build)
 * would otherwise leave nginx proxying to nothing (502) while the installer
 * claims success. On failure, point the operator at the service logs.
 */
async function confirmCezarRunning(ctx: InstallContext, statusCmd: string, logsCmd: string): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would wait for cezar on ${upstreamHost(ctx)}:${ctx.state.primaryPort}.`);
    return;
  }
  const sp = ctx.ui.spinner();
  sp.start(`Waiting for cezar to start on 127.0.0.1:${ctx.state.primaryPort}…`);
  const up = await waitForCezar(ctx, ctx.state.primaryPort);
  sp.stop(up ? 'cezar is running.' : 'cezar did not come up.');
  if (!up) {
    ctx.ui.warn(
      `cezar is not answering on 127.0.0.1:${ctx.state.primaryPort} yet — nginx will return 502 until it is.\n` +
        `Check the service:\n  • ${statusCmd}\n  • ${logsCmd}\n` +
        'Common causes: the WorkingDirectory has no built cezar, or the port is wrong.',
    );
  }
}

/**
 * The first nginx that has a standalone `http2` directive. Before it, HTTP/2 is
 * a `listen` parameter and `http2 on;` is not ignored — it is a hard parse
 * error (`unknown directive "http2"`), so it takes `nginx -t`, and with it the
 * whole certbot step, down (#910).
 */
export const HTTP2_DIRECTIVE_MIN_NGINX = [1, 25, 1] as const;

/**
 * The `x.y.z` in `nginx -v`'s `nginx version: nginx/1.24.0 (Ubuntu)` banner, or
 * null when the output does not carry one (nginx absent, dry run, a build that
 * prints something else entirely).
 */
export function parseNginxVersion(output: string): string | null {
  const m = /nginx\/(\d+\.\d+\.\d+)/.exec(output);
  return m?.[1] ?? null;
}

/**
 * True when this nginx understands the standalone `http2 on;` directive. An
 * unknown or unparseable version answers false: the `listen … http2` parameter
 * every nginx since 1.9.5 accepts is the safe fallback, and being wrong there
 * costs a deprecation warning rather than a config that will not load.
 */
export function supportsHttp2Directive(version: string | null | undefined): boolean {
  if (!version) return false;
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.some((n) => !Number.isInteger(n))) return false;
  for (const [i, floor] of HTTP2_DIRECTIVE_MIN_NGINX.entries()) {
    const got = parts[i] ?? 0;
    if (got !== floor) return got > floor;
  }
  return true;
}

/**
 * The installed nginx's version, or null when it cannot be read. `nginx -v`
 * prints its banner on STDERR, so both streams are searched.
 *
 * Deliberately NOT gated on `ctx.dryRun` like this file's other probes: it is
 * read-only (no sudo, no package install, no network), and running it makes a
 * dry run on a host that already has nginx preview the exact vhost a real run
 * would write. With no nginx the runner resolves 127 rather than throwing, so
 * the preview falls back to the conservative syntax.
 */
export async function detectNginxVersion(ctx: InstallContext): Promise<string | null> {
  const r = await ctx.runner.capture('nginx', ['-v']);
  return parseNginxVersion(`${r.stderr}\n${r.stdout}`);
}

/**
 * Append the `http2` parameter to certbot's TLS listener — the only way to turn
 * HTTP/2 on before nginx 1.25.1. Touches `listen` lines that name 443 and `ssl`
 * and do not already say `http2`, inserting before the first `;` so certbot's
 * trailing `# managed by Certbot` comment survives; the `:80` redirect block
 * certbot adds has no 443 listener and is left alone. Idempotent, so a
 * `--reconfigure ssl` re-run is a no-op.
 */
export function enableHttp2OnTlsListenerSed(vhostPath: string): string {
  const program = `/^[[:space:]]*listen[[:space:]].*443.*[[:space:]]ssl([[:space:]]|;)/{/http2/!s/;/ http2;/;}`;
  return `sed -i -E ${shquote(program)} ${vhostPath}`;
}

/**
 * Who is serving right now: the unit's main PID plus the monotonic timestamp
 * systemd recorded when it started. Two reads that agree on BOTH mean the same
 * process has been running the whole time — i.e. nothing restarted (#912).
 */
type ServiceIdentity = { mainPid: string; startedAt: string };

/**
 * Read the running process's identity, or `null` when it cannot be established:
 * the query failed (no user bus, unknown unit) or the unit is not running
 * (`MainPID=0`), leaving no "old process" to compare against. Callers degrade on
 * `null` rather than inventing a failure. Read-only, so — like `readExecStart` —
 * it needs no sudo even for a system unit.
 */
async function readServiceIdentity(
  ctx: InstallContext,
  scope: 'user' | 'system',
  unit: string,
): Promise<ServiceIdentity | null> {
  const args = [
    ...(scope === 'user' ? ['--user'] : []),
    'show',
    unit,
    '-p',
    'MainPID',
    '-p',
    'ExecMainStartTimestampMonotonic',
  ];
  const { code, stdout } = await ctx.runner.capture('systemctl', args);
  if (code !== 0) return null;
  const mainPid = /^MainPID=(\d+)$/m.exec(stdout)?.[1];
  const startedAt = /^ExecMainStartTimestampMonotonic=(\d+)$/m.exec(stdout)?.[1];
  if (!mainPid || mainPid === '0' || !startedAt || startedAt === '0') return null;
  return { mainPid, startedAt };
}

/** A failed command's own output, indented under our message (empty when it was silent). */
function outputTail(r: { stdout: string; stderr: string }): string {
  const text = `${r.stderr}\n${r.stdout}`.trim();
  return text
    ? `\n${text
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')}`
    : '';
}

/**
 * `systemctl --user` needs a D-Bus user session. `sudo -u <service-user>` from
 * cron, a CI runner or an SSH command run as root gives none, and every call then
 * fails with "Failed to connect to bus: No medium found" — the trap behind #912,
 * and exactly the unattended flow where the exit code is the only signal anyone
 * reads. Name it, and say how to get a real session.
 */
function noDbusSessionHint(scope: 'user' | 'system', output: string): string | null {
  if (scope !== 'user') return null;
  const busError = /Failed to connect to bus|No medium found|DBUS_SESSION_BUS_ADDRESS/i.test(output);
  if (!busError && process.env.XDG_RUNTIME_DIR) return null;
  const user = currentUsername();
  return (
    `No D-Bus user session${busError ? '' : ' (XDG_RUNTIME_DIR is not set)'} — \`systemctl --user\` cannot reach ` +
    `the user manager, so nothing was restarted.\n` +
    `Running this through \`sudo -u ${user}\`, cron or an SSH root script? Those have no login session. Use either:\n` +
    `  • sudo -i -u ${user} …   (or: machinectl shell ${user}@)\n` +
    `  • sudo -u ${user} env XDG_RUNTIME_DIR=/run/user/$(id -u ${user}) ` +
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u ${user})/bus …`
  );
}

/**
 * Prove the restart actually replaced the process. `confirmCezarRunning` only
 * proves that SOMETHING answers the port, and the un-restarted old process
 * answers it just as well — which is how a deploy that did nothing reported
 * "reloaded and verified" (#912). When both reads are available and identical,
 * the deploy was a no-op: fail it.
 */
async function confirmServiceRestarted(
  ctx: InstallContext,
  scope: 'user' | 'system',
  unit: string,
  before: ServiceIdentity | null,
): Promise<void> {
  if (before === null) return; // nothing to compare against — never invent a failure
  const after = await readServiceIdentity(ctx, scope, unit);
  if (after === null) {
    ctx.ui.warn(`Could not read ${unit}'s main PID after the restart — skipping the did-it-really-restart check.`);
    return;
  }
  if (after.mainPid === before.mainPid && after.startedAt === before.startedAt) {
    const status = `systemctl${scope === 'user' ? ' --user' : ''} status ${unit}`;
    throw new StepAborted(
      `${unit} did not actually restart — PID ${after.mainPid} has been serving since before this restart, so the ` +
        `cockpit is still the OLD process and nothing was applied.\n` +
        `Check \`${status}\`, then restart it by hand to see the real error.`,
    );
  }
  ctx.ui.success(`Service restarted (PID ${before.mainPid} → ${after.mainPid}).`);
}

/** Mirrors `GLOBAL_BODY_LIMIT` in `server/server.ts`; `ubuntu-vps-site.test.ts` pins the two together. */
const NGINX_BODY_LIMIT = '32m';

/** What certbot added to a site: its lines inside our server block, and the blocks it appended. */
export interface CertbotEdits {
  tls: string[];
  trailer: string;
}

const CERTBOT_LINE = /^\s*(listen\s[^;#]*\b443\b|ssl_[a-z_]+\s|include\s+\/etc\/letsencrypt\/)/;

/**
 * Read certbot's edits back out of a site so a re-render can carry them: the TLS listener and
 * certificate lines of the first `server` block, plus everything after it (the `:80` redirect).
 * `null` when the site has no certificate — there is nothing to keep.
 */
export function certbotEdits(site: string): CertbotEdits | null {
  const lines = site.split('\n');
  const start = lines.findIndex((l) => /^\s*server\s*\{/.test(l));
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    const code = (lines[i] ?? '').replace(/#.*$/, '');
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const tls = lines.slice(start + 1, end).filter((l) => CERTBOT_LINE.test(l));
  if (!tls.some((l) => /^\s*ssl_certificate\s/.test(l)) || !tls.some((l) => /^\s*listen\s/.test(l))) return null;
  return { tls, trailer: lines.slice(end + 1).join('\n').trim() };
}

/**
 * The nginx site: TLS front + SSE- and WebSocket-safe proxy to loopback.
 *
 * `htpasswd` is the Basic-Auth file, or `null` when cezar signs users in itself (spec
 * 2026-10-12-cockpit-authentication §7) — then nginx authenticates nobody and only rate-limits
 * the sign-in routes. `instance` keeps the two http-level names unique when several cockpits
 * share one nginx.
 * `serverName` defaults to the catch-all `_`; the SSL step rewrites it to the
 * real domain so the `certbot --nginx` plugin can find this vhost to edit.
 *
 * `nginxVersion` is the installed nginx (`detectNginxVersion`) and decides how
 * HTTP/2 is spelled; omitted, the output is the conservative one every nginx
 * parses.
 *
 * `certbot` is what certbot added to the site being replaced (`certbotEdits`): its lines take
 * the place of the plain `:80` listener (kept when certbot left no `:80` block of its own), so a
 * re-render never takes working HTTPS down.
 */
export function nginxVhost(
  port: number,
  serverName = '_',
  htpasswd: string | null = '/etc/cezar/htpasswd',
  nginxVersion?: string | null,
  instance = 'default',
  certbot?: CertbotEdits | null,
): string {
  // nginx variable and zone names: letters, digits, underscore.
  const id = instance.replace(/[^a-z0-9]+/gi, '_');
  // HTTP/2 multiplexes every request over ONE TCP connection. Without it the
  // browser's ~6-connections-per-origin HTTP/1.1 cap is exhausted by cezar's
  // long-lived SSE run streams, and further requests block until tabs close.
  //
  // How it is switched on depends on the version. From 1.25.1 the standalone
  // directive below is the right spelling and survives certbot's edits. Older
  // nginx — Ubuntu 24.04 LTS still ships 1.24.0 — has no such directive at all
  // and refuses to load a config containing it (#910); there, the SSL step
  // appends `http2` to certbot's `listen 443 ssl;` instead, so this block emits
  // nothing. Either way HTTP/2 only ever applies to the TLS listener: a plain
  // `:80` HTTP/2 needs a prior-knowledge client no browser is.
  const http2Block = supportsHttp2Directive(nginxVersion)
    ? '\n    # HTTP/2 for the SSE run streams: without it the browser\'s ~6-connections-\n' +
      '    # per-origin HTTP/1.1 cap is exhausted and further requests block. Takes\n' +
      '    # effect once the SSL step adds a 443 ssl listener (certbot preserves the\n' +
      '    # directive). nginx >= 1.25.1 only — older nginx rejects it outright.\n' +
      '    http2 on;\n'
    : '';
  const signInZone = `cez_signin_${id}`;
  const authBlock = htpasswd === null
    ? ''
    : `\n    auth_basic "cezar";\n    auth_basic_user_file ${htpasswd};\n`;
  const signInLimit = htpasswd === null
    ? `
    # Sign-in and setup are the only writes an anonymous caller can make. cezar backs off per
    # account and per address itself; this caps the rate before a request gets that far.
    location ~ ^/api/v1/auth/(login|setup) {
        limit_req zone=${signInZone} burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:${port};
    }
`
    : '';
  const plain = '    listen 80;\n    listen [::]:80;';
  // certbot without the redirect split leaves no :80 block behind — ours must keep answering there.
  const redirected = /^\s*listen\s[^;#]*\b80\b/m.test(certbot?.trailer ?? '');
  const listeners = certbot ? `${redirected ? '' : `${plain}\n`}${certbot.tls.join('\n')}` : plain;
  // certbot's own :80 block follows the domain, as its `server_name` always did on an SSL re-run.
  const trailer = certbot?.trailer
    ? `\n${certbot.trailer
        .replace(/^(\s*server_name)\s[^;]*;/gm, `$1 ${serverName};`)
        .replace(/(\$host\s*=\s*)[^\s)]+/g, `$1${serverName}`)}\n`
    : '';
  return `# Managed by cezar server-install — do not edit by hand.

# A WebSocket handshake (/api/v1/ws) is passed through as an upgrade. Every other request keeps
# the empty Connection header cezar's SSE streams rely on for upstream keep-alive.
map $http_upgrade $cez_connection_${id} {
    default upgrade;
    ''      '';
}
${htpasswd === null ? `limit_req_zone $binary_remote_addr zone=${signInZone}:1m rate=20r/m;\n` : ''}
server {
${listeners}
    server_name ${serverName};
${http2Block}${authBlock}
    # cezar accepts bodies up to GLOBAL_BODY_LIMIT (32 MiB, server/server.ts) — pasted images.
    # nginx's 1 MB default would answer 413 before cezar saw the request.
    client_max_body_size ${NGINX_BODY_LIMIT};

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $cez_connection_${id};

    # cezar streams SSE (run events). Never buffer it, or the cockpit goes mute.
    proxy_buffering off;
    proxy_read_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:${port};
    }
${signInLimit}}
${trailer}`;
}

/** Build a privileged command that writes file content atomically (base64 → no quoting hell). */
function writeRootFileCmd(path: string, content: string, extra = ''): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  return `install -d -m 0755 ${shquote(dir)} && printf %s ${shquote(b64)} | base64 --decode > ${shquote(path)}${extra ? ` && ${extra}` : ''}`;
}

/**
 * A sudoStep that writes a root-owned file. The command carries the content as
 * base64 (so quoting/newlines survive a copy-paste), which is unreadable — so we
 * always show the DECODED file content in a note first, so the operator can see
 * exactly what will land on disk and knows the base64 is not doing anything
 * hidden.
 */
function writeFileStep(
  ctx: InstallContext,
  opts: {
    description: string;
    path: string;
    content: string;
    /** Extra shell appended after the write (` && …`). */
    extra?: string;
    verify: (c: InstallContext) => Promise<boolean>;
  },
): Promise<void> {
  return sudoStep(ctx, {
    description: opts.description,
    note: `This writes ${opts.path} with exactly this content:\n\n${opts.content}`,
    command: writeRootFileCmd(opts.path, opts.content, opts.extra),
    verify: opts.verify,
  });
}

/** A world-readable root-owned file's content, or null when it is absent or unreadable. */
async function readHostFile(ctx: InstallContext, path: string): Promise<string | null> {
  const r = await ctx.runner.capture('cat', [path]);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Install a site all-or-nothing: the new file is kept only when `nginx -t` accepts it. A rejected
 * one is replaced by what was there before (or removed), so a broken file is never left enabled
 * for the next nginx restart to trip over. The distro default goes only after the test passed.
 * The mode is set explicitly: root's umask may be 027/077, and the installer reads the file back.
 */
export function installSiteCmd(avail: string, enabled: string, content: string, dropDefault = false): string {
  const bak = `${avail}.cezar-bak`;
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const apply =
    `printf %s ${shquote(b64)} | base64 --decode > ${shquote(avail)} && chmod 0644 ${shquote(avail)} && ` +
    `ln -sf ${avail} ${enabled} && nginx -t` +
    `${dropDefault ? ' && rm -f /etc/nginx/sites-enabled/default' : ''} && systemctl reload nginx`;
  const restore =
    `if [ -e ${bak} ]; then mv -f ${bak} ${avail}; else rm -f ${avail}; fi; [ "$L" = 1 ] || rm -f ${enabled}; ` +
    `echo 'cezar: the new nginx site was not applied - the previous one was put back' >&2; exit 1`;
  return (
    `install -d -m 0755 /etc/nginx/sites-available && L=0 && { [ -L ${enabled} ] && L=1; ` +
    `if [ -e ${avail} ]; then cp -p ${avail} ${bak}; else rm -f ${bak}; fi; } && ` +
    `if ${apply}; then rm -f ${bak}; else ${restore}; fi`
  );
}

/** The loopback status of an anonymous `GET /api/v1/health`: 401 is cezar's sign-in answering. */
async function anonymousHealthCode(ctx: InstallContext): Promise<string> {
  return curlCode(ctx, [`http://${upstreamHost(ctx)}:${ctx.state.primaryPort}/api/v1/health`]);
}

/**
 * The gate in front of every site without `auth_basic`: the RUNNING service must already answer
 * an anonymous request with 401. If it does not, the unit is brought in line and restarted first;
 * if it still does not, this throws and the site is left exactly as it was — nginx never proxies
 * the internet to a cezar with sign-in off (spec 2026-10-12-cockpit-authentication §9a).
 */
async function requireSignInEnforced(ctx: InstallContext, existingSite: string | null): Promise<void> {
  if (ctx.dryRun) {
    ctx.ui.info("DRY RUN — would confirm the service answers 401 to an anonymous request before nginx stops asking for a login.");
    return;
  }
  let code = await anonymousHealthCode(ctx);
  let why = '';
  if (code !== '401') {
    ctx.ui.info(
      code === '000'
        ? "cezar is not running yet — starting the service first, so nginx only ever fronts a cockpit that asks for sign-in."
        : `The running cezar does not enforce its own sign-in yet (anonymous /api/v1/health answered "${code}") — updating and restarting the service before nginx stops asking for a login.`,
    );
    try {
      const svc = await applyServiceUnit(ctx, code === '000' ? 'if-changed' : 'always');
      // Recorded now so an uninstall after a failed run still finds the service.
      const rec = ctx.state.steps['autostart'];
      if (!rec?.created) {
        ctx.state.steps['autostart'] = { status: rec?.status ?? 'pending', created: { artifacts: [svc.artifact] } };
        await ctx.save();
      }
    } catch (err) {
      if (!(err instanceof StepAborted)) throw err;
      why = ` ${err.message}`;
    }
    // An npx-launched unit fetches the package on its first start — give it time.
    for (let i = 0; i < 30; i++) {
      code = await anonymousHealthCode(ctx);
      if (code === '401') break;
      if (i < 29) await ctx.runner.capture('sh', ['-c', 'sleep 1']);
    }
  }
  if (code === '401') return;
  const kept = existingSite?.includes('auth_basic')
    ? 'The nginx site was NOT changed: its Basic-Auth login is still in force.'
    : existingSite
      ? 'The nginx site was NOT changed.'
      : 'No nginx site was written.';
  const unit = unitName(ctx);
  throw new StepAborted(
    `cezar on ${upstreamHost(ctx)}:${ctx.state.primaryPort} is not enforcing its own sign-in — an anonymous /api/v1/health ` +
      `answered "${code}", not 401.${why}\n${kept}\n` +
      `Check \`systemctl --user status ${unit}\` (or: sudo systemctl status ${unit}) and that the unit has no ` +
      '`Environment=CEZ_AUTH=0`, then re-run.',
  );
}

/**
 * The ONE place the nginx site is rendered and written. Everything that decides its shape comes
 * from the recorded state — who signs in, the instance, the port — so no caller can write a site
 * for a different mode than the install is in (review finding: the SSL step used to).
 */
async function writeSite(
  ctx: InstallContext,
  opts: { description: string; serverName: string; dropDefault?: boolean },
): Promise<void> {
  const avail = vhostAvailable(ctx);
  const enabled = vhostEnabled(ctx);
  const htpasswd = ctx.state.signIn === 'cezar' ? null : htpasswdPath(ctx);
  const existing = ctx.dryRun ? null : await readHostFile(ctx, avail);
  if (htpasswd === null) await requireSignInEnforced(ctx, existing);
  const certbot = existing ? certbotEdits(existing) : null;
  if (existing?.includes('ssl_certificate') && !certbot) {
    throw new StepAborted(
      `${avail} has TLS configuration cezar cannot carry into a new file, so it was left as it is. ` +
        'Move the certificate lines back inside the first server block (or remove the file), then re-run.',
    );
  }
  const content = nginxVhost(
    ctx.state.primaryPort,
    opts.serverName,
    htpasswd,
    await detectNginxVersion(ctx),
    inst(ctx),
    certbot,
  );
  await sudoStep(ctx, {
    description: opts.description,
    note: `This writes ${avail} with exactly this content:\n\n${content}`,
    command: installSiteCmd(avail, enabled, content, opts.dropDefault),
    // The command puts the old file back when `nginx -t` rejects the new one, so "the new
    // content is on disk" is the proof — a symlink existing proved nothing.
    verify: async (c) =>
      (await c.runner.capture('cmp', ['-s', '-', avail], { input: content })).code === 0 &&
      (await nginxConfigTestFailure(c)) === undefined,
    verifyFailure: async (c) =>
      (await nginxConfigTestFailure(c)) ?? {
        retryable: true,
        message:
          `The new site is not in place: the command did not run, or nginx -t rejected it (its error is above) ` +
          `and the previous site was put back — nginx is still serving that one.`,
      },
  });
}

/**
 * Who signs users in (spec 2026-10-12-cockpit-authentication §7), asked once and remembered in
 * `server.json`. cezar's own sign-in is the default for a person at the keyboard; `--yes` keeps
 * the proxy doing it, because that mode also skips the SSL step and cezar's sign-in cannot work
 * over plain HTTP — the non-interactive install stays exactly what it was.
 */
async function chooseSignIn(ctx: InstallContext, proxyLabel: string): Promise<'cezar' | 'proxy'> {
  if (ctx.assumeYes) {
    ctx.state.signIn = ctx.state.signIn ?? 'proxy';
    return ctx.state.signIn;
  }
  const answer = await ctx.ui.select<'cezar' | 'proxy'>({
    message: 'How do people sign in to this cockpit?',
    options: [
      {
        value: 'cezar',
        label: "cezar's own sign-in (recommended)",
        hint: 'password + authenticator app, a session per device — needs a domain with HTTPS',
      },
      { value: 'proxy', label: proxyLabel, hint: 'one shared password, no second factor' },
    ],
    initialValue: ctx.state.signIn ?? 'cezar',
  });
  if (answer === CANCEL) throw new StepCancelled();
  ctx.state.signIn = answer;
  return answer;
}

const nginxProxyStep: InstallStep = {
  id: 'nginx-proxy',
  title: 'Reverse proxy (nginx)',
  async check(ctx) {
    if (ctx.dryRun) return false;
    const nginxOk = await verifyCommand(ctx, 'nginx', ['-v']);
    const vhostOk = await verifyCommand(ctx, 'test', ['-f', vhostEnabled(ctx)]);
    return nginxOk && vhostOk;
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // 1) nginx. Record the package as a `shared` artifact only when this run
    //    installed it, so uninstall can list it for manual removal without
    //    claiming a pre-existing nginx.
    const nginxWasPresent = await verifyCommand(ctx, 'nginx', ['-v']);
    await sudoStep(ctx, {
      description: 'Install nginx (the public TLS front for cezar).',
      command: 'apt-get update && apt-get install -y nginx',
      verify: (c) => verifyCommand(c, 'nginx', ['-v']),
    });

    // 2) who signs users in. With cezar's own sign-in nginx authenticates nobody: no htpasswd,
    //    no password to pick here — the account is created in the browser from the one-time
    //    link the last step prints.
    const signIn = await chooseSignIn(ctx, 'HTTP Basic-Auth in nginx (works without a domain)');
    let user = '';
    let htpasswd: string | null = null;
    if (signIn === 'proxy') {
      // 2) identity credentials. This is the HTTP Basic-Auth login nginx will
      //    challenge for over HTTPS — i.e. what you type in the browser to reach
      //    the cockpit. Suggest the current OS user as a sensible default.
      const suggestedUser = currentUsername();
      const userAnswer = await ctx.ui.text({
        message: 'Cockpit login username (HTTPS Basic-Auth — you type this in the browser to reach the cockpit)',
        placeholder: suggestedUser,
        initialValue: suggestedUser,
        // htpasswd's line format is `user:hash` — a ":" in the username would
        // silently corrupt it into a login that can never succeed.
        validate: (v) => {
          if (!v.trim()) return 'username is required';
          if (/[:\s]/.test(v.trim())) return 'no ":" or whitespace — htpasswd uses ":" as its separator';
          return undefined;
        },
      });
      if (userAnswer === CANCEL) throw new StepCancelled();
      user = String(userAnswer).trim();

      // Set the cockpit password. Interactive operators may auto-generate a strong
      // one (shown once) or type their own. Under `--yes` (no human) there is no
      // menu — the password comes straight from the UI, and the length backstop
      // below refuses an empty one rather than standing up an open cockpit (H1).
      let password: string;
      if (ctx.assumeYes) {
        const typed = await ctx.ui.password({
          message: `Set the HTTPS cockpit password for "${user}"`,
          validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
        });
        if (typed === CANCEL) throw new StepCancelled();
        password = String(typed);
      } else {
        const how = await ctx.ui.select<'generate' | 'manual'>({
          message: `Cockpit password for "${user}" (used with the username to log in over HTTPS)`,
          options: [
            { value: 'generate', label: 'Generate a strong password for me', hint: 'shown once — save it now' },
            { value: 'manual', label: 'Type my own password' },
          ],
          initialValue: 'generate',
        });
        if (how === CANCEL) throw new StepCancelled();
        if (how === 'generate') {
          password = generatePassword();
          ctx.ui.note(
            `Username: ${user}\nPassword: ${password}\n\nSave these now — this is your cockpit login. cezar stores only a hash; the plaintext is not written anywhere and cannot be recovered.`,
            'Generated cockpit credentials',
          );
        } else {
          const typed = await ctx.ui.password({
            message: `Set the HTTPS cockpit password for "${user}"`,
            validate: (v) => (v.length >= 6 ? undefined : 'use at least 6 characters'),
          });
          if (typed === CANCEL) throw new StepCancelled();
          password = String(typed);
        }
      }
      // The non-interactive UI (`--yes`) cannot invent a password and does not run
      // validators — refuse rather than write an empty-password htpasswd (a public
      // cockpit anyone can open). A real install must set a password interactively.
      if (!ctx.dryRun && String(password).length < 6) {
        throw new StepAborted('a cockpit password (≥6 chars) is required — run server-install without --yes to set one');
      }
      // Keep the credentials in memory (never persisted) so the final verify step
      // can prove an authenticated request actually reaches cezar over the proxy.
      ctx.prefs.cockpit = { user, password };

      // 3) htpasswd file. The hash (not the plaintext) is embedded in the write
      //    command; the plaintext is fed to openssl via stdin so it never appears
      //    in the process argv (visible to other users via `ps`). apr1 is what
      //    nginx's auth_basic expects.
      let hash = '<dry-run-hash>';
      if (!ctx.dryRun) {
        const out = await ctx.runner.capture('openssl', ['passwd', '-apr1', '-stdin'], { input: `${String(password)}\n` });
        hash = out.stdout.trim();
        if (out.code !== 0 || !hash) throw new StepAborted('failed to hash the password (openssl) — cannot write htpasswd');
      }
      // nginx workers run as www-data and read auth_basic_user_file per request,
      // so the file must be group-readable by www-data — 0640 root:root would make
      // every request 500. 0640 root:www-data: readable by nginx, not by others.
      // The credential line travels on STDIN (`cat > file`), never in argv — the
      // apr1 hash is offline-crackable, and argv is world-readable via `ps`.
      const file = htpasswdPath(ctx);
      htpasswd = file;
      await sudoStep(ctx, {
        description: 'Write the htpasswd identity file that nginx checks on every request.',
        note: `${file}\n\n${user}:<apr1 hash of your password>`,
        command: `install -d -m 0755 /etc/cezar && cat > ${file} && chown root:www-data ${file} && chmod 0640 ${file}`,
        input: `${user}:${hash}\n`,
        inputLabel: 'credential line (username:hash)',
        verify: (c) => verifyCommand(c, 'test', ['-f', file]),
      });
    }

    // Record whether the distro's default site was enabled *before* we disable
    // it, so undo only re-enables it if we were the one who removed it.
    const defaultWasEnabled = await verifyCommand(ctx, 'test', ['-L', '/etc/nginx/sites-enabled/default']);

    // 4) vhost + enable + reload. A named instance already knows its domain, so
    //    stamp it into server_name from the start (Host-based routing works
    //    immediately and certbot --nginx can find the vhost later). The default
    //    instance keeps the catch-all `_` until the SSL step sets a domain.
    //    The nginx just installed above decides how HTTP/2 is spelled, so read
    //    its version now — emitting the wrong spelling makes `nginx -t` in the
    //    very next command fail and takes the whole install down (#910).
    const vhostAvail = vhostAvailable(ctx);
    const vhostEnbl = vhostEnabled(ctx);
    await writeSite(ctx, {
      description: 'Write the cezar nginx site, enable it, and reload nginx.',
      serverName: ctx.state.domain ?? '_',
      dropDefault: true,
    });

    // 5) firewall: if ufw is active, the cockpit is unreachable until 80/443 are
    //    allowed — a common "installed fine but nothing loads" cause. This is a
    //    best-effort sub-step of the (required) proxy step: skipping it must not
    //    fail the whole install, so a StepSkipped is swallowed here.
    if (!ctx.dryRun && (await ufwIsActive(ctx))) {
      try {
        await sudoStep(ctx, {
          description: 'ufw is active — allow HTTP/HTTPS so the cockpit is reachable.',
          // Self-verifying: the trailing grep makes the (root) command itself
          // fail when the rule did not land — needed because rule listing also
          // requires root, so the unprivileged verify below can't always check.
          command: `ufw allow 'Nginx Full' && ufw status | grep -qi 'Nginx Full'`,
          skippable: true,
          skipHint: 'open ports 80 and 443 yourself, or via a cloud firewall',
          verify: async (c) => {
            if ((await c.runner.capture('sudo', ['-n', 'true'])).code === 0) {
              return (
                (await c.runner.capture('sudo', ['-n', 'bash', '-lc', "ufw status | grep -qi 'Nginx Full'"])).code === 0
              );
            }
            // No root and no human in the loop (`--yes`): nobody ran the
            // command, so it cannot have "verified itself" — fail, which the
            // skippable path converts into the loud firewall warning below.
            if (c.assumeYes) return false;
            // Interactive delegate: the operator confirmed running the
            // self-verifying command (the trailing grep fails their paste if
            // the rule is missing); we cannot re-check without root.
            c.ui.warn(
              'Cannot list ufw rules without root — trusting the self-verifying command you just ran. ' +
                'Double-check ports 80/443 are reachable.',
            );
            return true;
          },
        });
      } catch (err) {
        if (!(err instanceof StepSkipped)) throw err;
        ctx.ui.warn('Firewall left unchanged — make sure ports 80 and 443 are reachable, or the cockpit will not load.');
      }
    }

    const artifacts: StepArtifact[] = [
      owned('file', { path: vhostAvail }),
      owned('symlink', { path: vhostEnbl }),
    ];
    if (htpasswd !== null) artifacts.push(owned('htpasswd', { path: htpasswd, name: user }));
    if (defaultWasEnabled) artifacts.push(owned('nginx-default', { path: '/etc/nginx/sites-enabled/default' }));
    if (!nginxWasPresent) {
      artifacts.push(shared('package', { name: 'nginx', removeHint: 'sudo apt-get remove -y nginx' }));
    }
    return { artifacts };
  },
  async undo(ctx, created) {
    // Remove the *known* cezar-owned paths (constants), so uninstall works even
    // if server.json was lost and the step was re-recorded with created=null.
    // Only re-enable the default site if the run recorded that it disabled it.
    const restoreDefault = (created?.artifacts ?? []).some((a) => a.type === 'nginx-default');
    const restoreClause = restoreDefault
      ? ` && { [ -e /etc/nginx/sites-available/default ] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default || true; }`
      : '';
    // `shared` packages (nginx, when this install added it) are listed, never
    // auto-removed — the operator may have started depending on them.
    const sharedPkgs = (created?.artifacts ?? []).filter((a) => a.kind === 'shared');
    if (sharedPkgs.length > 0) {
      ctx.ui.note(
        sharedPkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'Installed for cezar but possibly used elsewhere — remove manually if unwanted',
      );
    }
    // rmdir /etc/cezar only succeeds when empty, so removing one instance's
    // htpasswd never nukes another instance's credentials in the same dir.
    const vhostEnbl = vhostEnabled(ctx);
    await sudoStep(ctx, {
      description: 'Remove the cezar nginx site + htpasswd, reload nginx.',
      command:
        `rm -f ${vhostEnbl} ${vhostAvailable(ctx)} ${htpasswdPath(ctx)}` +
        restoreClause +
        ` && { rmdir /etc/cezar 2>/dev/null || true; }` +
        ` && { nginx -t && systemctl reload nginx || true; }`,
      verify: (c) => verifyCommand(c, 'sh', ['-c', `! test -f ${vhostEnbl}`]),
    });
  },
};

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Certbot invokes nginx while editing the vhost. If the config cannot parse,
 * retrying certbot repeats the same deterministic failure; expose nginx's own
 * diagnostic instead of offering the generic retry/skip choice.
 */
export async function nginxConfigTestFailure(ctx: InstallContext): Promise<VerifyFailure | undefined> {
  const result = await ctx.runner.capture('nginx', ['-t']);
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  // `nginx -t` also reports operational failures (for example, an unprivileged
  // probe cannot open a root-only certificate or log). Only classify explicit
  // syntax/configuration diagnostics as terminal; certbot and other transient
  // failures must keep the normal retry/skip path.
  const parseFailure =
    /unknown directive|unexpected (?:end|\S+)|directive .*not allowed|invalid (?:number of arguments|parameter)|duplicate /i.test(
      output,
    );
  if (result.code === 0 || !output || result.code === 127 || /command not found/i.test(output) || !parseFailure) {
    return undefined;
  }
  return {
    retryable: false,
    message:
      'nginx configuration test failed; fix the generated configuration before rerunning this step.\n' + output,
  };
}

const sslStep: InstallStep = {
  id: 'ssl',
  title: 'Domain + SSL (Let’s Encrypt)',
  // cezar's own sign-in refuses to set a session cookie over plain HTTP, so with it this step is
  // not a nicety — skipping it would leave a cockpit nobody can sign in to.
  optional: (ctx) => ctx.state.signIn !== 'cezar',
  async check() {
    return false; // optional — the engine gates it with a confirm; certbot is idempotent
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // A named instance already captured its domain up front (it is the instance
    // key) — reuse it instead of asking again. The default instance still
    // prompts here, since it may be HTTP-only until this step runs.
    const domain = ctx.state.domain
      ? ctx.state.domain
      : await ctx.ui.text({
          message: 'Domain pointing at this server (an A/AAAA record must resolve here)',
          placeholder: 'cezar.example.com',
          validate: (v) => (HOSTNAME_RE.test(v.trim()) ? undefined : 'enter a valid domain'),
        });
    if (domain === CANCEL) throw new StepCancelled();
    const email = await ctx.ui.text({
      message: 'Email for Let’s Encrypt renewal notices',
      placeholder: 'you@example.com',
      validate: (v) => (EMAIL_RE.test(v.trim()) ? undefined : 'enter a valid email'),
    });
    if (email === CANCEL) throw new StepCancelled();

    const certbotWasPresent = await verifyCommand(ctx, 'certbot', ['--version']);
    await sudoStep(ctx, {
      description: 'Install certbot + its nginx plugin.',
      command: 'apt-get install -y certbot python3-certbot-nginx',
      verify: (c) => verifyCommand(c, 'certbot', ['--version']),
    });

    // Point the nginx site's server_name at the domain BEFORE running certbot.
    // The `certbot --nginx` plugin locates the vhost by matching `server_name`
    // against `-d <domain>`; with the catch-all `server_name _;` it fails with
    // "Unable to find a VirtualHost". Doing this first also means that if the
    // operator skips certbot now, a later manual `certbot --nginx -d <domain>`
    // just works — no "could not find a matching server" (issue #8).
    //
    // On a RE-RUN (--reconfigure ssl / --reinstall / resume) the vhost may
    // already carry certbot's TLS edits (`listen 443 ssl`, `ssl_certificate`).
    // `writeSite` carries them into the new file, so working HTTPS never goes
    // down BEFORE certbot runs again — or stays down if certbot then fails.
    const trimmedDomain = String(domain).trim();
    // Record the domain on the instance record so a resume / redeploy / verify
    // (and the nginx server_name) all agree on it, even for the default instance
    // that entered its domain here rather than up front.
    ctx.state.domain = trimmedDomain;
    const vhostAvail = vhostAvailable(ctx);
    const vhostEnbl = vhostEnabled(ctx);
    const nginxVersion = await detectNginxVersion(ctx);
    await writeSite(ctx, {
      description: `Point the nginx site at ${trimmedDomain} so certbot can configure TLS for it.`,
      serverName: trimmedDomain,
    });

    // certbot can legitimately fail on external state (DNS not pointed yet, LE
    // rate limit). Route it through sudoStep so it honors the sudo/delegate
    // choice (issue #7) and offers Skip on repeated failure (issue #8) — on
    // skip, nginx is already configured for a later manual certbot run.
    await sudoStep(ctx, {
      description: `Obtain and install a Let’s Encrypt certificate for ${String(domain).trim()} (adds HTTPS + redirect).`,
      command: `certbot --nginx -d ${shquote(String(domain).trim())} --non-interactive --agree-tos -m ${shquote(String(email).trim())} --redirect`,
      skippable: true,
      skipHint: `run later: sudo certbot --nginx -d ${String(domain).trim()}`,
      // Verify via the nginx vhost, NOT /etc/letsencrypt/live — that dir is 0700
      // root, so a non-root `test -d` (the operator ran certbot themselves) fails
      // with permission-denied and reports a false failure even when the cert was
      // issued. certbot --nginx writes `ssl_certificate …` into the vhost, which
      // is world-readable, so grepping it works without root.
      verify: (c) => verifyCommand(c, 'sh', ['-c', `grep -qs ssl_certificate ${vhostAvail} ${vhostEnbl}`]),
      verifyFailure: async (c) => nginxConfigTestFailure(c),
    });

    // The certificate is in place, so a TLS listener now exists. On nginx
    // < 1.25.1 that listener's `http2` parameter is the ONLY way to enable
    // HTTP/2 (the vhost above deliberately emits no standalone directive —
    // that version cannot parse one), so switch it on here. Best effort: HTTP/2
    // is a performance property, never worth failing a working HTTPS install
    // over, so a skip only warns.
    if (!supportsHttp2Directive(nginxVersion)) {
      try {
        await sudoStep(ctx, {
          description: `Enable HTTP/2 on the new TLS listener (nginx ${nginxVersion ?? '< 1.25.1'} takes it as a "listen" parameter).`,
          command: `${enableHttp2OnTlsListenerSed(vhostAvail)} && nginx -t && systemctl reload nginx`,
          skippable: true,
          skipHint: `add http2 to the "listen 443 ssl;" line in ${vhostAvail} yourself, then reload nginx`,
          verify: (c) =>
            verifyCommand(c, 'sh', ['-c', `grep -Eqs '^[[:space:]]*listen.*443.*http2' ${vhostAvail}`]),
        });
      } catch (err) {
        if (!(err instanceof StepSkipped)) throw err;
        ctx.ui.warn(
          'HTTPS is up but HTTP/2 is not enabled — the cockpit works, yet several open run streams can exhaust ' +
            "the browser's ~6-connections-per-origin HTTP/1.1 limit and later requests will stall.",
        );
      }
    }

    ctx.state.publicUrl = `https://${trimmedDomain}`;
    // The cert + its auto-renewal timer are `shared`: uninstall lists them, it
    // does not delete them (removing a cert can break other vhosts). Same for
    // the certbot packages when this run installed them.
    const artifacts: StepArtifact[] = [
      shared('cert', { name: trimmedDomain, removeHint: `sudo certbot delete --cert-name ${trimmedDomain}` }),
    ];
    if (!certbotWasPresent) {
      artifacts.push(
        shared('package', {
          name: 'certbot + python3-certbot-nginx',
          removeHint: 'sudo apt-get remove -y certbot python3-certbot-nginx',
        }),
      );
    }
    return { artifacts };
  },
  async undo(ctx, created) {
    const cert = (created?.artifacts ?? []).find((a) => a.type === 'cert');
    if (cert) {
      ctx.ui.note(
        `The TLS certificate for ${cert.name ?? 'your domain'} and its auto-renewal timer were left in place.\nRemove them yourself if you want them gone:\n${cert.removeHint ?? ''}`,
        'SSL',
      );
    }
    const pkgs = (created?.artifacts ?? []).filter((a) => a.type === 'package');
    if (pkgs.length > 0) {
      ctx.ui.note(
        pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'Installed for cezar but possibly used elsewhere — remove manually if unwanted',
      );
    }
    // The vhost (with certbot’s edits) is removed by the nginx-proxy step’s undo.
  },
};

/**
 * systemd unit that runs cezar loopback-bound with CEZ_REMOTE=1.
 *
 * `execStart` must be an ABSOLUTE command — systemd resolves the ExecStart
 * executable against its OWN compiled-in PATH (/usr/local/bin:/usr/bin:…), NOT
 * the unit's `Environment=PATH`, so a bare `cezar` gives status=203/EXEC
 * ("Unable to locate executable"). `resolveExecStart` therefore returns an
 * absolute `"<node> <entry.js>"`. We still set `Environment=PATH` (with the
 * installer's node dir) for any child process the app spawns.
 */
export function systemdUnit(
  repoRoot: string,
  port: number,
  scope: 'user' | 'system',
  execStart: string,
  bindHost?: string,
  instanceId?: string,
  /** The front authenticates (`signIn: 'proxy'`): cezar's own sign-in is switched off. Absent
   *  for cezar's sign-in AND for a record that predates the choice, whose unit stays as it was. */
  proxyAuth = false,
): string {
  const userLine = scope === 'system' ? `User=${userInfo().username}\n` : '';
  const installTarget = scope === 'system' ? 'multi-user.target' : 'default.target';
  // Give the service the operator's own PATH (node dir + the login PATH the CLI
  // merged in, e.g. ~/.local/bin and nvm) so cezar can spawn claude / gh / codex
  // at runtime — systemd's default PATH has none of those.
  const pathDirs = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((d, i, a) => d && d !== '.' && a.indexOf(d) === i);
  // systemd expands `%` specifiers in Environment/ExecStart values — a literal
  // `%` (possible in an nvm dir name) must be doubled or the unit fails to load.
  const sysd = (s: string) => s.replace(/%/g, '%%');
  // Loopback stays the default (and stays flag-less, so existing units are
  // byte-identical); an external-proxy install binds an interface its proxy can
  // actually reach — a container-based proxy cannot dial the host's loopback.
  const bind = bindHost?.trim() && bindHost.trim() !== '127.0.0.1' ? ` --bind-host ${bindHost.trim()}` : '';
  return `# Managed by cezar server-install — do not edit by hand.
[Unit]
Description=cezar cockpit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}WorkingDirectory=${repoRoot}
Environment=CEZ_REMOTE=1
${proxyAuth ? 'Environment=CEZ_AUTH=0\n' : ''}${instanceId ? `Environment=CEZ_INSTANCE_ID=${sysd(instanceId)}\n` : ''}Environment=PATH=${sysd(pathDirs.join(':'))}
ExecStart=${sysd(execStart)} serve --no-open --port ${port}${sysd(bind)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=${installTarget}
`;
}

/** Our official npm package/alias — what `npx <this>` reinstalls the CLI as. */
const OFFICIAL_CLI_PKG = 'cezar-cli';

/**
 * Decide the absolute ExecStart command for the service, mirroring how the
 * installer itself was launched so the box keeps running the same cezar:
 *
 *  - Launched via `npx <alias>` (the CLI package lives in npm's ephemeral
 *    `_npx` cache, which gets cleaned): the service can't point there, so it
 *    reinstalls-and-runs the same way — `<abs npx> --yes cezar-cli` (bare `npx`
 *    would 203/EXEC, so npx is made absolute).
 *  - A stable install (a checkout, or a global `cezar-cli`/`cezar`): run the
 *    CLI's own built entry `<node> <pkg>/dist/index.js`, or a resolved global
 *    bin. Absolute node + absolute script → systemd never resolves off PATH.
 */
export function serviceExecStart(opts: {
  node: string;
  pkgRoot: string;
  entry: string;
  entryExists: boolean;
  npxPath: string;
  globalBin?: string;
}): string {
  if (/[/\\]_npx[/\\]/.test(opts.pkgRoot)) return `${opts.npxPath} --yes ${OFFICIAL_CLI_PKG}`;
  if (opts.entryExists) return `${opts.node} ${opts.entry}`;
  if (opts.globalBin) return `${opts.node} ${opts.globalBin}`;
  return `${opts.node} ${opts.entry}`;
}

async function resolveExecStart(ctx: InstallContext): Promise<string> {
  const node = process.execPath; // absolute node running this installer
  // The CLI's OWN package root (…/dist/server-install/platforms/ → up 3), NOT the
  // repo being operated on — `--repo` / cwd can differ from where cezar lives.
  const pkgRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const entry = join(pkgRoot, 'dist', 'index.js');
  let npxPath = join(dirname(node), 'npx');
  if (ctx.dryRun) return serviceExecStart({ node, pkgRoot, entry, entryExists: true, npxPath });
  // A standalone node binary has no adjacent npx — fall back to the login
  // shell's, or ExecStart would 203/EXEC (the exact bug 9fea263 fixed).
  if (!existsSync(npxPath)) {
    const found = (await ctx.runner.capture('bash', ['-lc', 'command -v npx'])).stdout.trim().split('\n').pop()?.trim();
    if (found) npxPath = found;
  }

  let globalBin: string | undefined;
  if (!existsSync(entry) && !/[/\\]_npx[/\\]/.test(pkgRoot)) {
    const out = (await ctx.runner.capture('bash', ['-lc', `command -v ${OFFICIAL_CLI_PKG} || command -v cezar`])).stdout.trim();
    globalBin = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    if (!globalBin) {
      ctx.ui.warn(
        `Could not locate a built cezar to run (${entry} missing, no global ${OFFICIAL_CLI_PKG}).\n` +
          `Install it (npm i -g ${OFFICIAL_CLI_PKG}) or build the checkout, then re-run with --reconfigure autostart.`,
      );
    }
  }
  return serviceExecStart({ node, pkgRoot, entry, entryExists: existsSync(entry), npxPath, globalBin });
}

/** The npx package cache root for the user the service runs as (this is the
 *  same user that runs `server-deploy`). Honors an `npm_config_cache` override,
 *  else npm's default `~/.npm`. */
function npxCacheDir(): string {
  const base = process.env.npm_config_cache?.trim() || join(homedir(), '.npm');
  return join(base, '_npx');
}

/** True when a systemd `ExecStart` string launches cezar via npx (the unpinned
 *  `npx --yes cezar-cli` form) rather than a checkout (`<node> …/dist/index.js`)
 *  or a global bin. */
export function isNpxExecStart(execStart: string): boolean {
  return /\bnpx\b/.test(execStart) && execStart.includes(OFFICIAL_CLI_PKG);
}

/**
 * The npx trap (#696): `npx --yes cezar-cli` caches the resolved package under
 * `~/.npm/_npx/<hash>` and reuses it forever — a service restart re-execs the
 * SAME cached build, so `server-deploy` would never actually update. Before
 * restarting an npx-based unit we delete the cache entries that contain
 * `cezar-cli`, so the next launch re-resolves `latest`. Surgical: other npx
 * packages' caches are left untouched. A checkout / global-bin unit has no
 * npx cache to clear and is skipped (its restart picks up the new build/global
 * directly).
 */
export function refreshNpxCacheForRedeploy(ctx: InstallContext, execStart: string): void {
  if (!isNpxExecStart(execStart)) return;
  const dir = npxCacheDir();
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would clear cached ${OFFICIAL_CLI_PKG} builds under ${dir} so npx refetches the latest.`);
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ctx.ui.info(`No cached ${OFFICIAL_CLI_PKG} npx build found — the restart will fetch the latest published version.`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new StepAborted(`cannot inspect the npx cache at ${dir}: ${message} — the service was not restarted`);
  }

  let cleared = 0;
  for (const entry of entries) {
    const pkgDir = join(dir, entry);
    const packageDir = join(pkgDir, 'node_modules', OFFICIAL_CLI_PKG);
    try {
      statSync(packageDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new StepAborted(`cannot inspect the npx cache entry at ${packageDir}: ${message} — the service was not restarted`);
    }
    try {
      rmSync(pkgDir, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StepAborted(`cannot remove the cached ${OFFICIAL_CLI_PKG} build at ${pkgDir}: ${message} — the service was not restarted`);
    }
    cleared++;
  }
  ctx.ui.info(
    cleared > 0
      ? `Cleared ${cleared} cached ${OFFICIAL_CLI_PKG} npx build(s) — the restart will fetch the latest published version.`
      : `No cached ${OFFICIAL_CLI_PKG} npx build found — the restart will fetch the latest published version.`,
  );
}

/** Read the unit's live `ExecStart` (read-only query; no sudo needed even for a
 *  system unit). Empty string when it can't be read — callers then skip the
 *  npx-cache refresh rather than guessing. */
async function readExecStart(ctx: InstallContext, scope: 'user' | 'system', unit: string): Promise<string> {
  const args = [...(scope === 'user' ? ['--user'] : []), 'show', unit, '-p', 'ExecStart'];
  const { stdout } = await ctx.runner.capture('systemctl', args);
  return stdout;
}

/** A unit without its PATH line: that line follows the installer's own shell, not the install. */
function unitBehaviour(unit: string): string {
  return unit.split('\n').filter((l) => !l.startsWith('Environment=PATH=')).join('\n').trimEnd();
}

/**
 * Write this instance's unit from the recorded state, enable it, and make the RUNNING process
 * match it. `enable --now` only starts a stopped unit, so a unit whose content changed is
 * restarted — and the restart is proven by a changed PID, as `server-deploy` does (#912).
 * A PATH-only difference is written but never restarts: it would kill running tasks unasked.
 * `always` restarts even an unchanged unit (the process is known not to match it).
 */
async function applyServiceUnit(
  ctx: InstallContext,
  restart: 'if-changed' | 'always' = 'if-changed',
): Promise<{ scope: 'user' | 'system'; artifact: StepArtifact }> {
  const UNIT_NAME = unitName(ctx);
  const execStart = await resolveExecStart(ctx);
  // Prefer a rootless `systemd --user` service + linger; fall back to a system
  // unit (via sudoStep) when the user bus is not reachable. `show-environment`
  // exits 0 iff the user manager is up — on a headless SSH box with no session
  // it fails (exit 1, not 127), which the old `!== 127` test misread as "up".
  const userBus = ctx.dryRun ? true : (await ctx.runner.capture('systemctl', ['--user', 'show-environment'])).code === 0;
  const scope = userBus ? 'user' : 'system';
  const unitPath = userBus ? join(homedir(), '.config', 'systemd', 'user', UNIT_NAME) : `/etc/systemd/system/${UNIT_NAME}`;
  const artifact = owned('service', { name: UNIT_NAME, scope, path: unitPath });
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would write ${unitPath} and enable it (systemctl --user enable --now cezar).`);
    return { scope, artifact };
  }
  const unit = systemdUnit(ctx.repoRoot, ctx.state.primaryPort, scope, execStart, ctx.state.bindHost, ctx.state.instanceId, ctx.state.signIn === 'proxy');
  const previous = userBus ? (existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : null) : await readHostFile(ctx, unitPath);
  const differs = previous !== null && previous.trimEnd() !== unit.trimEnd();
  const mustRestart = restart === 'always' || (previous !== null && unitBehaviour(previous) !== unitBehaviour(unit));
  const before = mustRestart ? await readServiceIdentity(ctx, scope, UNIT_NAME) : null;
  if (mustRestart) ctx.ui.info(`${UNIT_NAME} changed — restarting the service so the running cockpit picks it up.`);
  else if (differs) {
    ctx.ui.info(
      `${UNIT_NAME}: only the PATH line differs (it follows the shell the installer runs in). The unit is updated, ` +
        'but a running service is left alone so no task is interrupted — the new PATH applies on the next restart of the service.',
    );
  }

  if (userBus) {
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit, 'utf8');
    await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
    if (mustRestart) {
      await ctx.runner.interactive('systemctl', ['--user', 'enable', UNIT_NAME]);
      const code = await ctx.runner.interactive('systemctl', ['--user', 'restart', UNIT_NAME]);
      if (code !== 0) {
        throw new StepAborted(
          `systemctl --user restart ${UNIT_NAME} exited ${code} — the service was NOT restarted, so the old process ` +
            `is still serving with its old settings. Check \`systemctl --user status ${UNIT_NAME}\`.`,
        );
      }
    } else {
      await ctx.runner.interactive('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
    }
    if ((await ctx.runner.capture('systemctl', ['--user', 'is-enabled', UNIT_NAME])).code !== 0) {
      ctx.ui.warn('The user service did not enable cleanly — check `systemctl --user status cezar`.');
    }
  } else {
    await writeFileStep(ctx, {
      description: mustRestart
        ? 'Install the changed cezar systemd unit, enable it at boot, and restart the service.'
        : 'Install the cezar systemd unit, start it now, and enable it at boot.',
      path: unitPath,
      content: unit,
      extra: mustRestart
        ? `systemctl daemon-reload && systemctl enable ${UNIT_NAME} && systemctl restart ${UNIT_NAME}`
        : `systemctl daemon-reload && systemctl enable --now ${UNIT_NAME}`,
      verify: (c) => verifyCommand(c, 'systemctl', ['is-enabled', UNIT_NAME]),
    });
  }
  if (mustRestart) await confirmServiceRestarted(ctx, scope, UNIT_NAME, before);
  return { scope, artifact };
}

const autostartStep: InstallStep = {
  id: 'autostart',
  // Required: after install the cockpit must actually be serving, so cezar runs
  // as a systemd service — started now AND enabled on boot. (id kept as
  // `autostart` for state compatibility.)
  title: 'Run cezar as a service (systemd — starts now + on boot)',
  async check() {
    return false; // always (re)assert the service is installed and running
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // An external-proxy install has no nginx step to ask in, and the unit written below is what
    // carries the answer.
    if (ctx.state.externalProxy && ctx.state.signIn === undefined) {
      await chooseSignIn(ctx, 'My reverse proxy authenticates (a Basic-Auth or SSO middleware)');
    }
    const svc = await applyServiceUnit(ctx);
    if (svc.scope === 'system') {
      await confirmCezarRunning(ctx, 'sudo systemctl status cezar', 'sudo journalctl -u cezar -n 50 --no-pager');
      return { artifacts: [svc.artifact] };
    }
    // Linger lets the user service survive logout / start at boot — usually
    // needs root. Record it as owned only when THIS run turned it on, so
    // uninstall reverses exactly what install changed (a pre-existing linger
    // may serve other user services).
    const osUser = userInfo().username;
    const lingerWasOn = await verifyCommand(ctx, 'loginctl', ['show-user', osUser, '-p', 'Linger'], (r) =>
      r.stdout.includes('Linger=yes'),
    );
    await sudoStep(ctx, {
      description: 'Enable linger so the cockpit starts at boot without a login session.',
      command: `loginctl enable-linger ${shquote(osUser)}`,
      verify: (c) =>
        verifyCommand(c, 'loginctl', ['show-user', osUser, '-p', 'Linger'], (r) =>
          r.stdout.includes('Linger=yes'),
        ),
    });
    await confirmCezarRunning(ctx, 'systemctl --user status cezar', 'journalctl --user -u cezar -n 50 --no-pager');
    const artifacts: StepArtifact[] = [svc.artifact];
    if (!lingerWasOn) artifacts.push(owned('linger', { name: osUser }));
    return { artifacts };
  },
  async undo(ctx, created) {
    const UNIT_NAME = unitName(ctx);
    const svc = (created?.artifacts ?? []).find((a) => a.type === 'service');
    // Reverse linger only when install recorded that it enabled it.
    const linger = (created?.artifacts ?? []).find((a) => a.type === 'linger');
    if (svc?.scope === 'user') {
      if (!ctx.dryRun) {
        await ctx.runner.interactive('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
        if (svc.path) rmSync(svc.path, { force: true });
        await ctx.runner.interactive('systemctl', ['--user', 'daemon-reload']);
      } else {
        ctx.ui.info('DRY RUN — would disable and remove the user service.');
      }
    } else if (svc) {
      await sudoStep(ctx, {
        description: 'Disable and remove the cezar systemd unit.',
        command: `systemctl disable --now ${UNIT_NAME}; rm -f /etc/systemd/system/${UNIT_NAME} && systemctl daemon-reload`,
        verify: (c) => verifyCommand(c, 'sh', ['-c', `! systemctl is-enabled ${UNIT_NAME}`]),
      });
    }
    if (linger?.name) {
      await sudoStep(ctx, {
        description: 'Disable linger (this install enabled it; nothing else needs it).',
        command: `loginctl disable-linger ${shquote(linger.name)}`,
        verify: (c) =>
          verifyCommand(c, 'loginctl', ['show-user', linger.name ?? '', '-p', 'Linger'], (r) =>
            r.stdout.includes('Linger=no'),
          ),
      });
    }
  },
};

/**
 * `--external-proxy` verification: confirm the cockpit is listening on the
 * interface the operator's proxy will dial, then hand them the routing snippet.
 * cezar ships no auth of its own, so this is also where we say — unmissably —
 * that the front they own has to enforce it.
 */
async function verifyBehindExternalProxy(ctx: InstallContext): Promise<{ artifacts: StepArtifact[] }> {
  const port = ctx.state.primaryPort;
  const host = upstreamHost(ctx);
  const target = `http://${host}:${port}`;
  const domain = ctx.state.domain ?? '<your-domain>';

  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would verify cezar answers on ${target} and print the proxy routing snippet.`);
    return { artifacts: [] };
  }

  if (!(await waitForCezar(ctx, port))) {
    ctx.ui.error(
      `cezar is not answering on ${target}.\n\n` +
        `Diagnostics on the server:\n` +
        `  • systemctl --user status ${unitName(ctx)}   (or: sudo systemctl status ${unitName(ctx)})\n` +
        `  • sudo ss -ltnp | grep :${port}\n` +
        (host === '127.0.0.1'
          ? ''
          : `  • is ${host} a real local interface? (ip -brief addr) — a container-based proxy\n` +
            `    usually reaches the host on the docker bridge, commonly 172.17.0.1\n`),
    );
    throw new StepAborted('cockpit verification failed — see the diagnostics above');
  }

  if (ctx.state.signIn === 'cezar') {
    const problems = await verifyCezarSignIn(ctx, { base: `${target}/`, args: [], through: target });
    if (problems.length > 0) {
      ctx.ui.error(`The cockpit is NOT fully working yet:\n` + problems.map((p) => `  • ${p}`).join('\n'));
      throw new StepAborted('cockpit verification failed — see the diagnostics above');
    }
    ctx.ui.success(`Cockpit is up on ${target}, and cezar's own sign-in guards it.`);
    ctx.ui.message(
      [
        `Point your existing proxy at ${target} for ${domain}. It needs to do three things:`,
        `  • terminate TLS — cezar's sign-in refuses to set a session over plain HTTP`,
        `  • send X-Forwarded-Proto: https and the original Host (Traefik and Caddy do by default)`,
        `  • pass WebSocket upgrades for /api/v1/ws (also their default)`,
        ``,
        `No auth middleware is needed: cezar asks for a password and an authenticator code itself.`,
        `Keep ${host}:${port} off the public internet (ufw / cloud firewall) all the same.`,
      ].join('\n'),
    );
    announceSignIn(ctx, ctx.state.domain ? `https://${ctx.state.domain}` : '<your cockpit address>');
    return { artifacts: [] };
  }

  ctx.ui.success(`Cockpit is up and listening on ${target}.`);
  ctx.ui.warn(
    "cezar's own sign-in is OFF in this mode (CEZ_AUTH=0) — your reverse proxy MUST enforce authentication. " +
      'Anyone who can reach ' + target + ' can run agents on this box.',
  );
  ctx.ui.message(
    [
      `Point your existing proxy at ${target} for ${domain}. For Dokploy / Traefik,`,
      `add a file-provider config (Traefik runs in a container, so it cannot use 127.0.0.1):`,
      ``,
      `  http:`,
      `    routers:`,
      `      cezar:`,
      `        rule: "Host(\`${domain}\`)"`,
      `        entryPoints: [websecure]`,
      `        middlewares: [cezar-auth]`,
      `        service: cezar`,
      `        tls: { certResolver: letsencrypt }`,
      `    services:`,
      `      cezar:`,
      `        loadBalancer:`,
      `          servers: [{ url: "${target}" }]`,
      `    middlewares:`,
      `      cezar-auth:`,
      `        basicAuth:`,
      `          users: ["USER:$$apr1$$...."]   # htpasswd -nb user pass (double every $)`,
      ``,
      `Keep ${host}:${port} off the public internet (ufw / cloud firewall) — the proxy`,
      `should be the only thing that can reach it.`,
    ].join('\n'),
  );
  return { artifacts: [] };
}

/**
 * A host-key request through `curl -K -`, so the key never lands in argv. `null` when this host
 * has no key yet (the service has not booted with sign-in on).
 */
async function hostKeyResponse(ctx: InstallContext, args: string[]): Promise<{ code: string; body: string } | null> {
  const key = readHostKey();
  if (!key) return null;
  return curlResponse(ctx, [...args.slice(0, -1), '-K', '-', args.at(-1)!], {
    input: `header = "Authorization: Bearer ${key}"\n`,
  });
}

/**
 * The last thing an install with cezar's own sign-in does: say how to get in. No account yet →
 * mint the one-time setup link (the installer runs as the user the service runs as, so it can);
 * an account already exists → say so, and how to reset it.
 */
function announceSignIn(ctx: InstallContext, url: string): void {
  const issued = issueSetupCode();
  if (issued.ok) {
    ctx.ui.note(
      `${url}/setup#code=${issued.setup.code}\n\n` +
        'Open it within 15 minutes to create the owner account: a password, then an authenticator app.\n' +
        'It works once. For a fresh link later: cezar auth setup',
      'Create your account',
    );
    return;
  }
  ctx.ui.info(`An account already exists — sign in at ${url}. Lost access? Run: cezar auth reset <user>`);
}

/**
 * The end-to-end check when cezar signs users in itself (spec 2026-10-12-cockpit-authentication
 * §7). Different proof from the Basic-Auth path, same standard: "complete" must mean it works.
 * `base` is where the probe goes — the nginx front, or the upstream behind an external proxy.
 */
async function verifyCezarSignIn(
  ctx: InstallContext,
  probe: { base: string; args: string[]; through: string },
): Promise<string[]> {
  const problems: string[] = [];
  const anon = await curlCode(ctx, [...probe.args, `${probe.base}api/v1/health`]);
  if (anon !== '401') {
    problems.push(
      `an anonymous request for /api/v1/health through ${probe.through} got "${anon}", not 401 — cezar's sign-in is not guarding the API` +
        (anon === '200' ? ' (is CEZ_AUTH=0 set on the service?)' : ''),
    );
  }
  const session = await curlResponse(ctx, [...probe.args, `${probe.base}api/v1/auth/session`]);
  try {
    if ((JSON.parse(session.body) as { enforced?: unknown }).enforced !== true) throw new Error('not enforced');
  } catch {
    problems.push(`/api/v1/auth/session through ${probe.through} did not report sign-in as enforced (got "${session.code}")`);
  }
  // The owner's view of the same route proves a credentialed request reaches THIS install.
  const authed = await hostKeyResponse(ctx, [...probe.args, `${probe.base}api/v1/health`]);
  if (authed === null) {
    problems.push('this host has no cockpit key yet (~/.cezar/auth-host.key) — the service has not started with sign-in on');
  } else if (!/^2\d\d$/.test(authed.code)) {
    problems.push(`an authenticated request through ${probe.through} got "${authed.code}" — it did not reach cezar`);
  } else if (ctx.state.instanceId) {
    try {
      const served = (JSON.parse(authed.body) as { instanceId?: unknown }).instanceId;
      if (typeof served === 'string' && served !== ctx.state.instanceId) {
        problems.push(`the cockpit answering through ${probe.through} is serving another install, not this one`);
      }
    } catch {
      // An unreadable body leaves identity inconclusive, as it always has.
    }
  }
  return problems;
}

const identityStep: InstallStep = {
  id: 'identity',
  title: 'Verify the cockpit end-to-end (sign-in + HTTPS reach cezar)',
  async check() {
    return false; // always re-verify; it creates nothing
  },
  async run(ctx): Promise<{ artifacts: StepArtifact[] }> {
    // External proxy: cezar installed no nginx, so there is no auth challenge of
    // ours to probe. All we can (and should) verify is that the cockpit is
    // actually listening where the operator's proxy will look for it.
    if (ctx.state.externalProxy) return verifyBehindExternalProxy(ctx);
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would verify auth (401 for anon) AND that an authenticated request reaches cezar.');
      return { artifacts: [] };
    }
    const port = ctx.state.primaryPort;
    const https = ctx.state.publicUrl?.startsWith('https://') ?? false;
    const base = https ? 'https://127.0.0.1/' : 'http://127.0.0.1/';
    const tls = https ? ['-k'] : [];
    // When several instances share nginx, a bare 127.0.0.1 request hits whatever
    // vhost nginx treats as default. Send this instance's own Host header so the
    // probe verifies THIS cockpit's vhost, not a sibling's.
    const host = ctx.state.domain ? ['-H', `Host: ${ctx.state.domain}`] : [];

    // 1) Is cezar actually listening on the loopback upstream? nginx challenges
    //    auth *before* proxying, so an anonymous 401 alone does NOT prove the
    //    backend is up — check the upstream directly.
    const upstreamUp = await isCezarUp(ctx, port);

    if (ctx.state.signIn === 'cezar') {
      const problems: string[] = [];
      if (!upstreamUp) problems.push(`cezar is not listening on 127.0.0.1:${port} — the service is down, so nginx returns 502`);
      if (!https) {
        problems.push(
          "this cockpit has no HTTPS yet, and cezar's sign-in refuses to set a session over plain HTTP — " +
            're-run: cezar server-install --platform ubuntu-vps --reconfigure ssl',
        );
      }
      if (upstreamUp && https) problems.push(...(await verifyCezarSignIn(ctx, { base, args: [...tls, ...host], through: 'nginx' })));
      if (problems.length === 0) {
        const url = ctx.state.publicUrl!;
        ctx.ui.success(`Cockpit is live at ${url} — cezar's sign-in guards it, and an authenticated request reached this install.`);
        announceSignIn(ctx, url);
        return { artifacts: [] };
      }
      ctx.ui.error(
        `The cockpit is NOT fully working yet:\n` +
          problems.map((p) => `  • ${p}`).join('\n') +
          `\n\nDiagnostics on the server:\n` +
          `  • systemctl --user status cezar   (or: sudo systemctl status cezar)\n` +
          `  • sudo systemctl status nginx && sudo nginx -t\n` +
          `  • sudo ss -ltnp | grep -E ':80|:443|:${port}'`,
      );
      throw new StepAborted('cockpit verification failed — see the diagnostics above');
    }

    // 2) An anonymous request through nginx must be challenged (auth is active).
    const anonCode = await curlCode(ctx, [...tls, ...host, base]);
    const authEnforced = anonCode === '401';

    // 3) The real proof: an AUTHENTICATED request reaches cezar (2xx/3xx — not
    //    401/403 = bad creds, not 502/504 = upstream down). Credentials are read
    //    from stdin (curl -K -) so they never land in argv. `null` = not testable
    //    (a resume where the plaintext password is no longer in memory).
    let authedOk: boolean | null = null;
    let identityOk: boolean | null = null;
    const cred = ctx.prefs.cockpit;
    if (cred) {
      // curl's config format requires `\` and `"` escaped inside the quoted
      // value — both are legal password characters; unescaped they break the
      // config parse and fail a WORKING install with "bad credentials".
      const curlCfgQuote = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const curlArgs = [...tls, ...host, '-K', '-', base];
      const code = await curlCode(ctx, curlArgs, {
        input: `user = "${curlCfgQuote(cred.user)}:${curlCfgQuote(cred.password)}"\n`,
      });
      authedOk = /^[23]\d\d$/.test(code);
      if (authedOk && ctx.state.instanceId) {
        const health = await curlResponse(ctx, [...tls, ...host, '-K', '-', `${base}api/v1/health`], {
          input: `user = "${curlCfgQuote(cred.user)}:${curlCfgQuote(cred.password)}"\n`,
        });
        try {
          const payload = JSON.parse(health.body) as { instanceId?: unknown };
          if (health.code.match(/^[23]\d\d$/) && typeof payload.instanceId === 'string') {
            identityOk = payload.instanceId === ctx.state.instanceId;
          }
        } catch {
          // Older or non-cezar responders make identity inconclusive.
        }
      }
    }

    const url = ctx.state.publicUrl ?? `http://<this-server>`;
    const coreOk = upstreamUp && authEnforced && authedOk !== false && identityOk !== false;
    if (coreOk) {
      ctx.ui.success(
        `Cockpit is live at ${url} — ${authedOk ? 'an authenticated request reached cezar' : 'auth is enforced and cezar is up'}. ` +
          'Log in with the username and password you set.',
      );
      if (!https) {
        ctx.ui.warn(
          'This cockpit is HTTP-only (no domain/SSL configured). To serve it over HTTPS with this same auth, ' +
            're-run: cezar server-install --platform ubuntu-vps --reconfigure ssl',
        );
      }
      if (ctx.state.instanceId && identityOk === null) {
        ctx.ui.warn('The cockpit is reachable, but the instance identity check could not run (older or invalid health payload).');
      }
      return { artifacts: [] };
    }

    const problems: string[] = [];
    if (!upstreamUp) problems.push(`cezar is not listening on 127.0.0.1:${port} — the service is down, so nginx returns 502`);
    if (!authEnforced) problems.push(`nginx did not challenge an anonymous request (got "${anonCode}") — basic auth may not be active`);
    if (authedOk === false) problems.push('an authenticated request did not reach cezar (bad credentials, or the upstream is down)');
    if (identityOk === false) problems.push(`the cockpit answering on 127.0.0.1:${port} is serving another install, not this one`);
    ctx.ui.error(
      `The cockpit is NOT fully working yet:\n` +
        problems.map((p) => `  • ${p}`).join('\n') +
        `\n\nDiagnostics on the server:\n` +
        `  • systemctl --user status cezar   (or: sudo systemctl status cezar)\n` +
        `  • sudo systemctl status nginx && sudo nginx -t\n` +
        `  • sudo ss -ltnp | grep -E ':80|:443|:${port}'\n` +
        `  • ports 80/443 open in ufw AND any cloud firewall (Hetzner/AWS)`,
    );
    // Fail the run so `installed` stays false and the exit code is non-zero —
    // "complete" must mean the cockpit actually works. Re-run to resume (the
    // service/proxy steps are idempotent).
    throw new StepAborted('cockpit verification failed — see the diagnostics above');
  },
  async undo() {
    // nothing created
  },
};

/**
 * A record written before the sign-in choice existed (`signIn` absent) describes an install whose
 * FRONT authenticates and whose unit says nothing about `CEZ_AUTH`. The cezar it just restarted
 * into turns its own sign-in on for a hosted cockpit, so that install now has both. Nothing is
 * exposed that was not — the front still asks first — but the operator has to be told, because
 * the cockpit will greet them with a setup screen. Never rewrites anything (spec §9).
 */
async function explainLegacySignIn(ctx: InstallContext): Promise<void> {
  if (ctx.state.signIn !== undefined) return;
  const session = await curlResponse(ctx, [`http://${upstreamHost(ctx)}:${ctx.state.primaryPort}/api/v1/auth/session`]);
  let enforced = false;
  try {
    enforced = (JSON.parse(session.body) as { enforced?: unknown }).enforced === true;
  } catch {
    return; // an older cezar, or not answering — nothing to explain
  }
  if (!enforced) return;
  const reconfigure = ctx.state.externalProxy ? 'autostart' : 'nginx-proxy,ssl,autostart';
  ctx.ui.warn(
    "This version of cezar has its own sign-in, and it is now ON for this cockpit — behind your proxy's login, which is still there.\n" +
      'Pick one:\n' +
      `  • use cezar's sign-in (password + authenticator app): run \`cezar auth setup\` and open the link;\n` +
      `    then drop the proxy login with: cezar server-install --platform ubuntu-vps --reconfigure ${reconfigure}\n` +
      '  • keep only the proxy login: add `Environment=CEZ_AUTH=0` to the cezar service and restart it.',
  );
}

export const ubuntuVps: PlatformStrategy = {
  id: 'ubuntu-vps',
  label: 'Ubuntu/Debian VPS',
  async preflight(ctx: InstallContext) {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — skipping OS/privilege preflight.');
      return;
    }
    const uname = await ctx.runner.capture('uname', ['-s']);
    if (!uname.stdout.includes('Linux')) {
      throw new PreflightError('ubuntu-vps requires Linux. On macOS use --platform macosx-ngrok.');
    }
    if ((await ctx.runner.capture('apt-get', ['--version'])).code !== 0) {
      throw new PreflightError('ubuntu-vps requires apt (Debian/Ubuntu).');
    }
    if ((await ctx.runner.capture('id', ['-u'])).stdout.trim() === '0') {
      throw new PreflightError('run server-install as a normal sudo-capable user, not root.');
    }
    // Someone else already owns the HTTP front (Dokploy/Traefik, Coolify, Caddy,
    // a hand-rolled nginx)? Installing ours would fight it for :80/:443 and the
    // proxy step would fail with a confusing bind error — point at the mode that
    // actually fits instead.
    if (!ctx.state.externalProxy) {
      const holder = await portListener(ctx, 80);
      if (holder && !/nginx/i.test(holder)) {
        ctx.ui.warn(
          `Port 80 is already served by "${holder}" on this host.\n` +
            `cezar's ubuntu-vps install wants :80/:443 for its own nginx, so these will collide.\n\n` +
            `If that is a reverse proxy you rely on (Dokploy/Traefik, Coolify, Caddy), re-run with:\n` +
            `  cezar server-install --platform ubuntu-vps --external-proxy${ctx.state.domain ? ` --domain ${ctx.state.domain}` : ''} [--bind-host 172.17.0.1]\n` +
            `That installs the cezar service only and lets your proxy front it.`,
        );
      }
    }
  },
  steps(ctx: InstallContext): InstallStep[] {
    // `--external-proxy`: the box already has a front owning :80/:443 (Dokploy/
    // Traefik, Coolify, Caddy, an existing nginx). Installing our own nginx
    // there would fight it for the ports, so we ship the service only and let
    // that proxy terminate TLS + auth.
    if (ctx.state.externalProxy) return [depCheckStep(), autostartStep, identityStep];
    // deps → proxy → (optional) ssl → autostart → identity.
    return [depCheckStep(), nginxProxyStep, sslStep, autostartStep, identityStep];
  },
  async redeploy(ctx: InstallContext) {
    const UNIT_NAME = unitName(ctx);
    // Restart the systemd service so it picks up the new cezar (a fresh local
    // build the unit runs from, or a newly published cezar-cli via npx), then
    // re-run the same end-to-end verify install uses.
    const svc = (ctx.state.steps['autostart']?.created?.artifacts ?? []).find((a) => a.type === 'service');
    // No recorded artifact (older record, or the step was check()-satisfied):
    // prefer the scope whose unit file actually exists — the user unit is the
    // install default, so defaulting to `system` would sudo-restart a unit
    // that was never installed.
    const userUnitExists = existsSync(join(homedir(), '.config', 'systemd', 'user', UNIT_NAME));
    const scope: 'user' | 'system' =
      svc?.scope === 'user' || svc?.scope === 'system' ? svc.scope : userUnitExists ? 'user' : 'system';
    // #696: an npx-launched unit re-execs its cached build on restart, so a
    // deploy that doesn't invalidate the npx cache never actually updates.
    // Clear the cezar-cli cache first (read the live ExecStart to know the
    // launch form); a checkout / global unit is left alone.
    refreshNpxCacheForRedeploy(ctx, await readExecStart(ctx, scope, UNIT_NAME));
    if (ctx.dryRun) {
      ctx.ui.info(`DRY RUN — would reload+restart the cezar ${scope} service and re-verify the cockpit.`);
      return;
    }
    ctx.ui.info(`Redeploying — restarting the cezar ${scope} service to pick up the new version.`);
    // Who is serving BEFORE the restart, so the verification below can tell a real
    // deploy from one that left the old process in place (#912).
    const before = await readServiceIdentity(ctx, scope, UNIT_NAME);
    if (scope === 'user') {
      // Captured rather than streamed: systemd's own failure text ("Failed to
      // connect to bus…") IS the diagnosis, and it has to reach the abort message
      // instead of scrolling past above a success banner. Both commands are silent
      // when they succeed, so nothing is lost on the happy path.
      const reload = await ctx.runner.capture('systemctl', ['--user', 'daemon-reload']);
      if (reload.code !== 0) ctx.ui.warn(`systemctl --user daemon-reload exited ${reload.code}.${outputTail(reload)}`);
      const restart = await ctx.runner.capture('systemctl', ['--user', 'restart', UNIT_NAME]);
      if (restart.code !== 0) {
        // A restart that did not run is a FAILED deploy, not a warning: the old
        // process keeps serving, and `runDeploy` turns this into exit 1 with no
        // "complete — reloaded and verified" banner (#912).
        const hint = noDbusSessionHint(scope, [reload.stderr, reload.stdout, restart.stderr, restart.stdout].join('\n'));
        throw new StepAborted(
          `systemctl --user restart ${UNIT_NAME} exited ${restart.code} — the service was NOT restarted, so the old ` +
            `process is still serving the previous version.${outputTail(restart)}\n` +
            (hint ? `${hint}\n` : '') +
            `Check \`systemctl --user status ${UNIT_NAME}\` / \`journalctl --user -u cezar -n 50 --no-pager\`.`,
        );
      }
    } else {
      await sudoStep(ctx, {
        description: 'Reload systemd and restart the cezar service.',
        command: `systemctl daemon-reload && systemctl restart ${UNIT_NAME}`,
        verify: (c) => verifyCommand(c, 'systemctl', ['is-active', UNIT_NAME]),
      });
    }
    // `is-active` and "the port answers" are both satisfied by the process that was
    // already there — only a changed PID/start time proves the restart happened.
    await confirmServiceRestarted(ctx, scope, UNIT_NAME, before);
    await confirmCezarRunning(
      ctx,
      scope === 'user' ? 'systemctl --user status cezar' : 'sudo systemctl status cezar',
      scope === 'user' ? 'journalctl --user -u cezar -n 50 --no-pager' : 'sudo journalctl -u cezar -n 50 --no-pager',
    );
    await identityStep.run(ctx); // throws StepAborted if the cockpit isn't fully working
    await explainLegacySignIn(ctx);
  },
};
