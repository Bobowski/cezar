import type { IncomingMessage } from 'node:http';
import type { Context, MiddlewareHandler } from 'hono';
import type { ApiTokenScope, AuthUser } from '@open-mercato/cezar-contract';
import { isLoopbackHostHeader } from '../server/capabilities.ts';
import { apiTokenAllows, isApiToken } from './api-tokens.ts';
import { verifyHostKey, isHostKey } from './host-key.ts';
import { isRunToken, runTokenAllows, verifyRunToken, type RunTokenClaims } from './run-tokens.ts';
import type { AuthService } from './service.ts';

/**
 * The one place a request becomes a principal or a 401 (spec
 * `2026-10-12-cockpit-authentication.md` §6). Registered once, after the #426 origin guard, over
 * every `/api/*` route; `auth-guard.test.ts` walks the route table to prove nothing is outside it.
 */

/** Who is calling. `host` is this machine's own shell — and everyone, on a cockpit without auth. */
export type Principal =
  | { kind: 'user'; role: AuthUser['role']; user: AuthUser; sessionId: string }
  | { kind: 'token'; role: AuthUser['role']; user: AuthUser; tokenId: string; scopes: ApiTokenScope[] }
  | { kind: 'run'; role: 'agent'; runId: string; projectId?: string }
  | { kind: 'host'; role: 'owner' };

export type AuthEnv = { Variables: { principal: Principal | undefined } };

/** `__Host-` pins the cookie to this exact host over HTTPS, so a sibling subdomain cannot plant one. */
export const SECURE_SESSION_COOKIE = '__Host-cez_session';
/** Plain HTTP exists only on loopback (a local `CEZ_AUTH=1`, a container on the viewer's machine). */
export const PLAIN_SESSION_COOKIE = 'cez_session';

const API = '/api/v1';
const PUBLIC_PATHS = new Set(
  ['session', 'login', 'login/verify', 'logout', 'setup/begin', 'setup/complete', 'setup/restore'].map((path) => `${API}/auth/${path}`),
);

export function isPublicAuthPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/** A webhook delivery (spec 2026-10-23-github-events §4): the one unauthenticated route besides
 *  health. Its own HMAC check is its authentication, so only an exact `POST` to a well-formed id
 *  skips the session — any other spelling meets the guard. */
const HOOK_PATH_RE = /^\/api\/v1\/hooks\/github\/[0-9a-f]{64}$/;
export function isPublicHookRequest(method: string, pathname: string): boolean {
  return method === 'POST' && HOOK_PATH_RE.test(pathname);
}

/** Public only while no owner can sign in: a restore upload is a setup action, not a sign-in one. */
const SETUP_ONLY = new Set([`POST ${API}/auth/setup/restore`]);

function publicNow(method: string, pathname: string, service: AuthService): boolean {
  if (!isPublicAuthPath(pathname)) return false;
  return !SETUP_ONLY.has(`${method.toUpperCase()} ${pathname}`) || service.setupRequired();
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const pair of (header ?? '').split(';')) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf('=');
    if (eq !== -1 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

/** The session token a request carries. The plain cookie is honoured for a loopback Host only. */
export function sessionTokenOf(cookieHeader: string | undefined, host: string | undefined): string | undefined {
  return cookieValue(cookieHeader, SECURE_SESSION_COOKIE)
    ?? (isLoopbackHostHeader(host) ? cookieValue(cookieHeader, PLAIN_SESSION_COOKIE) : undefined);
}

export function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

/** Headers a proxy or a browser adds: a request carrying one is not this machine's own shell. */
const isProxyOrPageHeader = (name: string): boolean =>
  name.startsWith('x-forwarded-') || name === 'forwarded' || name === 'x-real-ip' || name === 'origin';

/**
 * Whether a request may present the host key: a shell on this machine talking straight to its own
 * cockpit — a loopback SOCKET, loopback Host, and no proxy or page header. Code a token runs can
 * read the key file, so off the box the key must open nothing (spec 2026-10-24-cezar-mcp-server
 * §5). An unknown socket is not a shell, and nor is anything behind `--external-proxy`
 * (`CEZ_EXTERNAL_PROXY=1`): an L4 proxy adds no header to tell its callers from one — nor does a
 * hand-written nginx with a bare `proxy_pass` (loopback Host, no X-Forwarded-*), which must set it too.
 */
export function hostKeyRequestIsLocal(
  request: { host: string | undefined; headerNames: Iterable<string>; remoteAddress: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CEZ_EXTERNAL_PROXY === '1') return false;
  const { remoteAddress } = request;
  if (remoteAddress === undefined || !isLoopbackHostHeader(remoteAddress.replace(/^::ffff:(?=\d+\.)/i, ''))) return false;
  if (!isLoopbackHostHeader(request.host)) return false;
  for (const name of request.headerNames) if (isProxyOrPageHeader(name.toLowerCase())) return false;
  return true;
}

function socketAddressOf(c: Context): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

function upgradeHostKeyIsLocal(req: IncomingMessage): boolean {
  return hostKeyRequestIsLocal({ host: req.headers.host, headerNames: Object.keys(req.headers), remoteAddress: req.socket?.remoteAddress });
}

export interface AuthGuardOptions {
  service: AuthService;
  /** Read per request, like every other capability: tests and ops flip the variable live. */
  enforced: () => boolean;
  /** Whether the run a token names is still running — a finished task's token opens nothing. */
  isRunLive: (claims: RunTokenClaims) => boolean | Promise<boolean>;
}

export function principalOf(c: Context): Principal | undefined {
  return (c as Context<AuthEnv>).get('principal');
}

export function createAuthGuard(options: AuthGuardOptions): MiddlewareHandler<AuthEnv> {
  const unauthorized = (c: Context) => c.json({ error: 'authentication required' }, 401);
  return async (c, next) => {
    const bearer = bearerOf(c.req.header('authorization'));
    // Checked even where sign-in is off: a token always means its scopes (spec
    // 2026-10-24-cezar-mcp-server §4), and it never manages sign-in or tokens.
    if (bearer !== undefined && isApiToken(bearer)) {
      if (c.req.path === `${API}/auth` || c.req.path.startsWith(`${API}/auth/`)) {
        return c.json({ error: 'forbidden: an API token cannot manage sign-in or tokens' }, 403);
      }
      const token = options.service.verifyApiToken(bearer, { touch: true });
      // A local cockpit without sign-in needs no credential from its own machine, so a token it
      // never minted (a shell's exported CEZ_TOKEN for another cockpit) is no credential at all.
      if (!token && !options.enforced() && isLoopbackHostHeader(c.req.header('host'))) {
        c.set('principal', { kind: 'host', role: 'owner' });
        return next();
      }
      if (!token) return unauthorized(c);
      if (!apiTokenAllows(token.scopes, c.req.method, c.req.path)) {
        return c.json({ error: `forbidden: this token's scopes (${token.scopes.join(', ')}) do not cover ${c.req.method} ${c.req.path}` }, 403);
      }
      c.set('principal', { kind: 'token', role: token.user.role, user: token.user, tokenId: token.tokenId, scopes: token.scopes });
      return next();
    }
    if (!options.enforced()) {
      c.set('principal', { kind: 'host', role: 'owner' });
      return next();
    }
    if (bearer !== undefined && isRunToken(bearer)) {
      const claims = verifyRunToken(bearer);
      if (!claims || !(await options.isRunLive(claims))) return unauthorized(c);
      if (!runTokenAllows(claims, c.req.method, c.req.path)) {
        return c.json({ error: 'forbidden: a task may not call this route' }, 403);
      }
      c.set('principal', { kind: 'run', role: 'agent', ...claims });
      return next();
    }
    if (bearer !== undefined && isHostKey(bearer)) {
      const local = hostKeyRequestIsLocal({ host: c.req.header('host'), headerNames: c.req.raw.headers.keys(), remoteAddress: socketAddressOf(c) });
      if (!local || !verifyHostKey(bearer)) return unauthorized(c);
      c.set('principal', { kind: 'host', role: 'owner' });
      return next();
    }
    const session = options.service.authenticate(sessionTokenOf(c.req.header('cookie'), c.req.header('host')));
    if (session) {
      c.set('principal', { kind: 'user', role: session.user.role, user: session.user, sessionId: session.sessionId });
      return next();
    }
    c.set('principal', undefined);
    return publicNow(c.req.method, c.req.path, options.service) || isPublicHookRequest(c.req.method, c.req.path)
      ? next()
      : unauthorized(c);
  };
}

/**
 * The WebSocket twin: an upgrade never reaches hono, so the cookie is checked on the raw request.
 * Browsers attach cookies to a same-site handshake, which is what lets a hosted cockpit have a
 * socket at all (Basic-Auth could not ride one).
 */
export function upgradeIsAuthenticated(req: IncomingMessage, options: Pick<AuthGuardOptions, 'service' | 'enforced'>): boolean {
  if (!options.enforced()) return true;
  const bearer = bearerOf(req.headers.authorization);
  if (bearer !== undefined && isHostKey(bearer)) return upgradeHostKeyIsLocal(req) && verifyHostKey(bearer);
  return options.service.authenticate(sessionTokenOf(req.headers.cookie, req.headers.host)) !== null;
}

/** The session an admitted upgrade rides, for the hub to re-check (§6). None for a host key or with auth off. */
export function upgradeSessionId(req: IncomingMessage, options: Pick<AuthGuardOptions, 'service' | 'enforced'>): string | undefined {
  if (!options.enforced()) return undefined;
  const bearer = bearerOf(req.headers.authorization);
  if (bearer !== undefined && isHostKey(bearer)) return undefined;
  return options.service.authenticate(sessionTokenOf(req.headers.cookie, req.headers.host))?.sessionId;
}
