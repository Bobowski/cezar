import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nginxVhost, systemdUnit, ubuntuVps } from './ubuntu-vps.ts';
import { StepAborted } from '../steps.ts';
import { createAutoUi } from '../ui.ts';
import type { InstallContext, InstallStep, Runner, Ui } from '../types.ts';

/**
 * Regression tests for the installer review (spec 2026-10-12-cockpit-authentication §9a): the
 * nginx site is rendered from the recorded state by one helper, never loses its login before the
 * service enforces cezar's own, and a file nginx rejects is not left in place.
 */

const DOMAIN = 'agents.example.dev';
const PORT = 4321;
const SITE = '/etc/nginx/sites-available/cezar';

/** A site as certbot leaves it on Ubuntu 24.04 (captured from `certbot install --nginx` in a container). */
function certbotSite(inner: string): string {
  return inner.replace(
    /    listen 80;\n    listen \[::\]:80;\n/,
    '',
  ).replace(
    /\n}\n$/,
    `\n
    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl http2; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}

server {
    if ($host = ${DOMAIN}) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    return 404; # managed by Certbot


}
`,
  );
}

interface Host {
  /** Content of the instance's file in sites-available, or null when absent. */
  site: string | null;
  /** Does an anonymous `GET /api/v1/health` on loopback answer 401? */
  enforcing: boolean;
  /** A restart brings the process in line with the unit on disk. */
  restartApplies: boolean;
  userBus: boolean;
  systemUnit: string | null;
  pid: number;
  /** What happened, in order: `probe:401`, `restart`, `site:open`, `site:basic`. */
  events: string[];
  sudo: string[];
  systemctl: string[];
}

function fakeHost(over: Partial<Host> = {}): { host: Host; runner: Runner } {
  const host: Host = {
    site: null,
    enforcing: false,
    restartApplies: true,
    userBus: true,
    systemUnit: null,
    pid: 100,
    events: [],
    sudo: [],
    systemctl: [],
    ...over,
  };
  const ok = { code: 0, stdout: '', stderr: '' };
  const userUnit = () => {
    const p = join(process.env.HOME ?? '', '.config', 'systemd', 'user', 'cezar.service');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const restart = () => {
    host.events.push('restart');
    host.pid += 1;
    const unit = host.userBus ? userUnit() : host.systemUnit;
    if (host.restartApplies && unit !== null) host.enforcing = !unit.includes('CEZ_AUTH=0');
  };
  const runner: Runner = {
    capture: async (program, args, opts) => {
      const joined = args.join(' ');
      if (program === 'nginx' && args[0] === '-v') return { code: 0, stdout: '', stderr: 'nginx version: nginx/1.24.0 (Ubuntu)\n' };
      if (program === 'openssl') return { code: 0, stdout: '$apr1$salt$hash\n', stderr: '' };
      if (program === 'cat' && joined.includes('sites-available')) {
        return host.site === null ? { code: 1, stdout: '', stderr: 'No such file' } : { code: 0, stdout: host.site, stderr: '' };
      }
      if (program === 'cat' && joined.includes('/etc/systemd/system')) {
        return host.systemUnit === null ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: host.systemUnit, stderr: '' };
      }
      if (program === 'cmp') return { code: opts?.input === host.site ? 0 : 1, stdout: '', stderr: '' };
      if (program === 'curl' && joined.includes(`:${PORT}/api/v1/health`)) {
        const code = host.enforcing ? '401' : '200';
        host.events.push(`probe:${code}`);
        return { code: 0, stdout: code, stderr: '' };
      }
      if (program === 'curl') return { code: 0, stdout: '200', stderr: '' };
      if (program === 'systemctl' && joined === '--user show-environment') return { ...ok, code: host.userBus ? 0 : 1 };
      if (program === 'systemctl' && args.includes('show')) {
        return { code: 0, stdout: `MainPID=${host.pid}\nExecMainStartTimestampMonotonic=${host.pid}\n`, stderr: '' };
      }
      if (joined.includes('grep -qs ssl_certificate')) return { ...ok, code: host.site?.includes('ssl_certificate') ? 0 : 1 };
      if (program === 'loginctl') return { code: 0, stdout: 'Linger=yes\n', stderr: '' };
      return ok;
    },
    interactive: async (program, args) => {
      if (program === 'systemctl') {
        host.systemctl.push(args.join(' '));
        if (args.includes('restart')) restart();
        return 0;
      }
      if (program !== 'sudo') return 0;
      const cmd = String(args[2]);
      host.sudo.push(cmd);
      const write = /printf %s '([A-Za-z0-9+/=]+)' \| base64 --decode > '([^']+)'/.exec(cmd);
      if (write) {
        const content = Buffer.from(write[1]!, 'base64').toString('utf8');
        if (write[2]!.includes('sites-available')) {
          host.site = content;
          host.events.push(content.includes('auth_basic') ? 'site:basic' : 'site:open');
        }
        if (write[2]!.includes('/etc/systemd/system')) host.systemUnit = content;
      }
      if (cmd.startsWith('certbot') && host.site !== null) host.site = certbotSite(host.site);
      if (/systemctl restart/.test(cmd)) restart();
      return 0;
    },
  };
  return { host, runner };
}

/** An operator at the keyboard who picks `signIn` and lets sudo run everything. */
function operatorUi(signIn: 'cezar' | 'proxy', sink: string[] = []): Ui {
  return {
    ...createAutoUi({}, (m) => sink.push(m)),
    select: async (o: { message: string; initialValue?: unknown; options: Array<{ value: unknown }> }) =>
      o.message.startsWith('How do people sign in') ? signIn : (o.initialValue ?? o.options[0]?.value),
    // Never loop on a verification that keeps failing.
    confirm: async (o: { message: string }) => !o.message.startsWith('Try again'),
    text: async (o: { message: string }) => (o.message.includes('Email') ? 'ops@example.dev' : o.message.includes('Domain') ? DOMAIN : 'ops'),
    password: async () => 'longenough',
  } as unknown as Ui;
}

function ctxFor(runner: Runner, ui: Ui, state: Partial<InstallContext['state']>, instance = 'default'): InstallContext {
  return {
    state: { schema: 1, installed: false, primaryPort: PORT, steps: {}, ...state },
    ui,
    instance,
    runner,
    save: async () => {},
    dryRun: false,
    assumeYes: false,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-10-12T00:00:00.000Z',
    prefs: { sudoMode: 'sudo' },
  };
}

function step(ctx: InstallContext, id: string): InstallStep {
  const s = ubuntuVps.steps(ctx).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

let home: string;
const originalHome = process.env.HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-site-'));
  process.env.HOME = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeUserUnit(proxyAuth: boolean): void {
  const dir = join(home, '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cezar.service'), systemdUnit('/repo', PORT, 'user', '/usr/bin/node /x/dist/index.js', undefined, undefined, proxyAuth));
}

describe('one helper renders the site from the recorded state (finding 1)', () => {
  it("the SSL step keeps cezar's sign-in: no auth_basic, the sign-in rate limit, the instance's names", async () => {
    const { host, runner } = fakeHost({ enforcing: true });
    const ctx = ctxFor(runner, operatorUi('cezar'), { signIn: 'cezar', domain: 'staging.example.dev' }, 'staging');
    await step(ctx, 'ssl').run(ctx);

    const written = host.sudo.find((c) => c.includes("base64 --decode > '/etc/nginx/sites-available/cezar-staging'"));
    const site = Buffer.from(/printf %s '([A-Za-z0-9+/=]+)'/.exec(written ?? '')?.[1] ?? '', 'base64').toString('utf8');
    expect(site).toContain('server_name staging.example.dev;');
    expect(site).not.toContain('auth_basic');
    expect(site).toContain('limit_req zone=cez_signin_staging');
    expect(site).toContain('$cez_connection_staging');
    expect(site).not.toContain('$cez_connection_default');
  });

  it('the SSL step and the proxy step write the same site for the same state', async () => {
    for (const signIn of ['cezar', 'proxy'] as const) {
      const a = fakeHost({ enforcing: signIn === 'cezar' });
      const proxyCtx = ctxFor(a.runner, operatorUi(signIn), { signIn, domain: DOMAIN });
      await step(proxyCtx, 'nginx-proxy').run(proxyCtx);
      const fromProxy = a.host.site;

      const b = fakeHost({ enforcing: signIn === 'cezar' });
      const sslCtx = ctxFor(b.runner, operatorUi(signIn), { signIn, domain: DOMAIN });
      let fromSsl: string | null = null;
      const original = b.runner.interactive;
      b.runner.interactive = async (p, args, o) => {
        const code = await original(p, args, o);
        // The site as the SSL step wrote it, before certbot edits it.
        if (fromSsl === null && String(args[2]).includes('base64 --decode')) fromSsl = b.host.site;
        return code;
      };
      await step(sslCtx, 'ssl').run(sslCtx);
      expect(fromSsl, signIn).toBe(fromProxy);
      expect(fromProxy?.includes('auth_basic'), signIn).toBe(signIn === 'proxy');
    }
  });

  it("a re-render keeps certbot's TLS listener, certificate lines and redirect block", async () => {
    const existing = certbotSite(nginxVhost(PORT, DOMAIN, '/etc/cezar/htpasswd', '1.24.0', 'default'));
    const { host, runner } = fakeHost({ enforcing: true, site: existing });
    const ctx = ctxFor(runner, operatorUi('cezar'), { signIn: 'proxy', domain: DOMAIN, publicUrl: `https://${DOMAIN}` });
    await step(ctx, 'nginx-proxy').run(ctx);

    const site = host.site ?? '';
    expect(site).not.toContain('auth_basic');
    expect(site).toContain('limit_req zone=cez_signin_default');
    for (const line of [
      'listen [::]:443 ssl ipv6only=on; # managed by Certbot',
      'listen 443 ssl http2; # managed by Certbot',
      `ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem; # managed by Certbot`,
      `ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem; # managed by Certbot`,
      'include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot',
      'ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot',
      'return 301 https://$host$request_uri;',
      'return 404; # managed by Certbot',
    ]) {
      expect(site, line).toContain(line);
    }
    // The proxied server block no longer listens on plain :80 — only certbot's redirect does.
    expect(site.match(/^\s*listen 80;/gm)).toHaveLength(1);
    expect(site.match(/^server \{/gm)).toHaveLength(2);
  });
});

describe("nginx never loses its login before the service enforces cezar's (finding 2)", () => {
  it('proxy → cezar: the unit is rewritten and the service restarted BEFORE auth_basic is removed', async () => {
    writeUserUnit(true); // the running service has CEZ_AUTH=0
    const { host, runner } = fakeHost({ enforcing: false, site: nginxVhost(PORT, DOMAIN, '/etc/cezar/htpasswd', '1.24.0') });
    const ctx = ctxFor(runner, operatorUi('cezar'), { signIn: 'proxy', domain: DOMAIN, installed: true });
    await step(ctx, 'nginx-proxy').run(ctx);

    expect(readFileSync(join(home, '.config', 'systemd', 'user', 'cezar.service'), 'utf8')).not.toContain('CEZ_AUTH=0');
    const restart = host.events.indexOf('restart');
    const confirmed = host.events.indexOf('probe:401');
    const opened = host.events.indexOf('site:open');
    expect(restart, host.events.join(' ')).toBeGreaterThanOrEqual(0);
    expect(confirmed).toBeGreaterThan(restart);
    expect(opened).toBeGreaterThan(confirmed);
    expect(host.site).not.toContain('auth_basic');
  });

  it('keeps auth_basic and says so when the service cannot be confirmed to enforce sign-in', async () => {
    writeUserUnit(true);
    const before = nginxVhost(PORT, DOMAIN, '/etc/cezar/htpasswd', '1.24.0');
    // A restart that changes nothing: an older build, a unit someone else manages…
    const { host, runner } = fakeHost({ enforcing: false, restartApplies: false, site: before });
    const said: string[] = [];
    const ctx = ctxFor(runner, operatorUi('cezar', said), { signIn: 'proxy', domain: DOMAIN, installed: true });

    const err = await step(ctx, 'nginx-proxy').run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepAborted);
    expect(host.events).not.toContain('site:open');
    expect(host.site).toBe(before);
    expect((err as Error).message).toMatch(/Basic-Auth login is still in force/);
    expect((err as Error).message).toContain('"200"');
  });

  it('a fresh install writes no login-less site until its own service answers 401', async () => {
    const { host, runner } = fakeHost({ enforcing: false, restartApplies: false, site: null });
    const ctx = ctxFor(runner, operatorUi('cezar'), { domain: DOMAIN });
    await expect(step(ctx, 'nginx-proxy').run(ctx)).rejects.toBeInstanceOf(StepAborted);
    expect(host.site).toBeNull();
  });

  it('the SSL step is held to the same gate', async () => {
    const before = nginxVhost(PORT, DOMAIN, '/etc/cezar/htpasswd', '1.24.0');
    writeUserUnit(true);
    const { host, runner } = fakeHost({ enforcing: false, restartApplies: false, site: before });
    const ctx = ctxFor(runner, operatorUi('cezar'), { signIn: 'cezar', domain: DOMAIN });
    await expect(step(ctx, 'ssl').run(ctx)).rejects.toBeInstanceOf(StepAborted);
    expect(host.site).toBe(before);
  });

  it('guard: Basic-Auth in nginx needs no such proof and is written as before', async () => {
    const { host, runner } = fakeHost({ enforcing: false });
    const ctx = ctxFor(runner, operatorUi('proxy'), { domain: DOMAIN });
    await step(ctx, 'nginx-proxy').run(ctx);
    expect(host.site).toContain('auth_basic_user_file /etc/cezar/htpasswd;');
    expect(host.events).not.toContain('restart');
  });
});

describe('the service step applies a changed unit (finding 3)', () => {
  it('user unit: a changed unit restarts the running service; an unchanged one does not', async () => {
    const { host, runner } = fakeHost({ enforcing: false });
    const first = ctxFor(runner, operatorUi('proxy'), { signIn: 'proxy', domain: DOMAIN });
    await step(first, 'autostart').run(first);
    expect(host.systemctl).toContain('--user enable --now cezar.service');
    expect(host.systemctl.some((c) => c.includes('restart'))).toBe(false); // nothing was running

    host.systemctl.length = 0;
    const second = ctxFor(runner, operatorUi('cezar'), { signIn: 'cezar', domain: DOMAIN });
    await step(second, 'autostart').run(second);
    expect(host.systemctl.indexOf('--user daemon-reload')).toBeGreaterThanOrEqual(0);
    expect(host.systemctl.indexOf('--user restart cezar.service')).toBeGreaterThan(host.systemctl.indexOf('--user daemon-reload'));
    expect(host.enforcing).toBe(true);

    host.systemctl.length = 0;
    await step(second, 'autostart').run(second);
    expect(host.systemctl.some((c) => c.includes('restart'))).toBe(false);
  });

  it('system unit: the privileged command restarts when the unit on disk differs', async () => {
    const old = systemdUnit('/repo', PORT, 'system', '/usr/bin/node /x/dist/index.js', undefined, undefined, true);
    const { host, runner } = fakeHost({ userBus: false, systemUnit: old });
    const ctx = ctxFor(runner, operatorUi('cezar'), { signIn: 'cezar', domain: DOMAIN });
    await step(ctx, 'autostart').run(ctx);
    const cmd = host.sudo.find((c) => c.includes('/etc/systemd/system/cezar.service')) ?? '';
    expect(cmd).toMatch(/systemctl daemon-reload && systemctl enable cezar\.service && systemctl restart cezar\.service/);
    expect(host.systemUnit).not.toContain('CEZ_AUTH=0');
  });

  it('fails the step when the restart left the old process serving', async () => {
    writeUserUnit(true);
    const { host, runner } = fakeHost();
    const frozen = host.pid;
    const original = runner.interactive;
    runner.interactive = async (p, args, o) => {
      const code = await original(p, args, o);
      host.pid = frozen; // systemd said yes, the process never changed
      return code;
    };
    const ctx = ctxFor(runner, operatorUi('cezar'), { signIn: 'cezar', domain: DOMAIN });
    await expect(step(ctx, 'autostart').run(ctx)).rejects.toThrow(/did not actually restart/);
  });
});

describe('a site nginx rejects is not left in place (finding 4)', () => {
  /** A scratch root where the REAL generated command runs in bash, with nginx and systemctl shimmed. */
  function sandbox(opts: { nginxRejects: boolean; existing?: string }) {
    const root = mkdtempSync(join(tmpdir(), 'cez-nginx-'));
    const etc = join(root, 'etc', 'nginx');
    const bin = join(root, 'bin');
    mkdirSync(join(etc, 'sites-available'), { recursive: true });
    mkdirSync(join(etc, 'sites-enabled'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(etc, 'sites-available', 'default'), '# distro default\n');
    symlinkSync(join(etc, 'sites-available', 'default'), join(etc, 'sites-enabled', 'default'));
    if (opts.existing !== undefined) {
      writeFileSync(join(etc, 'sites-available', 'cezar'), opts.existing);
      symlinkSync(join(etc, 'sites-available', 'cezar'), join(etc, 'sites-enabled', 'cezar'));
    }
    // `nginx -t` rejects exactly the site this installer generates.
    writeFileSync(
      join(bin, 'nginx'),
      `#!/bin/sh\nif [ "$1" = "-t" ] && [ "${opts.nginxRejects ? 1 : 0}" = 1 ] && grep -qs 'Managed by cezar' ${etc}/sites-enabled/cezar; then\n` +
        `  echo 'nginx: [emerg] limit_req_zone "cez_signin_default" is already bound to key "$binary_remote_addr"' >&2; exit 1\nfi\nexit 0\n`,
    );
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${root}/systemctl.log\nexit 0\n`);
    writeFileSync(join(bin, 'apt-get'), '#!/bin/sh\nexit 0\n');
    for (const f of ['nginx', 'systemctl', 'apt-get']) chmodSync(join(bin, f), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const here = (s: string) => s.replaceAll('/etc/nginx', etc).replaceAll('/etc/cezar', join(root, 'etc', 'cezar'));
    const real = new Set(['test', 'sh', 'cmp', 'cat', 'nginx']);
    const runner: Runner = {
      capture: async (program, args, o) => {
        if (program === 'nginx' && args[0] === '-v') return { code: 0, stdout: '', stderr: 'nginx version: nginx/1.24.0\n' };
        if (program === 'openssl') return { code: 0, stdout: '$apr1$salt$hash\n', stderr: '' };
        if (!real.has(program)) return { code: 0, stdout: '', stderr: '' };
        const r = spawnSync(program, args.map(here), { env, input: o?.input, encoding: 'utf8' });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      interactive: async (program, args, o) => {
        if (program !== 'sudo') return 0;
        // The htpasswd write wants root-only chown; everything else runs for real.
        const cmd = here(String(args[2])).replace(/ && chown root:www-data \S+/, '');
        return spawnSync('bash', ['-c', cmd], { env, input: o?.input ?? '', encoding: 'utf8' }).status ?? 1;
      },
    };
    const said: string[] = [];
    const ui = {
      ...createAutoUi({}, (m) => said.push(m)),
      text: async () => 'ops',
      password: async () => 'longenough',
    } as unknown as Ui;
    const ctx: InstallContext = { ...ctxFor(runner, ui, {}), assumeYes: true, prefs: {} };
    return { root, etc, ctx, said, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('fails the step and puts the previous site back', async () => {
    const s = sandbox({ nginxRejects: true, existing: '# the site that was serving\n' });
    try {
      await expect(step(s.ctx, 'nginx-proxy').run(s.ctx)).rejects.toBeInstanceOf(StepAborted);
      expect(readFileSync(join(s.etc, 'sites-available', 'cezar'), 'utf8')).toBe('# the site that was serving\n');
      expect(existsSync(join(s.etc, 'sites-enabled', 'cezar'))).toBe(true);
      // Nothing half-applied: the distro default is still enabled and no backup is left behind.
      expect(existsSync(join(s.etc, 'sites-enabled', 'default'))).toBe(true);
      expect(existsSync(join(s.etc, 'sites-available', 'cezar.cezar-bak'))).toBe(false);
      expect(existsSync(join(s.root, 'systemctl.log'))).toBe(false); // nginx was never reloaded
      expect(s.said.join('\n')).toMatch(/previous site was put back/);
    } finally {
      s.cleanup();
    }
  });

  it('on a first install the rejected file is removed, not left enabled', async () => {
    const s = sandbox({ nginxRejects: true });
    try {
      await expect(step(s.ctx, 'nginx-proxy').run(s.ctx)).rejects.toBeInstanceOf(StepAborted);
      expect(existsSync(join(s.etc, 'sites-available', 'cezar'))).toBe(false);
      expect(existsSync(join(s.etc, 'sites-enabled', 'cezar'))).toBe(false);
      expect(existsSync(join(s.etc, 'sites-enabled', 'default'))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  it('guard: an accepted site is installed, enabled and reloaded', async () => {
    const s = sandbox({ nginxRejects: false, existing: '# the site that was serving\n' });
    try {
      await step(s.ctx, 'nginx-proxy').run(s.ctx);
      expect(readFileSync(join(s.etc, 'sites-available', 'cezar'), 'utf8')).toContain('Managed by cezar');
      expect(existsSync(join(s.etc, 'sites-enabled', 'default'))).toBe(false);
      expect(existsSync(join(s.etc, 'sites-available', 'cezar.cezar-bak'))).toBe(false);
      expect(readFileSync(join(s.root, 'systemctl.log'), 'utf8')).toContain('reload nginx');
    } finally {
      s.cleanup();
    }
  });
});

describe('request bodies (finding 5)', () => {
  it("both sites raise nginx's 1 MB default to cezar's own body limit", () => {
    for (const htpasswd of [null, '/etc/cezar/htpasswd']) {
      expect(nginxVhost(PORT, DOMAIN, htpasswd, '1.24.0')).toMatch(/^\s*client_max_body_size 32m;$/m);
    }
    // The number is the server's: drift here means uploads fail only on a hosted install.
    const server = readFileSync(fileURLToPath(new URL('../../server/server.ts', import.meta.url)), 'utf8');
    expect(server).toMatch(/const GLOBAL_BODY_LIMIT = 32 \* 1024 \* 1024;/);
  });
});
