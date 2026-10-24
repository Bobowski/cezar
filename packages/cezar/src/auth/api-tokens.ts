import { randomBytes } from 'node:crypto';
import type { ApiTokenScope } from '@open-mercato/cezar-contract';
import { randomToken } from './store.ts';

/**
 * Owner API tokens (spec 2026-10-24-cezar-mcp-server §4): the Bearer credential for the MCP
 * endpoint, `cez --server` and scripts. The value is `ceztok_<id>_<secret>`; only its hash is
 * stored. What a token may call is decided here, per route family, and nowhere else.
 */
const PREFIX = 'ceztok_';

export function isApiToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

/** A fresh id and the value to show once. The id is hex, so the first `_` after it ends it. */
export function mintApiToken(): { id: string; value: string } {
  const id = randomBytes(6).toString('hex');
  return { id, value: `${PREFIX}${id}_${randomToken()}` };
}

/** The id a value names, or null for anything that is not a well-formed token. */
export function apiTokenIdOf(value: string): string | null {
  const match = /^ceztok_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/.exec(value);
  return match ? match[1]! : null;
}

/**
 * The scope that WRITES each route family; `read` covers every GET outside {@link SENSITIVE_READS}.
 * A family is the first path segment after `/api/v1` (and the project scope), or
 * `workspace/<segment>` under the workspace family. `catalog.test.ts`-style coverage lives in
 * `api-tokens.test.ts`: every family a built app serves must be listed, so a new family is a
 * decision, not a default.
 */
export const FAMILY_SCOPES: Record<string, Exclude<ApiTokenScope, 'read'>> = {
  runs: 'tasks',
  groups: 'tasks',
  todos: 'tasks',
  plan: 'tasks',
  tracker: 'tasks',
  'workspace/uploads': 'tasks',
  workflows: 'author',
  skills: 'author',
  automations: 'author',
  'automation-log': 'author',
  'automation-checks': 'author',
  'env-files': 'author',
  'workspace/automation-templates': 'author',
  projects: 'admin',
  fs: 'admin',
  repo: 'admin',
  worktrees: 'admin',
  'worktree-lifecycle': 'admin',
  github: 'admin',
  services: 'admin',
  docker: 'admin',
  e2e: 'admin',
  'start-app': 'admin',
  preview: 'admin',
  secrets: 'admin',
  config: 'admin',
  'agent-config': 'admin',
  'ui-state': 'admin',
  'launch-key': 'admin',
  'open-in': 'admin',
  'open-targets': 'admin',
  models: 'admin',
  providers: 'admin',
  health: 'admin',
  'star-count': 'admin',
  telemetry: 'admin',
  events: 'admin',
  mcp: 'admin',
  'workspace/agent-profiles': 'admin',
  'workspace/branding-logo': 'admin',
  'workspace/config': 'admin',
  'workspace/dashboard': 'admin',
  'workspace/events': 'admin',
  'workspace/host-usage': 'admin',
  'workspace/runs-index': 'admin',
  'workspace/secrets': 'admin',
  'workspace/self-update': 'admin',
  'workspace/skills-update': 'admin',
  'workspace/ui-state': 'admin',
};

/** Reads any token may make: what an agent needs to address anything at all. */
const DISCOVERY = new Set(['projects', 'health', 'models']);

/** Reads that hand out a credential or a file's raw content: the family's scope, never `read`. */
const SENSITIVE_READS: readonly RegExp[] = [
  /^\/launch-key$/,
  /^\/agent-config\/[^/]+$/,
  /^\/env-files\/content$/,
];

/** `/api/v1/p/x/runs/1` → `/runs/1`; null outside the API. */
function routePath(pathname: string): string | null {
  if (!pathname.startsWith('/api/v1/')) return null;
  const rest = pathname.slice('/api/v1'.length);
  const scoped = /^\/p\/[^/]+(\/.*)$/.exec(rest);
  return scoped ? scoped[1]! : rest;
}

/** The family a path belongs to (see {@link FAMILY_SCOPES}); null outside the API. */
export function routeFamily(pathname: string): string | null {
  const path = routePath(pathname);
  if (path === null) return null;
  const [first, second] = path.split('/').filter(Boolean);
  if (!first) return null;
  return first === 'workspace' && second ? `workspace/${second}` : first;
}

const READS = new Set(['GET', 'HEAD']);

/**
 * Whether a token with these scopes may make this request. Fails closed: an unknown family is
 * `admin`'s, and `/auth/*` is no token's (the guard answers that before asking).
 */
export function apiTokenAllows(scopes: readonly ApiTokenScope[], method: string, pathname: string): boolean {
  const family = routeFamily(pathname);
  if (family === null || family === 'auth') return false;
  if (scopes.includes('admin')) return true;
  const owner = FAMILY_SCOPES[family] ?? 'admin';
  if (owner !== 'admin' && scopes.includes(owner)) return true;
  // The MCP endpoint is a transport: each tool call is re-checked against its own route.
  if (family === 'mcp') return scopes.length > 0;
  if (!READS.has(method.toUpperCase())) return false;
  if (DISCOVERY.has(family)) return true;
  const path = routePath(pathname)!;
  if (SENSITIVE_READS.some((pattern) => pattern.test(path))) return false;
  return scopes.includes('read');
}
