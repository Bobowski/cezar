import { randomBytes } from 'node:crypto';
import { routeContracts, type ApiTokenScope } from '@open-mercato/cezar-contract';
import type { Principal } from './guard.ts';
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
 * The scope that WRITES each route family; `read` covers the GETs in {@link READ_ROUTES} only.
 * A family is the first path segment after `/api/v1` (and the project scope), or
 * `workspace/<segment>` under the workspace family. `catalog.test.ts`-style coverage lives in
 * `api-tokens.test.ts`: every family a built app serves must be listed, so a new family is a
 * decision, not a default.
 */
export const FAMILY_SCOPES: Record<string, Exclude<ApiTokenScope, 'read' | 'runs.transcript'>> = {
  runs: 'tasks',
  groups: 'tasks',
  todos: 'tasks',
  plan: 'tasks',
  tracker: 'tasks',
  'workspace/uploads': 'tasks',
  workflows: 'author',
  skills: 'author',
  // Personas are operator-written prompts and launch options (spec 2026-10-24-personas).
  agents: 'author',
  automations: 'author',
  'automation-log': 'author',
  'automation-checks': 'author',
  // Registers a GitHub webhook for the automations (spec 2026-10-23-github-events).
  'automation-webhook': 'author',
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
  // A definition is code the agents run, and Test runs it on the host (spec 2026-10-24-easy-mcp).
  'mcp-servers': 'admin',
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
  // A delivery is unauthenticated and checks its own HMAC; no token needs it.
  hooks: 'admin',
  // A backup carries every secret and the auth store.
  'workspace/backup': 'admin',
  'workspace/agent-profiles': 'admin',
  'workspace/branding': 'admin',
  'workspace/branding-logo': 'admin',
  'workspace/config': 'admin',
  'workspace/dashboard': 'admin',
  'workspace/events': 'admin',
  'workspace/host-usage': 'admin',
  // A device's push subscription is a browser's, made by a signed-in person.
  'workspace/push': 'admin',
  'workspace/runs-index': 'admin',
  'workspace/secrets': 'admin',
  'workspace/self-update': 'admin',
  'workspace/skills-update': 'admin',
  'workspace/ui-state': 'admin',
};

/**
 * Routes whose owner is not their family's, first match wins. A task terminal is an interactive
 * shell on the host: `admin`'s. Not a sandbox — a run `tasks` starts executes code as the cezar
 * user too (spec 2026-10-24-cezar-mcp-server §4); scopes bound the API surface, not the machine.
 * A tracker connection (its credentials) and the project's tracker link are configuration:
 * `author`'s, while `tasks` keeps ticket transitions and watches.
 */
const ROUTE_OWNERS: ReadonlyArray<readonly [RegExp, Exclude<ApiTokenScope, 'read' | 'runs.transcript'>]> = [
  [/^\/runs\/[^/]+\/terminal(\/|$)/, 'admin'],
  [/^\/tracker\/(connection|association)(\/|$)/, 'author'],
  // Design notes collected before a task exists: what the user typed, kin of a task's drafts.
  [/^\/repo\/design-drafts$/, 'tasks'],
];

/**
 * GET routes a scope other than their family's owner may read, by template. A pinned service's
 * command and the start command are configuration that can carry an inline secret: `author`'s
 * to read, never `read`'s, while pinning and setting them stay `admin`'s.
 */
const READ_OWNERS: ReadonlyMap<string, Exclude<ApiTokenScope, 'read' | 'runs.transcript'>> = new Map([
  ['/services', 'author'],
  ['/start-app', 'author'],
  // MCP definitions are commands and URLs (literal env/header values are never served), and a
  // registry result is third-party text: configuration, `author`'s to read, never `read`'s.
  ['/mcp-servers', 'author'],
  ['/mcp-servers/registry', 'author'],
]);

/** Reads any token may make: what an agent needs to address anything at all. */
const DISCOVERY_ROUTES: ReadonlySet<string> = new Set(['/projects', '/health', '/models']);

/** Reads the sign-in page makes with no credential at all (`isPublicBrandingRequest`), so no token
 *  is refused them. The name is the operator's own text, which is why they are not `read`'s. */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/workspace/branding', '/workspace/branding/:kind', '/workspace/branding-logo']);

/**
 * The GET routes `read` covers, by route template — an ALLOWLIST: each one is known to hand out
 * no credential, no shell or log output, no configured command, nothing the user typed or pasted
 * outside a task's own text, and no file outside the repository index (the run and repo file
 * routes gate a token on the index server-side). What each one may say in free text is pinned
 * per field in `api-tokens.test.ts`. A GET added later is no token's but
 * its family owner's until it is listed here; `api-tokens.test.ts` keeps every entry a real route.
 */
export const READ_ROUTES: ReadonlySet<string> = new Set([
  '/runs', '/runs/:id', '/runs/:id/changes', '/runs/:id/commit/:sha', '/runs/:id/commits', '/runs/:id/diff',
  '/runs/:id/files',
  '/runs/:id/git/status', '/runs/:id/layouts', '/runs/:id/search', '/runs/:id/tracker-issue', '/runs/:id/tree',
  '/groups/:groupId', '/events',
  '/workflows', '/workflows/nodes', '/skills', '/skills/importable',
  '/projects/:projectId/icon',
  '/repo', '/repo/changes', '/repo/commit/:sha', '/repo/diff', '/repo/files', '/repo/search', '/repo/sync',
  '/repo/tree', '/repo/watch', '/repo/graph',
  '/worktrees', '/worktree-lifecycle', '/worktree-lifecycle/:worktreeId', '/worktree-lifecycle/operations/:operationId',
  '/github', '/github/checks', '/github/comments/:kind/:number', '/github/prs/:number/changes',
  '/github/prs/:number/merge-state', '/github/ref-status', '/github/search',
  '/tracker', '/tracker/:id', '/tracker/:id/transitions', '/tracker/association', '/tracker/automation-options',
  '/tracker/candidates', '/tracker/search', '/tracker/watch/:watchId',
  '/docker', '/e2e', '/open-targets', '/providers/status', '/star-count',
  '/telemetry/consent',
  '/workspace/branding-logo', '/workspace/dashboard',
  '/workspace/dashboard/automations', '/workspace/dashboard/costs', '/workspace/dashboard/feed',
  '/workspace/dashboard/insights', '/workspace/dashboard/overview', '/workspace/dashboard/tasks',
  '/workspace/dashboard/telemetry', '/workspace/events', '/workspace/host-usage', '/workspace/runs-index',
  '/workspace/self-update', '/workspace/skills-update',
]);

/**
 * A task's event stream and transcript: tool output, which can carry whatever a command printed —
 * `runs.transcript`'s, never `read`'s. So are the handoff and the todo inbox, which quote what the
 * agent wrote. `tasks` has them as the owner of the `runs` and `todos` families.
 */
export const TRANSCRIPT_ROUTES: ReadonlySet<string> = new Set([
  '/runs/:id/events', '/runs/:id/history', '/runs/:id/history-context', '/runs/:id/handoff', '/todos',
]);

/** Whether a token with these scopes sees agent-authored text: `runs.transcript`, or a scope that owns it. */
export function scopesSeeTranscript(scopes: readonly ApiTokenScope[]): boolean {
  return scopes.some((scope) => scope === 'runs.transcript' || scope === 'tasks' || scope === 'admin');
}

/** The same question for a request's principal; anything but a token is the owner and sees all. */
export function principalSeesTranscript(principal: Principal | undefined): boolean {
  return principal?.kind !== 'token' || scopesSeeTranscript(principal.scopes);
}

const GET_TEMPLATES = Object.keys(routeContracts)
  .filter((key) => key.startsWith('GET '))
  .map((key) => key.slice(4).split('/').filter(Boolean));

/**
 * The GET route template a path is, literal segments beating parameters (`/tracker/connection`
 * is never `/tracker/:id`); null for a path no GET route has.
 */
export function getRouteTemplateOf(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  let best: string[] | null = null;
  let bestRank: string | null = null;
  for (const template of GET_TEMPLATES) {
    if (template.length !== segments.length) continue;
    let rank = '';
    let matches = true;
    for (let index = 0; index < template.length; index += 1) {
      const part = template[index]!;
      if (part.startsWith(':')) rank += '0';
      else if (part === segments[index]) rank += '1';
      else {
        matches = false;
        break;
      }
    }
    if (matches && (bestRank === null || rank > bestRank)) {
      best = template;
      bestRank = rank;
    }
  }
  return best ? `/${best.join('/')}` : null;
}

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
  const path = routePath(pathname)!;
  const owner = ROUTE_OWNERS.find(([pattern]) => pattern.test(path))?.[1] ?? FAMILY_SCOPES[family] ?? 'admin';
  if (owner !== 'admin' && scopes.includes(owner)) return true;
  // The MCP endpoint is a transport: each tool call is re-checked against its own route.
  if (family === 'mcp') return scopes.length > 0;
  if (!READS.has(method.toUpperCase())) return false;
  const template = getRouteTemplateOf(path);
  if (template === null) return false;
  if (DISCOVERY_ROUTES.has(template) || PUBLIC_ROUTES.has(template)) return true;
  const reader = READ_OWNERS.get(template);
  if (reader && scopes.includes(reader)) return true;
  if (scopes.includes('runs.transcript') && TRANSCRIPT_ROUTES.has(template)) return true;
  return scopes.includes('read') && READ_ROUTES.has(template);
}
