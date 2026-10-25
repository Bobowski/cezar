import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiTokenScope } from '@open-mercato/cezar-contract';
import { apiTokenAllows } from './api-tokens.ts';

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
/** Whether a task's CLI gets a token: only while auth is enforced. A chat's always does. */
let taskTokens = false;

/** Called once by `startServer` when auth is enforced. Until then no task token is minted. */
export function enableRunTokens(): void {
  key ??= randomBytes(32);
  taskTokens = true;
}

/** Tests only. */
export function disableRunTokens(): void {
  key = undefined;
  taskTokens = false;
}

export interface RunTokenClaims {
  runId: string;
  /** The registry id the run's CLI addresses (`CEZ_PROJECT_ID`); absent for an unregistered boot. */
  projectId?: string;
  /** `author`: the cockpit chat's MCP token (spec 2026-10-24-cockpit-chat §5) — the `read`, `tasks`
   *  and `author` scopes on its own project, never `admin`. Absent: a task CLI's allowlist. */
  scope?: 'author';
}

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function mint(claims: RunTokenClaims, secret: Buffer): string {
  const fields: unknown[] = [claims.runId, claims.projectId ?? null];
  if (claims.scope) fields.push(claims.scope);
  const payload = Buffer.from(JSON.stringify(fields)).toString('base64url');
  return `${PREFIX}${payload}.${sign(payload, secret)}`;
}

/** Undefined while auth is off, so an agent's environment is byte-for-byte what it was. */
export function mintRunToken(runId: string, projectId?: string): string | undefined {
  if (!key || !taskTokens) return undefined;
  return mint({ runId, projectId }, key);
}

/**
 * The chat's MCP credential, minted whether or not sign-in is on: like an API token it means its
 * scope everywhere (the guard checks it before the auth-off shortcut), so a local chat is bounded
 * by `author` too. The key is this process's, so a restart kills it with the session it served.
 */
export function mintChatRunToken(runId: string, projectId?: string): string {
  key ??= randomBytes(32);
  return mint({ runId, projectId, scope: 'author' }, key);
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
    const [runId, projectId, scope, ...extra] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown[];
    if (typeof runId !== 'string' || runId === '' || extra.length > 0) return null;
    if (scope !== undefined && scope !== 'author') return null;
    return { runId, ...(typeof projectId === 'string' ? { projectId } : {}), ...(scope ? { scope } : {}) };
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
  // `cez service` (spec 2026-10-11-project-services §4): status and logs, never a lifecycle route.
  ['GET', /^\/services$/],
  ['GET', new RegExp(`^/services/${SEGMENT}/logs$`)],
];

/**
 * Whether a run token may make this request. An allowlist of exactly what the three agent CLIs
 * call — a task is not a user, and a leaked token must not open the terminal or the file routes.
 */
export function runTokenAllows(claims: RunTokenClaims, method: string, pathname: string): boolean {
  if (!pathname.startsWith(`${API}/`)) return false;
  if (claims.scope === 'author') return chatTokenAllows(claims, method, pathname);
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

/** The scopes a chat's token carries (spec 2026-10-24-cockpit-chat §5): everything but `admin`. */
export const CHAT_TOKEN_SCOPES: readonly ApiTokenScope[] = ['read', 'runs.transcript', 'tasks', 'author'];

/** What `tasks` would grant that a chat still may not do: push, open or adopt a PR, land, Finish
 *  (which lands an in-place task), open a host app, or write a task's files (that is a task's job). */
const CHAT_DENIED: ReadonlyArray<readonly [method: string, RegExp]> = [
  ['*', /^\/runs\/[^/]+\/(?:git\/push|pr(?:\/|$)|land$|finish$|open-in)/],
  ['WRITE', /^\/runs\/[^/]+\/files(?:\/|$)/],
  ['*', /^\/workspace\//],
  // Launches that bypass `POST /runs`'s chat override (worktree, never autonomous): an inbox start,
  // and an automation run, check, retry or enable — an enabled automation launches with nobody there.
  ['WRITE', /^\/todos\/[^/]+\/start$/],
  ['WRITE', /^\/automations\/[^/]+\/(?:enable|run|check)$/],
  ['WRITE', /^\/automation-log\/[^/]+\/retry$/],
];

/** Workspace-level reads a chat may make with a project: discovery, and an automation check's poll. */
const CHAT_WORKSPACE_READS: readonly RegExp[] = [/^\/projects$/, /^\/health$/, /^\/models$/, new RegExp(`^/automation-checks/${SEGMENT}$`)];

/**
 * A chat token: the MCP transport, and every route `read`/`tasks`/`author` reach on the chat's
 * own project, minus {@link CHAT_DENIED}. `apiTokenAllows` is the one scope table, so a route's
 * owner is decided once for API tokens and chats alike.
 */
function chatTokenAllows(claims: RunTokenClaims, method: string, pathname: string): boolean {
  const rest = pathname.slice(API.length);
  if (rest === '/mcp') return true;
  const scoped = /^\/p\/([^/]+)(\/.*)$/.exec(rest);
  let path: string;
  if (scoped) {
    let projectId: string;
    try {
      projectId = decodeURIComponent(scoped[1]!);
    } catch {
      return false;
    }
    if (projectId !== claims.projectId) return false;
    path = scoped[2]!;
  } else {
    path = rest;
    const read = method === 'GET' || method === 'HEAD';
    // The unscoped alias is the BOOT project, which may not be this chat's.
    if (claims.projectId !== undefined && !(read && CHAT_WORKSPACE_READS.some((pattern) => pattern.test(path)))) return false;
  }
  const write = method !== 'GET' && method !== 'HEAD';
  if (CHAT_DENIED.some(([denied, pattern]) => (denied === '*' || (denied === 'WRITE' && write)) && pattern.test(path))) return false;
  return apiTokenAllows(CHAT_TOKEN_SCOPES, method, pathname);
}
