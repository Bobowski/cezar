import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HMR_STATUS_PATH, PreviewGateways, TICKET_PARAM, hmrStateOf, isHmrUpgrade, parsePreviewPorts } from './gateway.ts';

/**
 * The preview gateway against a real loopback app (spec `2026-10-10-preview-gateway`). Real
 * sockets on purpose: what is under test is which requests reach the app and what they carry.
 */

let app: Server;
let appOrigin: string;
let seen: IncomingHttpHeaders[];
let gateways: PreviewGateways;
let pool: number[];
/** An upgraded socket has left the HTTP server's care: closing the server does not close it. */
let upgraded: Duplex[];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Ports nothing holds right now: bound once to learn them, then released. */
async function freePorts(count: number): Promise<number[]> {
  const holders = Array.from({ length: count }, () => createServer());
  const ports = await Promise.all(holders.map(listen));
  await Promise.all(holders.map((holder) => new Promise((done) => holder.close(done))));
  return ports;
}

/** Open a preview and trade its ticket for the cookie, the way a framed page load does. */
async function enter(target = appOrigin): Promise<{ origin: string; cookie: string }> {
  const opened = await gateways.open({ target, parentOrigin: 'http://127.0.0.1:4321' });
  if (!opened.ok) throw new Error(opened.reason);
  const res = await fetch(`${opened.origin}/?${TICKET_PARAM}=${opened.ticket}`, { redirect: 'manual' });
  return { origin: opened.origin, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

beforeEach(async () => {
  seen = [];
  upgraded = [];
  app = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/moved') {
      res.writeHead(302, { location: `${appOrigin}/landed` }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`app saw ${req.url}`);
  });
  app.on('upgrade', (_req, socket) => {
    upgraded.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello');
  });
  appOrigin = `http://127.0.0.1:${await listen(app)}`;
  pool = await freePorts(2);
  gateways = new PreviewGateways({ ports: pool });
});

afterEach(async () => {
  gateways.closeAll();
  for (const socket of upgraded) socket.destroy();
  app.closeAllConnections();
  await new Promise((done) => app.close(done));
});

describe('parsePreviewPorts', () => {
  it('reads ranges and lists, in order, once each', () => {
    expect(parsePreviewPorts('8500-8502, 8501,9000')).toEqual([8500, 8501, 8502, 9000]);
  });

  it('is empty for nothing, and drops what is not an unprivileged port', () => {
    expect(parsePreviewPorts(undefined)).toEqual([]);
    expect(parsePreviewPorts('')).toEqual([]);
    expect(parsePreviewPorts('80, 443, nope, 70000, 8500')).toEqual([8500]);
  });
});

describe('PreviewGateways', () => {
  it('does not exist without ports', async () => {
    const none = new PreviewGateways({ ports: [] });
    expect(await none.open({ target: appOrigin, parentOrigin: 'https://cezar.example.com' })).toMatchObject({
      ok: false,
      code: 'disabled',
    });
    expect(none.size).toBe(0);
  });

  it('is reached at the cockpit’s scheme and hostname, on a pool port', async () => {
    const opened = await gateways.open({ target: appOrigin, parentOrigin: 'https://cezar.example.com' });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const url = new URL(opened.origin);
    expect(`${url.protocol}//${url.hostname}`).toBe('https://cezar.example.com');
    expect(pool).toContain(Number(url.port));
  });

  it('names the port the FRONT answers on when that differs from the one it listens on', async () => {
    const mapped = new PreviewGateways({ ports: pool, publicPorts: [8500, 8501] });
    try {
      const opened = await mapped.open({ target: appOrigin, parentOrigin: 'https://cezar.example.com' });
      if (!opened.ok) throw new Error(opened.reason);
      expect(['https://cezar.example.com:8500', 'https://cezar.example.com:8501']).toContain(opened.origin);
      // Reached on the port it really listens on, it still authenticates.
      const listening = pool[[8500, 8501].indexOf(Number(new URL(opened.origin).port))]!;
      const res = await fetch(`http://127.0.0.1:${listening}/?${TICKET_PARAM}=${opened.ticket}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
    } finally {
      mapped.closeAll();
    }
  });

  it('refuses anything that is not a loopback http app, and cezar itself', async () => {
    const parentOrigin = 'http://127.0.0.1:4321';
    expect(await gateways.open({ target: 'https://example.com', parentOrigin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await gateways.open({ target: 'http://10.0.0.5:3000', parentOrigin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await gateways.open({ target: 'http://localhost:4321', parentOrigin, forbiddenPorts: [4321] })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    // Another gateway port: a preview of a preview would be a way around its ticket.
    expect(await gateways.open({ target: `http://127.0.0.1:${pool[0]}`, parentOrigin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(gateways.size).toBe(0);
  });

  it('answers 401 to a request with no ticket and no cookie, and never reaches the app', async () => {
    const opened = await gateways.open({ target: appOrigin, parentOrigin: 'http://127.0.0.1:4321' });
    if (!opened.ok) throw new Error(opened.reason);
    expect((await fetch(`${opened.origin}/`)).status).toBe(401);
    expect((await fetch(`${opened.origin}/?${TICKET_PARAM}=guess`)).status).toBe(401);
    expect((await fetch(`${opened.origin}/`, { headers: { cookie: `__cez_pv_${new URL(opened.origin).port}=guess` } })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('trades a ticket for a cookie once, and strips it from the address', async () => {
    const opened = await gateways.open({ target: appOrigin, parentOrigin: 'http://127.0.0.1:4321' });
    if (!opened.ok) throw new Error(opened.reason);
    const url = `${opened.origin}/page?tab=2&${TICKET_PARAM}=${opened.ticket}`;

    const first = await fetch(url, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/page?tab=2');
    expect(first.headers.get('set-cookie')).toMatch(/^__cez_pv_\d+=.+; Path=\/; HttpOnly; SameSite=Lax$/);

    // The same ticket again, from someone without the cookie.
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('serves the app to a request carrying the cookie, as the app expects to be addressed', async () => {
    const { origin, cookie } = await enter();
    const res = await fetch(`${origin}/hello`, {
      headers: { cookie: `session=abc; ${cookie}`, origin },
    });
    expect(await res.text()).toBe('app saw /hello');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.host).toBe(new URL(appOrigin).host);
    expect(seen[0]!.origin).toBe(appOrigin);
    // The app's own cookie arrives; the gateway's never does.
    expect(seen[0]!.cookie).toBe('session=abc');
  });


  it('never hands the app the cockpit\u2019s own session cookie', async () => {
    // Cookies ignore the port, so the browser sends it here (spec 2026-10-12-cockpit-authentication §7).
    const { origin, cookie } = await enter();
    seen.length = 0;
    await fetch(`${origin}/`, {
      headers: { cookie: `__Host-cez_session=s3cret; session=abc; cez_session=plain; ${cookie}`, origin },
    });
    expect(seen[0]!.cookie).toBe('session=abc');
  });
  it('leaves a foreign Origin exactly as the browser sent it', async () => {
    const { origin, cookie } = await enter();
    await fetch(`${origin}/`, { headers: { cookie, origin: 'https://evil.example' } });
    expect(seen[0]!.origin).toBe('https://evil.example');
  });

  it('keeps the app’s own redirects inside the gateway', async () => {
    const { origin, cookie } = await enter();
    const res = await fetch(`${origin}/moved`, { headers: { cookie }, redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`${origin}/landed`);
  });

  it('gives one preview’s cookie no power over another', async () => {
    const other = createServer((_req, res) => res.end('other app'));
    const otherOrigin = `http://127.0.0.1:${await listen(other)}`;
    try {
      const first = await enter();
      const second = await enter(otherOrigin);
      expect(second.origin).not.toBe(first.origin);
      const value = first.cookie.split('=')[1];
      const forged = `__cez_pv_${new URL(second.origin).port}=${value}`;
      expect((await fetch(`${second.origin}/`, { headers: { cookie: forged } })).status).toBe(401);
      expect((await fetch(`${second.origin}/`, { headers: { cookie: first.cookie } })).status).toBe(401);
    } finally {
      other.closeAllConnections();
      await new Promise((done) => other.close(done));
    }
  });

  it('reuses the listener for the same app, and gives up the idle one when the pool is full', async () => {
    const one = new PreviewGateways({ ports: [pool[0]!] });
    const other = createServer((_req, res) => res.end('other app'));
    const otherOrigin = `http://127.0.0.1:${await listen(other)}`;
    try {
      const parentOrigin = 'http://127.0.0.1:4321';
      const a = await one.open({ target: appOrigin, parentOrigin });
      const again = await one.open({ target: appOrigin, parentOrigin });
      expect(a.ok && again.ok && a.origin === again.origin && a.ticket !== again.ticket).toBe(true);
      expect(one.size).toBe(1);

      expect(await one.open({ target: otherOrigin, parentOrigin })).toMatchObject({ ok: true });
      expect(one.size).toBe(1);
    } finally {
      one.closeAll();
      other.closeAllConnections();
      await new Promise((done) => other.close(done));
    }
  });

  it('splices a WebSocket upgrade through for the cookie holder, and drops anyone else', async () => {
    const { origin, cookie } = await enter();
    const port = Number(new URL(origin).port);
    const upgrade = (headers: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, '127.0.0.1');
        let data = '';
        const finish = () => {
          socket.destroy();
          resolve(data);
        };
        socket.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('hello')) finish();
        });
        socket.on('close', finish);
        socket.on('error', finish);
        socket.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${headers}\r\n`);
      });

    expect(await upgrade('')).toBe('');
    expect(await upgrade(`Cookie: ${cookie}\r\n`)).toContain('101 Switching Protocols');
  });
});

describe('the upgrade log behind HMR_STATUS_PATH (spec 2026-10-24-cockpit-polish §3.2)', () => {
  const status = async (origin: string, cookie: string) => {
    const res = await fetch(`${origin}${HMR_STATUS_PATH}`, { headers: { cookie, origin: 'http://127.0.0.1:4321' } });
    return { status: res.status, cors: res.headers.get('access-control-allow-origin'), body: res.status === 200 ? await res.json() : null };
  };
  const page = (origin: string, cookie: string, path = '/') =>
    fetch(`${origin}${path}`, { headers: { cookie, 'sec-fetch-dest': path === '/' ? 'iframe' : 'script' } }).then((res) => res.text());
  /** One upgrade through the gateway; resolves once the app answered or the socket closed. */
  const upgrade = (origin: string, cookie: string, { path = '/', protocol = 'vite-hmr' as string | null } = {}) =>
    new Promise<void>((resolve) => {
      const port = Number(new URL(origin).port);
      const socket = connect(port, '127.0.0.1');
      socket.on('data', () => resolve());
      socket.on('close', () => resolve());
      socket.on('error', () => resolve());
      const proto = protocol === null ? '' : `Sec-WebSocket-Protocol: ${protocol}\r\n`;
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${proto}Cookie: ${cookie}\r\n\r\n`);
      upgraded.push(socket);
    });

  it('answers only a session holder, with CORS for the cockpit alone', async () => {
    const { origin, cookie } = await enter();
    expect((await status(origin, '')).status).toBe(401);
    const before = seen.length;
    expect(await status(origin, cookie)).toEqual({ status: 200, cors: 'http://127.0.0.1:4321', body: { hmr: 'none' } });
    // The gateway's own path never reaches the app.
    expect(seen.length).toBe(before);
  });

  it('a page with no hot reload is `none`; one whose socket came up is `connected`', async () => {
    const { origin, cookie } = await enter();
    await page(origin, cookie);
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'none' });
    await upgrade(origin, cookie);
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'connected' });
  });

  it('Vite’s client with no socket, or a refused upgrade, is `blocked` — and a new page starts over', async () => {
    const { origin, cookie } = await enter();
    await page(origin, cookie);
    await page(origin, cookie, '/@vite/client');
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'blocked' });
    await page(origin, cookie);
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'none' });

    app.removeAllListeners('upgrade');
    app.on('upgrade', (_req, socket) => {
      upgraded.push(socket);
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    });
    await upgrade(origin, cookie);
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'blocked' });
  });

  it('the app’s own WebSocket is not hot reload: it neither connects nor blocks', async () => {
    const { origin, cookie } = await enter();
    await page(origin, cookie);
    await upgrade(origin, cookie, { path: '/socket', protocol: null });
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'none' });

    app.removeAllListeners('upgrade');
    app.on('upgrade', (_req, socket) => {
      upgraded.push(socket);
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    });
    await upgrade(origin, cookie, { path: '/socket', protocol: 'graphql-ws' });
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'none' });
  });

  it('knows Next’s and webpack’s hot-reload sockets by their path', async () => {
    const { origin, cookie } = await enter();
    await page(origin, cookie);
    await upgrade(origin, cookie, { path: '/_next/webpack-hmr', protocol: null });
    expect((await status(origin, cookie)).body).toEqual({ hmr: 'connected' });
    const req = (url: string, protocol?: string) => ({ url, headers: protocol ? { 'sec-websocket-protocol': protocol } : {} });
    expect(isHmrUpgrade(req('/__webpack_hmr'))).toBe(true);
    expect(isHmrUpgrade(req('/sockjs-node/123/abc/websocket'))).toBe(true);
    expect(isHmrUpgrade(req('/vite-hmr?token=x'))).toBe(true);
    expect(isHmrUpgrade(req('/', 'vite-ping'))).toBe(true);
    expect(isHmrUpgrade(req('/ws'))).toBe(false);
    expect(isHmrUpgrade(req('/live', 'graphql-ws'))).toBe(false);
  });

  it('reads the log', () => {
    expect(hmrStateOf({ viteClient: false, connected: false, failed: false }, 0)).toBe('none');
    expect(hmrStateOf({ viteClient: true, connected: false, failed: false }, 0)).toBe('blocked');
    expect(hmrStateOf({ viteClient: true, connected: false, failed: true }, 1)).toBe('connected');
  });
});
