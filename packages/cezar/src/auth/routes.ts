import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  authConfirmBodySchema,
  authLoginBodySchema,
  authPasswordBodySchema,
  authSetupBeginBodySchema,
  authSetupCompleteBodySchema,
  authVerifyBodySchema,
} from '@open-mercato/cezar-contract';
import { isLoopbackHostHeader } from '../server/capabilities.ts';
import { jsonZodValidator, paramZodValidator } from '../server/validators.ts';
import { PLAIN_SESSION_COOKIE, SECURE_SESSION_COOKIE, sessionTokenOf, type AuthEnv } from './guard.ts';
import type { AuthFailure, AuthService, RequestMeta } from './service.ts';

/**
 * `/api/v1/auth/*` (spec `2026-10-12-cockpit-authentication.md` §5). Workspace-level and
 * single-mount. The login and setup routes are public by path (`isPublicAuthPath`); everything
 * else here sits behind the guard like any other route.
 */

const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const HTTPS_REQUIRED = 'signing in needs HTTPS — reach this cockpit through its https:// address';

/** How the browser reached us. Null when a session cookie could not be set safely. */
function cookieFor(c: Context): { name: string; secure: boolean } | null {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const secure = forwarded === 'https' || (forwarded === undefined && new URL(c.req.url).protocol === 'https:');
  if (secure) return { name: SECURE_SESSION_COOKIE, secure: true };
  return isLoopbackHostHeader(c.req.header('host')) ? { name: PLAIN_SESSION_COOKIE, secure: false } : null;
}

function setSession(c: Context, cookie: { name: string; secure: boolean }, token: string): void {
  c.header(
    'set-cookie',
    `${cookie.name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SEC}${cookie.secure ? '; Secure' : ''}`,
  );
}

function clearSession(c: Context): void {
  c.header('set-cookie', `${SECURE_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`, { append: true });
  c.header('set-cookie', `${PLAIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, { append: true });
}

/** `Chrome on macOS` — enough to tell two rows of the device list apart, nothing more. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : undefined;
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : undefined;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}

function metaOf(c: Context): RequestMeta {
  // The LAST hop is the one the front appended; anything before it is whatever the client sent.
  const forwarded = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return { address: forwarded || socket?.remoteAddress || 'unknown', label: deviceLabel(c.req.header('user-agent')) };
}

function failure(c: Context, result: AuthFailure) {
  if (result.retryAfterSec !== undefined) c.header('retry-after', String(result.retryAfterSec));
  // Nothing an auth route answers may be cached by a front or a browser.
  c.header('cache-control', 'no-store');
  return c.json({ error: result.error }, result.status);
}

export function authRoutes(deps: { service: AuthService; enforced: () => boolean }) {
  const { service, enforced } = deps;
  const notEnabled = (c: Context) => c.json({ error: 'authentication is not enabled on this cockpit' }, 409);

  return new Hono<AuthEnv>()
    .get('/auth/session', (c) => {
      c.header('cache-control', 'no-store');
      if (!enforced()) return c.json({ enforced: false, authenticated: true, setupRequired: false });
      const principal = c.get('principal');
      return c.json({
        enforced: true,
        authenticated: principal !== undefined,
        setupRequired: service.setupRequired(),
        ...(principal?.kind === 'user' ? { user: principal.user } : {}),
      });
    })
    .post('/auth/login', jsonZodValidator(authLoginBodySchema), async (c) => {
      if (!enforced()) return notEnabled(c);
      if (!cookieFor(c)) return c.json({ error: HTTPS_REQUIRED }, 400);
      const result = await service.login(c.req.valid('json'), metaOf(c));
      if (!result.ok) return failure(c, result);
      c.header('cache-control', 'no-store');
      return c.json({ ticket: result.ticket });
    })
    .post('/auth/login/verify', jsonZodValidator(authVerifyBodySchema), (c) => {
      if (!enforced()) return notEnabled(c);
      const cookie = cookieFor(c);
      if (!cookie) return c.json({ error: HTTPS_REQUIRED }, 400);
      const result = service.verifyLogin(c.req.valid('json'), metaOf(c));
      if (!result.ok) return failure(c, result);
      setSession(c, cookie, result.token);
      c.header('cache-control', 'no-store');
      return c.json({ user: result.user });
    })
    .post('/auth/logout', (c) => {
      service.logout(sessionTokenOf(c.req.header('cookie'), c.req.header('host')));
      clearSession(c);
      return c.json({ ok: true as const });
    })
    .post('/auth/setup/begin', jsonZodValidator(authSetupBeginBodySchema), async (c) => {
      if (!enforced()) return notEnabled(c);
      if (!cookieFor(c)) return c.json({ error: HTTPS_REQUIRED }, 400);
      const result = await service.beginSetup(c.req.valid('json'), metaOf(c));
      if (!result.ok) return failure(c, result);
      c.header('cache-control', 'no-store');
      return c.json({ ticket: result.ticket, secret: result.secret, otpauthUri: result.otpauthUri });
    })
    .post('/auth/setup/complete', jsonZodValidator(authSetupCompleteBodySchema), (c) => {
      if (!enforced()) return notEnabled(c);
      const cookie = cookieFor(c);
      if (!cookie) return c.json({ error: HTTPS_REQUIRED }, 400);
      const result = service.completeSetup(c.req.valid('json'), metaOf(c));
      if (!result.ok) return failure(c, result);
      setSession(c, cookie, result.token);
      c.header('cache-control', 'no-store');
      return c.json({ user: result.user, recoveryCodes: result.recoveryCodes });
    })
    .get('/auth/sessions', (c) => {
      const principal = c.get('principal');
      if (principal?.kind !== 'user') return c.json({ error: 'only a signed-in user has sessions' }, 403);
      return c.json({ sessions: service.listSessions(principal.user.id, principal.sessionId) });
    })
    .post('/auth/sessions/revoke-others', (c) => {
      const principal = c.get('principal');
      if (principal?.kind !== 'user') return c.json({ error: 'only a signed-in user has sessions' }, 403);
      return c.json({ revoked: service.revokeOtherSessions(principal.user.id, principal.sessionId) });
    })
    .post('/auth/password', jsonZodValidator(authPasswordBodySchema), async (c) => {
      const principal = c.get('principal');
      if (principal?.kind !== 'user') return c.json({ error: 'only a signed-in user has a password' }, 403);
      const result = await service.changePassword(principal.user.id, principal.sessionId, c.req.valid('json'), metaOf(c));
      if (!result.ok) return failure(c, result);
      return c.json({ revoked: result.revoked });
    })
    .post('/auth/recovery-codes', jsonZodValidator(authConfirmBodySchema), (c) => {
      const principal = c.get('principal');
      if (principal?.kind !== 'user') return c.json({ error: 'only a signed-in user has recovery codes' }, 403);
      const result = service.regenerateRecoveryCodes(principal.user.id, c.req.valid('json').code, metaOf(c));
      if (!result.ok) return failure(c, result);
      c.header('cache-control', 'no-store');
      return c.json({ recoveryCodes: result.recoveryCodes });
    })
    .delete('/auth/sessions/:id', paramZodValidator(z.object({ id: z.string().min(1).max(64) })), (c) => {
      const principal = c.get('principal');
      if (principal?.kind !== 'user') return c.json({ error: 'only a signed-in user has sessions' }, 403);
      const { id } = c.req.valid('param');
      if (!service.revokeSession(principal.user.id, id)) return c.json({ error: 'unknown session' }, 404);
      if (id === principal.sessionId) clearSession(c);
      return c.json({ ok: true as const });
    });
}
