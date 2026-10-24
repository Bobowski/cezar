import type { IncomingMessage } from 'node:http';
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthUser } from '@open-mercato/cezar-contract';
import { isLoopbackHostHeader } from '../server/capabilities.ts';
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

function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
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
    if (!options.enforced()) {
      c.set('principal', { kind: 'host', role: 'owner' });
      return next();
    }
    const bearer = bearerOf(c.req.header('authorization'));
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
      if (!verifyHostKey(bearer)) return unauthorized(c);
      c.set('principal', { kind: 'host', role: 'owner' });
      return next();
    }
    const session = options.service.authenticate(sessionTokenOf(c.req.header('cookie'), c.req.header('host')));
    if (session) {
      c.set('principal', { kind: 'user', role: session.user.role, user: session.user, sessionId: session.sessionId });
      return next();
    }
    c.set('principal', undefined);
    return publicNow(c.req.method, c.req.path, options.service) ? next() : unauthorized(c);
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
  if (bearer !== undefined && isHostKey(bearer)) return verifyHostKey(bearer);
  return options.service.authenticate(sessionTokenOf(req.headers.cookie, req.headers.host)) !== null;
}

/** The session an admitted upgrade rides, for the hub to re-check (§6). None for a host key or with auth off. */
export function upgradeSessionId(req: IncomingMessage, options: Pick<AuthGuardOptions, 'service' | 'enforced'>): string | undefined {
  if (!options.enforced()) return undefined;
  const bearer = bearerOf(req.headers.authorization);
  if (bearer !== undefined && isHostKey(bearer)) return undefined;
  return options.service.authenticate(sessionTokenOf(req.headers.cookie, req.headers.host))?.sessionId;
}
