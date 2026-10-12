import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewGateways, TICKET_PARAM } from './gateway.ts';

/**
 * Spec `2026-10-10-preview-gateway` §4: a ticket is spent whenever it is presented and never
 * reaches the app; the cookie is a session of its own per ticket, expiring and bounded.
 */

let app: Server;
let appOrigin: string;
let appPort: number;
let seen: { url: string; headers: IncomingHttpHeaders }[];
let gateways: PreviewGateways;

const PARENT = 'http://127.0.0.1:4321';

async function ticketFor(): Promise<{ origin: string; ticket: string }> {
  const opened = await gateways.open({ target: appOrigin, parentOrigin: PARENT });
  if (!opened.ok) throw new Error(opened.reason);
  return opened;
}

/** A browser's first load: the ticket traded for that browser's cookie. */
async function enter(): Promise<{ origin: string; cookie: string }> {
  const { origin, ticket } = await ticketFor();
  const res = await fetch(`${origin}/?${TICKET_PARAM}=${ticket}`, { redirect: 'manual' });
  return { origin, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

beforeEach(async () => {
  seen = [];
  app = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/elsewhere') {
      // Another app whose port merely STARTS with this one's.
      res.writeHead(302, { location: `http://127.0.0.1:${appPort}1/landed?x=1` }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`app saw ${req.url}`);
  });
  appPort = await new Promise<number>((resolve) => app.listen(0, '127.0.0.1', () => resolve((app.address() as AddressInfo).port)));
  appOrigin = `http://127.0.0.1:${appPort}`;
  gateways = new PreviewGateways({ ports: [0] });
});

afterEach(async () => {
  vi.useRealTimers();
  gateways.closeAll();
  app.closeAllConnections();
  await new Promise((done) => app.close(done));
});

describe('preview gateway — a presented ticket is always spent', () => {
  it('spends and strips a ticket that arrives WITH a valid cookie, and the app never sees it', async () => {
    const { origin, cookie } = await enter();
    // The cockpit asks for a ticket before every load, so a reload carries both.
    const { ticket } = await ticketFor();

    const reload = await fetch(`${origin}/page?tab=2&${TICKET_PARAM}=${ticket}`, { headers: { cookie }, redirect: 'manual' });
    expect(reload.status).toBe(302);
    expect(reload.headers.get('location')).toBe('/page?tab=2');
    expect(seen).toEqual([]);

    // Spent: it opens nothing for someone without the cookie.
    const replay = await fetch(`${origin}/page?${TICKET_PARAM}=${ticket}`, { redirect: 'manual' });
    expect(replay.status).toBe(401);
    expect(replay.headers.has('set-cookie')).toBe(false);
  });

  it('keeps a ticket out of the Referer the app receives', async () => {
    const { origin, cookie } = await enter();
    await fetch(`${origin}/asset.js`, { headers: { cookie, referer: `${origin}/page?tab=2&${TICKET_PARAM}=abc` } });
    expect(seen[0]!.url).toBe('/asset.js');
    expect(seen[0]!.headers.referer).toBe(`${appOrigin}/page?tab=2`);
  });
});

describe('preview gateway — the cookie is a session per ticket', () => {
  it('gives each browser its own session value', async () => {
    const first = await enter();
    const second = await enter();
    expect(second.cookie).not.toBe(first.cookie);
    expect((await fetch(`${first.origin}/`, { headers: { cookie: first.cookie } })).status).toBe(200);
    expect((await fetch(`${first.origin}/`, { headers: { cookie: second.cookie } })).status).toBe(200);
  });

  it('expires a session nothing has used, and one that outlived its cap however busy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { origin, cookie } = await enter();
    const status = async () => (await fetch(`${origin}/`, { headers: { cookie } })).status;

    // Use keeps it alive…
    for (let i = 0; i < 40; i += 1) {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await status()).toBe(200);
    }
    // …but not past the cap,
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
    expect(await status()).toBe(401);

    // and an idle one ends on its own.
    const idle = await enter();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect((await fetch(`${idle.origin}/`, { headers: { cookie: idle.cookie } })).status).toBe(401);
  });

  it('bounds the sessions a listener holds: the oldest gives way', async () => {
    const oldest = await enter();
    for (let i = 0; i < 40; i += 1) await enter();
    expect((await fetch(`${oldest.origin}/`, { headers: { cookie: oldest.cookie } })).status).toBe(401);
  });
});

describe('preview gateway — the app’s redirects', () => {
  it('leaves a redirect to a port that only starts with the app’s port alone', async () => {
    const { origin, cookie } = await enter();
    const res = await fetch(`${origin}/elsewhere`, { headers: { cookie }, redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`http://127.0.0.1:${appPort}1/landed?x=1`);
  });
});
