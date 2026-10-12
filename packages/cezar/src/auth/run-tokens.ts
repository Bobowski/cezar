import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The credential a task's own CLI presents to its cockpit (spec
 * `2026-10-12-cockpit-authentication.md` §7). Loopback gets no exemption under enforced auth, so
 * `cez task` / `cez tracker` / `cez automation` need something to show.
 *
 * Stateless: the token is `claims.HMAC(claims)` under a key that lives only in this process, so
 * there is no registry for `execute` and `runContinuation` to disagree about — both reach
 * `agentEnv`, which mints. A restart rotates the key and every outstanding token dies with it;
 * the runs it recovers get a fresh one with their fresh environment.
 */
const PREFIX = 'cezrun_';

let key: Buffer | undefined;

/** Called once by `startServer` when auth is enforced. Until then nothing is minted. */
export function enableRunTokens(): void {
  key ??= randomBytes(32);
}

/** Tests only. */
export function disableRunTokens(): void {
  key = undefined;
}

export interface RunTokenClaims {
  runId: string;
  /** The registry id the run's CLI addresses (`CEZ_PROJECT_ID`); absent for an unregistered boot. */
  projectId?: string;
}

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Undefined while auth is off, so an agent's environment is byte-for-byte what it was. */
export function mintRunToken(runId: string, projectId?: string): string | undefined {
  if (!key) return undefined;
  const payload = Buffer.from(JSON.stringify([runId, projectId ?? null])).toString('base64url');
  return `${PREFIX}${payload}.${sign(payload, key)}`;
}

export function isRunToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

export function verifyRunToken(token: string): RunTokenClaims | null {
  if (!key || !token.startsWith(PREFIX)) return null;
  const [payload, signature, ...rest] = token.slice(PREFIX.length).split('.');
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const [runId, projectId] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof runId !== 'string' || runId === '') return null;
    return { runId, ...(typeof projectId === 'string' ? { projectId } : {}) };
  } catch {
    return null;
  }
}

const API = '/api/v1';
const SEGMENT = '[^/]+';

/** Project-scoped routes a run may call, as `METHOD path` with `:run` standing for its own id. */
const SCOPED: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/runs$/],
  ['POST', /^\/runs\/(?<run>[^/]+)\/(?:dispatch|report)$/],
  ['GET', /^\/runs\/(?<run>[^/]+)\/tracker-issue$/],
  ['GET', /^\/automations$/],
  ['POST', /^\/automations$/],
  ['GET', new RegExp(`^/automations/${SEGMENT}$`)],
  ['PUT', new RegExp(`^/automations/${SEGMENT}$`)],
  ['DELETE', new RegExp(`^/automations/${SEGMENT}$`)],
  ['POST', new RegExp(`^/automations/${SEGMENT}/${SEGMENT}$`)],
  ['GET', /^\/tracker\/automation-options$/],
];

/**
 * Whether a run token may make this request. An allowlist of exactly what the three agent CLIs
 * call — a task is not a user, and a leaked token must not open the terminal or the file routes.
 */
export function runTokenAllows(claims: RunTokenClaims, method: string, pathname: string): boolean {
  if (!pathname.startsWith(`${API}/`)) return false;
  let rest = pathname.slice(API.length);
  // The one workspace-level read `cez automation check` polls.
  if (method === 'GET' && new RegExp(`^/automation-checks/${SEGMENT}$`).test(rest)) return true;
  const scoped = /^\/p\/([^/]+)(\/.*)$/.exec(rest);
  if (scoped) {
    let projectId: string;
    try {
      projectId = decodeURIComponent(scoped[1]!);
    } catch {
      return false;
    }
    if (projectId !== claims.projectId) return false;
    rest = scoped[2]!;
  } else if (claims.projectId !== undefined) {
    // A run that knows its project always addresses it; the unscoped alias is the boot project,
    // which may be a different one.
    return false;
  }
  for (const [allowed, pattern] of SCOPED) {
    if (allowed !== method) continue;
    const match = pattern.exec(rest);
    if (!match) continue;
    const run = match.groups?.run;
    if (run === undefined) return true;
    try {
      return decodeURIComponent(run) === claims.runId;
    } catch {
      return false;
    }
  }
  return false;
}
