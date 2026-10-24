import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PreviewGateways, TICKET_PARAM, withoutFrameBusting } from './gateway.ts';
import { PICKER_PATH } from './picker-script.ts';

/**
 * Design Mode through the preview gateway (spec `2026-10-24-design-mode-third-cut` §3.4): a slot
 * opened with `designMode: true` re-serves the same loopback app with the picker injected and the
 * frame-busting headers stripped, behind the same ticket-then-cookie session as a plain preview.
 */

let app: Server;
let appOrigin: string;
let gateways: PreviewGateways;

const PAGE = '<!doctype html><html><head><title>t</title></head><body>hi</body></html>';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function freePorts(count: number): Promise<number[]> {
  const holders = Array.from({ length: count }, () => createServer());
  const ports = await Promise.all(holders.map(listen));
  await Promise.all(holders.map((holder) => new Promise((done) => holder.close(done))));
  return ports;
}

async function enter(designMode: boolean): Promise<{ origin: string; cookie: string }> {
  const opened = await gateways.open({ target: appOrigin, parentOrigin: 'http://127.0.0.1:4321', designMode });
  if (!opened.ok) throw new Error(opened.reason);
  const res = await fetch(`${opened.origin}/?${TICKET_PARAM}=${opened.ticket}`, { redirect: 'manual' });
  return { origin: opened.origin, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! };
}

beforeEach(async () => {
  app = createServer((req, res) => {
    if (req.url === '/two-policies') {
      // Two CSP header lines: Node hands them over joined by a comma.
      res.setHeader('content-type', 'text/plain');
      res.setHeader('content-security-policy', ["default-src 'self'", "frame-ancestors 'none'; img-src *"]);
      res.writeHead(200).end('2');
      return;
    }
    if (req.url === '/script.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'x-frame-options': 'DENY' }).end('1');
      return;
    }
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'; img-src *",
      })
      .end(PAGE);
  });
  appOrigin = `http://127.0.0.1:${await listen(app)}`;
  gateways = new PreviewGateways({ ports: await freePorts(3) });
});

afterEach(async () => {
  gateways.closeAll();
  app.closeAllConnections();
  await new Promise((done) => app.close(done));
});

describe('a gateway slot in design mode', () => {
  it('injects the picker into the app’s HTML and strips what forbids framing it', async () => {
    const { origin, cookie } = await enter(true);
    const res = await fetch(`${origin}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<script src="${PICKER_PATH}" data-cezar-design></script>`);
    expect(body.indexOf(PICKER_PATH)).toBeLessThan(body.indexOf('<title>'));
    expect(res.headers.get('x-frame-options')).toBeNull();
    // Only the directive that forbids framing goes; the rest of the app's policy holds, and a
    // policy of cezar's own lets the cockpit — and only the cockpit — frame it.
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'; img-src *, frame-ancestors http://127.0.0.1:4321");
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body));
  });

  it('serves the picker, configured for the cockpit and naming the app’s own origin', async () => {
    const { origin, cookie } = await enter(true);
    const res = await fetch(`${origin}${PICKER_PATH}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const script = await res.text();
    expect(script).toContain('"parentOrigin":"http://127.0.0.1:4321"');
    expect(script).toContain(`"upstreamOrigin":"${appOrigin}"`);
  });

  it('keeps the same session: no cookie, no page and no picker', async () => {
    const opened = await gateways.open({ target: appOrigin, parentOrigin: 'http://127.0.0.1:4321', designMode: true });
    if (!opened.ok) throw new Error(opened.reason);
    expect((await fetch(`${opened.origin}/`)).status).toBe(401);
    expect((await fetch(`${opened.origin}${PICKER_PATH}`)).status).toBe(401);
  });

  it('strips frame-busting from every answer, not only HTML', async () => {
    const { origin, cookie } = await enter(true);
    const res = await fetch(`${origin}/script.js`, { headers: { cookie } });
    expect(await res.text()).toBe('1');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('lets only the cockpit frame it, even when the app sent no policy of its own', async () => {
    const { origin, cookie } = await enter(true);
    const res = await fetch(`${origin}/script.js`, { headers: { cookie } });
    expect(res.headers.get('content-security-policy')).toBe('frame-ancestors http://127.0.0.1:4321');
  });

  it('is a slot of its own: a plain preview of the same app stays untouched', async () => {
    const design = await enter(true);
    const plain = await enter(false);
    expect(plain.origin).not.toBe(design.origin);
    const res = await fetch(`${plain.origin}/`, { headers: { cookie: plain.cookie } });
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    // And a plain slot does not hand out the picker.
    const picker = await fetch(`${plain.origin}${PICKER_PATH}`, { headers: { cookie: plain.cookie } });
    expect(await picker.text()).toBe(PAGE);
  });

  it('reuses the design slot for the same app and cockpit', async () => {
    const first = await enter(true);
    const second = await enter(true);
    expect(second.origin).toBe(first.origin);
    expect(gateways.size).toBe(1);
  });
});

describe('withoutFrameBusting', () => {
  const COCKPIT = 'https://cockpit.example';

  it('removes frame-ancestors from a comma-joined policy list as well as a semicolon-joined one', () => {
    const out = withoutFrameBusting({ 'content-security-policy': "default-src 'self', frame-ancestors 'none'; img-src *" }, COCKPIT);
    expect(out['content-security-policy']).toBe(`default-src 'self', img-src *, frame-ancestors ${COCKPIT}`);
  });

  it('drops a policy that only forbade framing, and keeps one it cannot read', () => {
    const out = withoutFrameBusting({ 'content-security-policy': ["frame-ancestors 'none'", 'sandbox allow-scripts'] }, COCKPIT);
    expect(out['content-security-policy']).toBe(`sandbox allow-scripts, frame-ancestors ${COCKPIT}`);
  });

  it('strips it through the gateway when the app sends two policy headers', async () => {
    const { origin, cookie } = await enter(true);
    const res = await fetch(`${origin}/two-policies`, { headers: { cookie } });
    expect(await res.text()).toBe('2');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self', img-src *, frame-ancestors http://127.0.0.1:4321");
  });
});
