import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PreviewGateways, TICKET_PARAM } from './gateway.ts';

/**
 * Spec `2026-10-12-cockpit-authentication.md` §7: cookies are host-scoped, not port-scoped, so the
 * previewed app's ANSWER must not be able to set, replace or delete the cockpit's session cookie.
 */

let app: Server;
let appOrigin: string;
let gateways: PreviewGateways;
let upgraded: Duplex[];
let answerHeaders: Record<string, string | string[]>;
let upgradeHead: string;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function freePort(): Promise<number> {
  const holder = createServer();
  const port = await listen(holder);
  await new Promise((done) => holder.close(done));
  return port;
}

async function enter(): Promise<{ origin: string; cookie: string }> {
  const opened = await gateways.open({ target: appOrigin, parentOrigin: 'http://127.0.0.1:4321' });
  if (!opened.ok) throw new Error(opened.reason);
  const res = await fetch(`${opened.origin}/?${TICKET_PARAM}=${opened.ticket}`, { redirect: 'manual' });
  return { origin: opened.origin, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

beforeEach(async () => {
  upgraded = [];
  answerHeaders = {};
  upgradeHead = '';
  app = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', ...answerHeaders }).end('ok');
  });
  app.on('upgrade', (_req, socket) => {
    upgraded.push(socket);
    socket.write(upgradeHead);
  });
  appOrigin = `http://127.0.0.1:${await listen(app)}`;
  gateways = new PreviewGateways({ ports: [await freePort()] });
});

afterEach(async () => {
  gateways.closeAll();
  for (const socket of upgraded) socket.destroy();
  app.closeAllConnections();
  await new Promise((done) => app.close(done));
});

describe('preview gateway — the app cannot touch the cockpit session cookie', () => {
  it('drops the session cookie names from Set-Cookie and keeps the app’s own cookies verbatim', async () => {
    answerHeaders = {
      'set-cookie': [
        '__Host-cez_session=planted; Secure; Path=/; HttpOnly',
        'cez_session=planted; Path=/',
        '__Host-cez_session=; Max-Age=0; Secure; Path=/',
        ' cez_session =spaced; Path=/',
        '=__Host-cez_session=nameless; Secure; Path=/',
        'theme=dark; Path=/; SameSite=Lax',
        'cez_session_other=fine; Path=/',
      ],
    };
    const { origin, cookie } = await enter();
    const res = await fetch(`${origin}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(['theme=dark; Path=/; SameSite=Lax', 'cez_session_other=fine; Path=/']);
  });

  it('sends no Set-Cookie at all when the session cookie was the only one', async () => {
    answerHeaders = { 'set-cookie': '__Host-cez_session=planted; Secure; Path=/' };
    const { origin, cookie } = await enter();
    const res = await fetch(`${origin}/`, { headers: { cookie } });
    expect(res.headers.has('set-cookie')).toBe(false);
  });

  it('neutralises Clear-Site-Data directives that would clear the host’s cookies', async () => {
    const { origin, cookie } = await enter();
    const answered = async (value: string) => {
      answerHeaders = { 'clear-site-data': value };
      return (await fetch(`${origin}/`, { headers: { cookie } })).headers.get('clear-site-data');
    };
    expect(await answered('"cookies"')).toBeNull();
    expect(await answered('"cache", "cookies", "storage"')).toBe('"cache", "storage"');
    expect(await answered('"*"')).toBe('"cache", "storage", "executionContexts"');
    expect(await answered('"COOKIES"')).toBeNull();
  });

  // Guard: passes with and without the fix — everything else stays byte-identical.
  it('leaves a cookie-free Clear-Site-Data and ordinary headers untouched', async () => {
    answerHeaders = { 'clear-site-data': '"cache","storage"', 'set-cookie': ['a=1; Path=/', 'b=2'], 'x-app': 'yes' };
    const { origin, cookie } = await enter();
    const res = await fetch(`${origin}/`, { headers: { cookie } });
    expect(res.headers.get('clear-site-data')).toBe('"cache","storage"');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2']);
    expect(res.headers.get('x-app')).toBe('yes');
  });

  it('filters the handshake answer of a WebSocket upgrade too, and splices the rest byte for byte', async () => {
    upgradeHead = [
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Set-Cookie: __Host-cez_session=planted; Secure; Path=/',
      'Set-Cookie: hmr=1; Path=/',
      'Clear-Site-Data: "cookies"',
      '',
      'hello',
    ].join('\r\n');
    const { origin, cookie } = await enter();
    const socket = connect(Number(new URL(origin).port), '127.0.0.1');
    const received = await new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += String(chunk);
        if (data.endsWith('hello')) resolve(data);
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(data));
      socket.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    socket.destroy();
    expect(received).toBe(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: hmr=1; Path=/\r\n\r\nhello',
    );
  });
});
