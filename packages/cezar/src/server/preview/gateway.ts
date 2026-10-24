import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { PLAIN_SESSION_COOKIE, SECURE_SESSION_COOKIE } from '../../auth/guard.ts';
import { parseDesignTarget, relayWithPicker } from './design-proxy.ts';
import { PICKER_PATH, pickerScript } from './picker-script.ts';

/**
 * The preview gateway (spec `.ai/specs/2026-10-10-preview-gateway.md`).
 *
 * On a hosted cockpit a task's app listens on the HOST's loopback, which the viewer's browser
 * cannot reach — `http://localhost:3000` there means the viewer's own machine. The gateway
 * re-serves one such app on a port the front in front of cezar forwards, so the Browser column
 * can frame it.
 *
 * Why this is not the proxy spec `2026-10-07-task-workspace` §7 refused, each load-bearing:
 *
 *  - It is NEVER on the cockpit's origin. Every app gets a port of its own, and a different port
 *    is a different origin: a framed page cannot read the cockpit, and the API's request-origin
 *    guard refuses its mutating requests like any other foreign origin's.
 *  - It listens only on ports an operator named (`CEZ_PREVIEW_PORTS`). Unset, there is no
 *    gateway and nothing listens — the exposure is opted into by whoever configures the front.
 *  - It authenticates every request itself. The front's login covers the cockpit, not these
 *    ports, so a preview is opened with a one-time ticket only the authenticated cockpit can
 *    obtain, exchanged for a cookie scoped to that one port. No ticket, no cookie: 401.
 *  - It forwards ONLY to the loopback origin it was opened for, and never to cezar itself or to
 *    another gateway port. It is not an open proxy.
 *
 * Lifetime — every way a listener stops: nothing has used it for `idleMs` and it holds no live
 * socket; it is the least recently used when the pool is full; or the server shuts down
 * (`closeAll`). Nothing is written to disk.
 */

/** Hop-by-hop headers: they describe one connection and must not be copied onto the next. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/** A handshake answer's head is small; one that never ends is not relayed unread. */
const UPGRADE_HEAD_CAP = 64 * 1024;

/**
 * One header of the app's ANSWER, as the browser may have it. Cookies ignore the port, so an app
 * could otherwise set, replace or delete the cockpit's session cookie on this hostname (spec
 * 2026-10-12-cockpit-authentication §7). `undefined` drops the header; anything else is verbatim.
 */
function answerHeader(name: string, value: string | string[]): string | string[] | undefined {
  if (name === 'set-cookie') {
    const kept = (Array.isArray(value) ? value : [value]).filter((cookie) => {
      // A leading `=` is a nameless cookie, which a browser sends back as its bare value.
      const cookieName = cookie.replace(/^[\s=]+/, '').split('=')[0]!.trim();
      return cookieName !== SECURE_SESSION_COOKIE && cookieName !== PLAIN_SESSION_COOKIE;
    });
    if (kept.length === 0) return undefined;
    return Array.isArray(value) ? (kept.length === value.length ? value : kept) : value;
  }
  if (name === 'clear-site-data') {
    const joined = Array.isArray(value) ? value.join(', ') : value;
    if (!/"(cookies|\*)"/i.test(joined)) return value;
    // `"cookies"` clears the whole host's; `"*"` is narrowed to what is scoped to this origin.
    const kept = joined.split(',').map((directive) => directive.trim()).flatMap((directive) => {
      const lower = directive.toLowerCase();
      if (lower === '"cookies"') return [];
      return lower === '"*"' ? ['"cache"', '"storage"', '"executionContexts"'] : [directive];
    });
    return kept.length > 0 ? kept.join(', ') : undefined;
  }
  return value;
}

/**
 * The app's answer framed by the cockpit and nothing else: the app's `X-Frame-Options` and CSP
 * `frame-ancestors` go, a policy of cezar's own — `frame-ancestors <cockpit>` — takes their place,
 * and the rest of the app's policy stays as sent (spec 2026-10-24-design-mode-third-cut §3.4).
 */
export function withoutFrameBusting(answer: Record<string, string | string[]>, parentOrigin: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const policies: string[] = [];
  for (const [name, value] of Object.entries(answer)) {
    if (name === 'x-frame-options') continue;
    if (name !== 'content-security-policy') {
      out[name] = value;
      continue;
    }
    // Node joins repeated CSP headers with `,`, which is also the policy-list separator; no
    // directive value may contain one, so the split is exact.
    for (const policy of (Array.isArray(value) ? value : [value]).flatMap((each) => each.split(','))) {
      const directives = policy.split(';').map((directive) => directive.trim()).filter((directive) => directive !== '' && !/^frame-ancestors(\s|$)/i.test(directive));
      if (directives.length > 0) policies.push(directives.join('; '));
    }
  }
  // Every policy in the list is enforced, so this one bounds framing whatever the app's say.
  out['content-security-policy'] = [...policies, `frame-ancestors ${parentOrigin}`].join(', ');
  return out;
}

/** The query parameter a ticket rides in on. Stripped by the redirect that follows. */
export const TICKET_PARAM = '__cez_preview';
const TICKET_TTL_MS = 60_000;
/** Outstanding tickets per app. A cockpit asks before every load, so this only bounds abuse. */
const MAX_TICKETS = 32;
// A cookie is one browser's session, not the listener's secret (spec 2026-10-10-preview-gateway
// §4). Nothing tells the gateway about a cockpit sign-out, so an unused session ends by itself.
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_MAX_MS = 8 * 60 * 60_000;
const MAX_SESSIONS = 32;

/** One browser's session. `sockets` are the upgrades it authorised that are still open. */
interface Session {
  born: number;
  used: number;
  sockets: Set<Duplex>;
}

/** `url` without the ticket parameter, or null when it carries none (or is not a URL). */
function withoutTicket(url: string): URL | null {
  if (!url.includes(TICKET_PARAM)) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(TICKET_PARAM)) return null;
    parsed.searchParams.delete(TICKET_PARAM);
    return parsed;
  } catch {
    return null;
  }
}

export type PreviewGatewayResult =
  | { ok: true; origin: string; ticket: string }
  | { ok: false; code: 'disabled' | 'invalid' | 'busy'; reason: string };

export interface PreviewGatewaysOptions {
  /** The ports the gateway may listen on. Empty: the gateway does not exist. */
  ports: readonly number[];
  /**
   * The port a browser reaches each of those at, position for position, when the front in front
   * of cezar cannot use the same number — a front on the same host cannot bind a port cezar
   * already holds. Absent, or of a different length: the same numbers.
   */
  publicPorts?: readonly number[];
  /** The interface to bind — the one cezar itself is bound to, so the same front reaches both. */
  bindHost?: string;
  idleMs?: number;
}

interface Entry {
  upstream: URL;
  /** A design-mode slot (spec 2026-10-24-design-mode-third-cut §3.4): the picker injected, the
   *  frame-busting headers stripped. A slot of its own, so a plain preview is never touched. */
  design: boolean;
  /** The cockpit's origin — the one window the injected picker posts to and obeys. */
  parentOrigin: string;
  /** The origin a browser reaches this listener at: the cockpit's scheme and hostname, this port. */
  publicOrigin: string;
  server: Server;
  port: number;
  tickets: Map<string, number>;
  /** Session value → when it was minted and last used. Oldest first. */
  sessions: Map<string, Session>;
  lastUsed: number;
  sockets: Set<Duplex>;
}

/**
 * `8500-8519`, `8500,8501`, or a mix → the ports, in order, without duplicates. Anything that is
 * not a port above the privileged range is dropped: a typo must not make cezar try to bind :80.
 */
export function parsePreviewPorts(raw: string | undefined): number[] {
  const ports: number[] = [];
  for (const part of (raw ?? '').split(',')) {
    const range = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    for (let port = from; port <= to && ports.length < 256; port += 1) {
      if (port >= 1024 && port <= 65535 && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

function socketHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function portOf(url: URL): number {
  return url.port === '' ? 80 : Number(url.port);
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A stable first choice of port per app, so a reopened preview lands on the origin its
 *  cookies and local storage were written under. */
function preferredIndex(key: string, size: number): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % size;
}

export class PreviewGateways {
  private readonly entries = new Map<string, Entry>();
  private readonly ports: readonly number[];
  private readonly publicPorts: readonly number[];
  private readonly bindHost: string;
  private readonly idleMs: number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: PreviewGatewaysOptions) {
    this.ports = options.ports;
    this.publicPorts = options.publicPorts?.length === options.ports.length ? options.publicPorts : options.ports;
    this.bindHost = options.bindHost ?? '127.0.0.1';
    this.idleMs = options.idleMs ?? 30 * 60_000;
  }

  get enabled(): boolean {
    return this.ports.length > 0;
  }

  /** How many listeners are open — for tests and for nothing else. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * A gateway origin for `target` and a ticket that opens it once.
   *
   * `parentOrigin` is the cockpit as the viewer's browser reaches it; the gateway is reached at
   * the same scheme and hostname on its own port, which is what keeps the two same-SITE (so the
   * cookie is sent inside the frame) and never same-ORIGIN. `forbiddenPorts` are loopback ports
   * that must never be re-served: cezar's own.
   */
  async open(input: { target: string; parentOrigin: string; forbiddenPorts?: readonly number[]; designMode?: boolean }): Promise<PreviewGatewayResult> {
    if (!this.enabled) {
      return { ok: false, code: 'disabled', reason: 'this cockpit has no preview gateway (CEZ_PREVIEW_PORTS is not set)' };
    }
    const target = parseDesignTarget(input.target);
    if (!target.ok) return { ok: false, code: 'invalid', reason: 'a preview needs a local http:// address' };
    let parent: URL;
    try {
      parent = new URL(input.parentOrigin);
    } catch {
      return { ok: false, code: 'invalid', reason: 'not a cockpit origin' };
    }
    if (parent.protocol !== 'http:' && parent.protocol !== 'https:') {
      return { ok: false, code: 'invalid', reason: 'not a cockpit origin' };
    }
    const upstream = target.url;
    const refused = new Set([...(input.forbiddenPorts ?? []), ...this.ports]);
    if (refused.has(portOf(upstream))) {
      return { ok: false, code: 'invalid', reason: 'a preview cannot be pointed at cezar itself' };
    }

    // One listener per app AND per way of reaching the cockpit: the public origin is baked into
    // the redirects and `Origin` rewrites, and two hostnames for one cockpit must not share them.
    // A design slot also bakes in the cockpit's full origin: it is what the picker trusts.
    const design = input.designMode === true;
    const key = design ? `${upstream.origin}|${parent.origin}|design` : `${upstream.origin}|${parent.protocol}//${parent.hostname}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const opened = await this.listen(key, upstream, parent, design);
      if (!opened) {
        return { ok: false, code: 'busy', reason: 'every preview port is in use — close a preview and retry' };
      }
      // Two requests for the same app can race the `listen`; the first one in wins.
      const raced = this.entries.get(key);
      if (raced) {
        opened.server.close();
        entry = raced;
      } else {
        this.entries.set(key, opened);
        this.startSweeper();
        entry = opened;
      }
    }
    entry.lastUsed = Date.now();
    const now = Date.now();
    for (const [ticket, expires] of entry.tickets) if (expires < now) entry.tickets.delete(ticket);
    while (entry.tickets.size >= MAX_TICKETS) entry.tickets.delete(entry.tickets.keys().next().value as string);
    const ticket = randomBytes(32).toString('base64url');
    entry.tickets.set(ticket, now + TICKET_TTL_MS);
    return { ok: true, origin: entry.publicOrigin, ticket };
  }

  closeAll(): void {
    for (const [key, entry] of [...this.entries]) this.close(key, entry);
  }

  private close(key: string, entry: Entry): void {
    this.entries.delete(key);
    for (const socket of entry.sockets) socket.destroy();
    entry.server.close();
    entry.server.closeAllConnections?.();
    if (this.entries.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - this.idleMs;
      for (const [key, entry] of [...this.entries]) {
        // The cap must not wait for a request to notice it: it closes sockets (§4.4).
        this.purgeSessions(entry);
        if (entry.sockets.size === 0 && entry.lastUsed < cutoff) this.close(key, entry);
      }
    }, Math.max(1_000, Math.min(60_000, this.idleMs)));
    // Never the reason a process stays alive.
    this.sweeper.unref();
  }

  /** A listener on a free pool port — the app's usual one when it is free — or null when the
   *  pool is exhausted even after giving up the least recently used idle preview. */
  private async listen(key: string, upstream: URL, parent: URL, design: boolean): Promise<Entry | null> {
    const inUse = () => new Set([...this.entries.values()].map((entry) => entry.port));
    if (inUse().size >= this.ports.length) {
      const idle = [...this.entries].filter(([, entry]) => entry.sockets.size === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) return null;
      this.close(idle[0], idle[1]);
    }
    const start = preferredIndex(key, this.ports.length);
    for (let step = 0; step < this.ports.length; step += 1) {
      const port = this.ports[(start + step) % this.ports.length]!;
      if (inUse().has(port)) continue;
      const entry = await this.bind(port, upstream, parent, design);
      if (entry) return entry;
    }
    return null;
  }

  private bind(port: number, upstream: URL, parent: URL, design: boolean): Promise<Entry | null> {
    return new Promise((resolve) => {
      const server = createServer();
      const entry: Entry = {
        upstream,
        design,
        parentOrigin: parent.origin,
        publicOrigin: `${parent.protocol}//${parent.hostname}:${this.publicPorts[this.ports.indexOf(port)] ?? port}`,
        server,
        port,
        tickets: new Map(),
        sessions: new Map(),
        lastUsed: Date.now(),
        sockets: new Set(),
      };
      server.on('request', (req, res) => this.handle(entry, req, res));
      server.on('upgrade', (req, socket, head) => this.upgrade(entry, req, socket, head));
      // Something else on the host holds this port: not an error, just not ours — try the next.
      server.once('error', () => resolve(null));
      server.listen(port, this.bindHost, () => {
        // Port 0 is not a pool an operator can name; it is how a test lets the OS choose.
        const address = server.address();
        if (port === 0 && address !== null && typeof address !== 'string') {
          entry.port = address.port;
          entry.publicOrigin = `${parent.protocol}//${parent.hostname}:${address.port}`;
        }
        server.removeAllListeners('error');
        // A listener error after boot must not take the process down with an unhandled event.
        server.on('error', () => {});
        resolve(entry);
      });
    });
  }

  private cookieName(entry: Entry): string {
    // Cookies are scoped by host and NOT by port, so the name carries the port: one preview's
    // session must not open another's, and none of them may collide with the app's own cookies.
    return `__cez_pv_${entry.port}`;
  }

  /** The request's cookies with the gateway's own removed, and whether that one was valid. */
  private readCookies(entry: Entry, req: IncomingMessage): { session: Session | null; forwarded: string | undefined } {
    const name = this.cookieName(entry);
    let session: Session | null = null;
    const kept: string[] = [];
    for (const pair of (req.headers.cookie ?? '').split(';')) {
      const trimmed = pair.trim();
      if (trimmed === '') continue;
      const eq = trimmed.indexOf('=');
      const cookie = eq === -1 ? trimmed : trimmed.slice(0, eq);
      if (cookie.startsWith('__cez_pv_')) {
        if (cookie === name) session = this.liveSession(entry, trimmed.slice(eq + 1)) ?? session;
        continue;
      }
      // Cookies ignore the port, so the browser sends the cockpit's own session here too. The
      // previewed app must never see it (spec 2026-10-12-cockpit-authentication §7).
      if (cookie === SECURE_SESSION_COOKIE || cookie === PLAIN_SESSION_COOKIE) continue;
      kept.push(trimmed);
    }
    return { session, forwarded: kept.length > 0 ? kept.join('; ') : undefined };
  }

  /** End a session, and with it every socket it authorised. */
  private endSession(entry: Entry, key: string): void {
    const session = entry.sessions.get(key);
    entry.sessions.delete(key);
    for (const socket of session?.sockets ?? []) socket.destroy();
  }

  /** Drop the sessions past a window. An open socket is use, so it holds off the idle one only. */
  private purgeSessions(entry: Entry): void {
    const now = Date.now();
    for (const [key, session] of entry.sessions) {
      const idle = session.sockets.size === 0 && now - session.used > SESSION_IDLE_MS;
      if (idle || now - session.born > SESSION_MAX_MS) this.endSession(entry, key);
    }
  }

  /** The live session `value` names, if any; using it slides the idle window. */
  private liveSession(entry: Entry, value: string): Session | null {
    this.purgeSessions(entry);
    let live: Session | null = null;
    // Every candidate is compared: the lookup must not tell a near miss from a far one.
    for (const [key, session] of entry.sessions) {
      if (sameSecret(key, value)) live = session;
    }
    if (live) live.used = Date.now();
    return live;
  }

  private mintSession(entry: Entry): string {
    this.purgeSessions(entry);
    while (entry.sessions.size >= MAX_SESSIONS) {
      // Least recently used goes; one holding an open socket only when nothing else can.
      const [victim] = [...entry.sessions].sort(
        ([, a], [, b]) => Math.sign(a.sockets.size) - Math.sign(b.sockets.size) || a.used - b.used,
      );
      this.endSession(entry, victim![0]);
    }
    const key = randomBytes(32).toString('base64url');
    entry.sessions.set(key, { born: Date.now(), used: Date.now(), sockets: new Set() });
    return key;
  }

  /**
   * Spend the ticket in the request's query, whoever presents it. Null when there is none; else
   * the URL without it and whether the ticket was good.
   */
  private redeem(entry: Entry, req: IncomingMessage): { path: string; valid: boolean } | null {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket === null) return null;
    const expires = entry.tickets.get(ticket);
    entry.tickets.delete(ticket);
    url.searchParams.delete(TICKET_PARAM);
    return { path: url.pathname + url.search, valid: expires !== undefined && expires >= Date.now() };
  }

  /** The request's headers as the app should see them. */
  private forwardHeaders(entry: Entry, req: IncomingMessage, cookies: string | undefined): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === 'cookie') continue;
      headers[name] = value;
    }
    if (cookies !== undefined) headers.cookie = cookies;
    headers.host = entry.upstream.host;
    // Only a request from the gateway's OWN pages is presented as same-origin. A foreign origin
    // is passed through untouched so the app's CORS and CSRF checks judge it as they always would.
    if (headers.origin === entry.publicOrigin) headers.origin = entry.upstream.origin;
    if (typeof headers.referer === 'string') {
      // A ticket is the gateway's, like its cookie: the app never reads one, spent or not.
      headers.referer = withoutTicket(headers.referer)?.href ?? headers.referer;
      if (headers.referer.startsWith(`${entry.publicOrigin}/`)) {
        headers.referer = entry.upstream.origin + headers.referer.slice(entry.publicOrigin.length);
      }
    }
    return headers;
  }

  private handle(entry: Entry, req: IncomingMessage, res: ServerResponse): void {
    const { session, forwarded } = this.readCookies(entry, req);
    const authorized = session !== null;
    // A ticket is spent and stripped whenever it is presented — the cockpit sends one with every
    // load, cookie or not — so it never reaches the app (spec 2026-10-10-preview-gateway §4).
    const ticket = this.redeem(entry, req);
    if (!authorized && !ticket?.valid) {
      res
        .writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        .end('This preview is opened from the cezar cockpit. Reload it there.');
      return;
    }
    entry.lastUsed = Date.now();
    if (ticket) {
      const headers: Record<string, string> = { location: ticket.path, 'cache-control': 'no-store' };
      // A browser that already holds a live session keeps it: one session per browser.
      if (!authorized) {
        const secure = entry.publicOrigin.startsWith('https:') ? '; Secure' : '';
        headers['set-cookie'] = `${this.cookieName(entry)}=${this.mintSession(entry)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
      }
      res.writeHead(302, headers).end();
      return;
    }

    if (entry.design && req.method === 'GET' && (req.url ?? '').split('?')[0] === PICKER_PATH) {
      res
        .writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        .end(pickerScript({ parentOrigin: entry.parentOrigin, upstreamOrigin: entry.upstream.origin }));
      return;
    }
    const headers = this.forwardHeaders(entry, req, forwarded);
    // Uncompressed, so an HTML answer can be read and given its script tag.
    if (entry.design) headers['accept-encoding'] = 'identity';

    const outgoing = httpRequest(
      {
        host: socketHost(entry.upstream),
        port: portOf(entry.upstream),
        method: req.method,
        path: req.url,
        headers,
      },
      (incoming) => {
        const answer: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          const allowed = answerHeader(name, value);
          if (allowed !== undefined) answer[name] = allowed;
        }
        // A redirect to the app's own origin stays inside the gateway; one that leaves it, leaves.
        // Origins are compared parsed: as a string prefix `:3000` also matches `:30001`.
        if (typeof answer.location === 'string' && URL.canParse(answer.location)) {
          const to = new URL(answer.location);
          if (to.origin === entry.upstream.origin) answer.location = entry.publicOrigin + to.pathname + to.search + to.hash;
        }
        if (entry.design) {
          relayWithPicker(req, incoming, res, withoutFrameBusting(answer, entry.parentOrigin));
          return;
        }
        res.writeHead(incoming.statusCode ?? 502, answer);
        incoming.pipe(res);
        incoming.on('error', () => res.destroy());
      },
    );
    outgoing.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res
        .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`The preview could not reach ${entry.upstream.origin} — is the app still running?`);
    });
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  }

  /** WebSocket upgrades (a dev server's hot reload) are spliced through byte for byte. */
  private upgrade(entry: Entry, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { session, forwarded } = this.readCookies(entry, req);
    if (!session) {
      socket.destroy();
      return;
    }
    entry.lastUsed = Date.now();
    // An upgrade cannot be redirected, so a ticket on it is spent and cut from the path here.
    const path = this.redeem(entry, req)?.path ?? req.url;
    const headers = this.forwardHeaders(entry, req, forwarded);
    // `forwardHeaders` drops hop-by-hop headers, and an upgrade is made of exactly two of them.
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';

    const upstream: Socket = connect(portOf(entry.upstream), socketHost(entry.upstream));
    const release = () => {
      // The idle window starts when the socket that held it off closes (§4.4).
      if (session.sockets.delete(socket)) session.used = Date.now();
      entry.sockets.delete(socket);
      entry.lastUsed = Date.now();
      socket.destroy();
      upstream.destroy();
    };
    entry.sockets.add(socket);
    session.sockets.add(socket);
    upstream.on('connect', () => {
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      // Spliced byte for byte AFTER the handshake answer's head, whose cookies a browser honours too.
      let head101 = Buffer.alloc(0);
      const onHead = (chunk: Buffer) => {
        head101 = Buffer.concat([head101, chunk]);
        const end = head101.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head101.length > UPGRADE_HEAD_CAP) release();
          return;
        }
        upstream.off('data', onHead);
        const lines = head101.subarray(0, end).toString('latin1').split('\r\n').flatMap((line, index) => {
          const colon = line.indexOf(':');
          if (index === 0 || colon === -1) return [line];
          const allowed = answerHeader(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
          if (allowed === undefined) return [];
          return allowed === line.slice(colon + 1).trim() ? [line] : [`${line.slice(0, colon)}: ${String(allowed)}`];
        });
        socket.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), head101.subarray(end + 4)]));
        upstream.pipe(socket);
      };
      upstream.on('data', onHead);
    });
    upstream.on('error', release);
    upstream.on('close', release);
    socket.on('error', release);
    socket.on('close', release);
  }
}
