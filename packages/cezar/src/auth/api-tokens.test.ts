import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { routeContracts } from '@open-mercato/cezar-contract';
import { AGENT_WRITTEN, agentWrittenRun } from '../test-fixtures/agent-written-run.testkit.ts';
import { apiTokenAllows, apiTokenIdOf, isApiToken, mintApiToken, READ_ROUTES, routeFamily } from './api-tokens.ts';
import { redactRunForScope } from './run-projection.ts';
import { AuthService } from './service.ts';
import { issueSetupCode, readAuthStore } from './store.ts';
import { base32Decode, hotp, totpStep } from './totp.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const META = { address: '203.0.113.7', label: 'Chrome on macOS' };

describe('API token values', () => {
  it('are ceztok_<hex id>_<secret>, and only those parse', () => {
    const { id, value } = mintApiToken();
    expect(value.startsWith(`ceztok_${id}_`)).toBe(true);
    expect(isApiToken(value)).toBe(true);
    expect(apiTokenIdOf(value)).toBe(id);
    expect(apiTokenIdOf('ceztok_nothex000000_aaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(apiTokenIdOf(`ceztok_${id}_short`)).toBeNull();
    expect(apiTokenIdOf(`cezrun_${id}_aaaaaaaaaaaaaaaaaaaaaaaa`)).toBeNull();
  });
});

describe('API token scopes, per route family', () => {
  it('reads the family off a scoped or unscoped path, and the workspace sub-family', () => {
    expect(routeFamily('/api/v1/runs/1/messages')).toBe('runs');
    expect(routeFamily('/api/v1/p/proj/runs')).toBe('runs');
    expect(routeFamily('/api/v1/workspace/dashboard/costs')).toBe('workspace/dashboard');
    expect(routeFamily('/elsewhere')).toBeNull();
  });

  it('read is the allowlisted GETs and no write', () => {
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/p/x/runs')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/workflows')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/runs/1/files')).toBe(true);
    expect(apiTokenAllows(['read'], 'POST', '/api/v1/runs')).toBe(false);
    expect(apiTokenAllows(['read'], 'DELETE', '/api/v1/runs/1')).toBe(false);
  });

  it('read never covers a read that hands out a credential or raw config', () => {
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/launch-key')).toBe(false);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/agent-config/claude-settings')).toBe(false);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/env-files/content')).toBe(false);
    expect(apiTokenAllows(['author'], 'GET', '/api/v1/env-files/content')).toBe(true);
    expect(apiTokenAllows(['admin'], 'GET', '/api/v1/launch-key')).toBe(true);
  });

  it('read is an allowlist: secrets, shells and logs stay out, and a GET nobody listed is refused', () => {
    for (const path of [
      '/api/v1/secrets',
      '/api/v1/workspace/secrets',
      '/api/v1/env-files',
      '/api/v1/config',
      '/api/v1/workspace/config',
      '/api/v1/agent-config',
      '/api/v1/fs/browse',
      '/api/v1/tracker/connection',
      '/api/v1/tracker/connection/sources',
      '/api/v1/services/web/logs',
      '/api/v1/services/web/output',
      '/api/v1/repo/terminal/s1/output',
      '/api/v1/runs/1/terminal/s1/output',
      '/api/v1/worktree-lifecycle/operations/o1/output',
      '/api/v1/workspace/agent-profiles/a1/details',
      '/api/v1/workflows/brand-new-read',
    ]) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
    }
    // A literal route beats the parameter route it would also match.
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/tracker/T-1')).toBe(true);
  });

  it('read carries no transcript: that is runs.transcript, which tasks implies', () => {
    const transcript = [
      '/api/v1/runs/1/events', '/api/v1/p/x/runs/1/history', '/api/v1/runs/1/history-context',
      // The handoff and the todo inbox quote what the agent wrote.
      '/api/v1/runs/1/handoff', '/api/v1/p/x/todos',
    ];
    for (const path of transcript) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
      expect(apiTokenAllows(['runs.transcript'], 'GET', path), path).toBe(true);
      expect(apiTokenAllows(['tasks'], 'GET', path), path).toBe(true);
    }
    // The list and the summary stay read's.
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/runs')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/runs/1')).toBe(true);
    // runs.transcript is the transcript and nothing else.
    expect(apiTokenAllows(['runs.transcript'], 'GET', '/api/v1/runs/1/files')).toBe(false);
    expect(apiTokenAllows(['runs.transcript'], 'POST', '/api/v1/runs/1/history')).toBe(false);
  });

  it('a service’s command and the start command are author’s to read, not read’s', () => {
    for (const path of ['/api/v1/services', '/api/v1/p/x/start-app']) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
      expect(apiTokenAllows(['author'], 'GET', path), path).toBe(true);
    }
    // Reading them is all author gets: pinning and setting stay admin's.
    expect(apiTokenAllows(['author'], 'POST', '/api/v1/services')).toBe(false);
    expect(apiTokenAllows(['author'], 'PUT', '/api/v1/start-app')).toBe(false);
    expect(apiTokenAllows(['author'], 'GET', '/api/v1/services/web/logs')).toBe(false);
  });

  it('automations are author’s to read: their tasks are commands and prompts, their log quotes gh and the tracker', () => {
    for (const path of [
      '/api/v1/automations', '/api/v1/p/x/automations/a1', '/api/v1/automation-log', '/api/v1/automation-checks/c1',
      '/api/v1/workspace/automation-templates',
    ]) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
      expect(apiTokenAllows(['author'], 'GET', path), path).toBe(true);
    }
    // The dashboard's automation activity is counts and states, and stays read's.
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/workspace/dashboard/automations')).toBe(true);
  });

  it('read carries nothing the user typed or pasted: drafts, attachments and saved cockpit state', () => {
    for (const path of [
      '/api/v1/runs/1/drafts', '/api/v1/runs/1/drafts/composer/images/i1', '/api/v1/runs/1/images/shot.png',
      // The cockpit's own prefs: an open bag, prompt templates among them.
      '/api/v1/ui-state', '/api/v1/workspace/ui-state',
      // cezar's own task titles and commit subjects, and a GitHub round trip.
      '/api/v1/workspace/self-update/development',
    ]) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
    }
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/runs/1/drafts')).toBe(true);
  });

  it('every route the read allowlist names is a real GET route', () => {
    const gets = new Set(Object.keys(routeContracts).filter((key) => key.startsWith('GET ')).map((key) => key.slice(4)));
    expect([...READ_ROUTES].filter((route) => !gets.has(route))).toEqual([]);
  });

  it('tasks writes runs and their kin, and nothing an author or admin owns', () => {
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/p/x/runs')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/runs/1/messages')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/runs/1/history')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/workflows')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'PUT', '/api/v1/config')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/config')).toBe(false);
  });

  it('a task terminal is admin’s: tasks and author never get a shell on the host', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/runs/1/terminal'],
      ['GET', '/api/v1/runs/1/terminal'],
      ['POST', '/api/v1/p/x/runs/1/terminal/s1/input'],
      ['GET', '/api/v1/runs/1/terminal/s1/output'],
      ['DELETE', '/api/v1/runs/1/terminal/s1'],
    ] as const) {
      expect(apiTokenAllows(['read', 'tasks', 'author'], method, path), `${method} ${path}`).toBe(false);
      expect(apiTokenAllows(['admin'], method, path), `${method} ${path}`).toBe(true);
    }
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/runs/1/terminals-are-not-a-prefix')).toBe(true);
  });

  it('a tracker connection and project link are author’s; tasks keeps tickets and watches', () => {
    for (const [method, path] of [
      ['PUT', '/api/v1/tracker/connection'],
      ['DELETE', '/api/v1/tracker/connection'],
      ['POST', '/api/v1/p/x/tracker/connection/copy'],
      ['GET', '/api/v1/tracker/connection'],
      ['PUT', '/api/v1/tracker/association'],
      ['DELETE', '/api/v1/tracker/association'],
    ] as const) {
      expect(apiTokenAllows(['tasks'], method, path), `${method} ${path}`).toBe(false);
      expect(apiTokenAllows(['author'], method, path), `${method} ${path}`).toBe(true);
      expect(apiTokenAllows(['admin'], method, path), `${method} ${path}`).toBe(true);
    }
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/tracker/T-1/transition')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/tracker/watch')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/tracker/association')).toBe(true);
  });

  it('author writes workflows, skills, automations and env files', () => {
    for (const path of ['/api/v1/workflows', '/api/v1/skills/refresh', '/api/v1/automations', '/api/v1/env-files/render']) {
      expect(apiTokenAllows(['author'], 'POST', path), path).toBe(true);
    }
    expect(apiTokenAllows(['author'], 'POST', '/api/v1/runs')).toBe(false);
    expect(apiTokenAllows(['author'], 'POST', '/api/v1/workspace/self-update/apply')).toBe(false);
  });

  it('admin is everything but sign-in; every token may discover projects and reach the MCP transport', () => {
    expect(apiTokenAllows(['admin'], 'POST', '/api/v1/workspace/self-update/apply')).toBe(true);
    expect(apiTokenAllows(['admin'], 'GET', '/api/v1/auth/tokens')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/projects')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/projects')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/mcp')).toBe(true);
    expect(apiTokenAllows([], 'POST', '/api/v1/mcp')).toBe(false);
  });

  it('fails closed on a family nobody mapped', () => {
    expect(apiTokenAllows(['read', 'tasks', 'author'], 'POST', '/api/v1/brand-new-family')).toBe(false);
    expect(apiTokenAllows(['admin'], 'POST', '/api/v1/brand-new-family')).toBe(true);
  });

  it('the docs say what a scope cannot stop: tasks and author run code as the cezar user', () => {
    const repo = join(import.meta.dirname, '../../../..');
    const reference = readFileSync(join(repo, 'docs/reference.md'), 'utf8').replace(/\s+/g, ' ');
    const spec = readFileSync(join(repo, '.ai/specs/2026-10-24-cezar-mcp-server.md'), 'utf8').replace(/\s+/g, ' ');
    for (const text of [reference, spec]) {
      expect(text).toContain('bounds the API');
      expect(text).toMatch(/`tasks` and `author`[^.]*owner-equivalent/);
      expect(text).toMatch(/`read` is the only scope that executes nothing/);
    }
    expect(reference).not.toContain('never include shell access');
  });
});

/**
 * What `read` may say in free text, per route and per field (spec 2026-10-24-cezar-mcp-server §4).
 * Field names come from each route's response schema in the contract; a field whose name ends in
 * one of {@link FREE_TEXT_WORDS} is free text, and a `read` route may return one only when it is
 * listed here with where its words come from. A new read route, or a new free-text field on one,
 * fails until someone decides it is not an agent's, a command's or a configured value.
 */
const FREE_TEXT_WORDS = [
  'title', 'task', 'summary', 'log', 'error', 'errors', 'output', 'body', 'message', 'messages', 'excerpt',
  'reason', 'detail', 'command', 'prompt', 'text', 'subject', 'description', 'content', 'stdout', 'stderr',
  'note', 'comment', 'preview', 'result', 'evidence', 'effects', 'suggestions', 'questions', 'hint', 'action',
  'criteria',
];

/**
 * Where a read route's free text comes from:
 * - `projected`: the handler projects it for a token without `runs.transcript` (or `admin`) —
 *   `auth/run-projection.ts`, the lifecycle and self-update views, each proven in
 *   `server/token-run-view.test.ts`. What survives is the user's own task text and failure kinds.
 * - `repository`: the repository's files and history, and its committable workflows and skills —
 *   what `/repo/files` serves anyone.
 * - `forge`: GitHub's or the tracker's own text, which the token's owner reads there anyway.
 * - `degrade`: why a source answered nothing — cezar's phrase, or a forge client's first error line.
 */
type FreeTextOrigin = 'projected' | 'repository' | 'forge' | 'degrade';

/** A task record's free text and open paths; `/runs` names the same ones under `[]`. */
const RUN_FREE_TEXT = [
  'title', 'titleSummary', 'task', 'queuedMessages', 'queuedMessages[].text', 'promptQueue[].text', 'systemPrompt',
  'trackerLinks[].title', 'dispatch.report.result', 'dispatch.report.evidence', 'dispatch.report.side_effects',
  'dispatch.report.errors', 'dispatch.report.recommended_next_action', 'dispatch.report.suggestions',
  'dispatch.pendingReports[].title', 'dispatch.pendingReports[].report.result', 'dispatch.pendingReports[].report.evidence',
  'dispatch.pendingReports[].report.side_effects', 'dispatch.pendingReports[].report.errors',
  'dispatch.pendingReports[].report.recommended_next_action', 'dispatch.pendingReports[].report.suggestions',
  'dispatch.pendingAsk.questions', 'graphState.outputs.*', 'graphState.outputs.*.*',
  'landing.error', 'error', 'steps[].error', 'workflowDef.description', 'workflowDef.steps[].prompt',
  'workflowDef.steps[].command', 'workflowDef.graph.nodes[].prompt', 'workflowDef.graph.nodes[].command',
  'workflowDef.graph.nodes[].message', 'workflowDef.graph.nodes[].title', 'workflowDef.graph.nodes[].body',
];

/** What a projected task record keeps verbatim: the user's own task text and the tracker's title.
 *  An agent's `CEZ:TITLE` (titleOrigin `marker`) lands in `titleSummary`, never `title`. */
const RUN_SURVIVES = ['title', 'task', 'trackerLinks[].title'];

const READ_FREE_TEXT: Record<string, { from: FreeTextOrigin; fields: string[]; also?: { from: FreeTextOrigin; fields: string[] } }> = {
  '/runs': { from: 'projected', fields: RUN_FREE_TEXT.map((field) => `[].${field}`) },
  '/runs/:id': { from: 'projected', fields: RUN_FREE_TEXT },
  '/groups/:groupId': { from: 'projected', fields: ['runs[].title', 'runs[].handoffExcerpt'] },
  '/worktrees': { from: 'projected', fields: ['worktrees[].title'] },
  '/worktree-lifecycle': { from: 'projected', fields: [
    'worktrees[].task', 'worktrees[].task.title', 'worktrees[].operation.error', 'worktrees[].operation.history[].commandPreview',
    'worktrees[].operation.history[].reason', 'worktrees[].operation.entries[].commandPreview', 'worktrees[].error',
  ] },
  '/worktree-lifecycle/:worktreeId': { from: 'projected', fields: [
    'worktree.task', 'worktree.task.title', 'worktree.operation.error', 'worktree.operation.history[].commandPreview',
    'worktree.operation.history[].reason', 'worktree.operation.entries[].commandPreview', 'worktree.error',
    'worktree.history[].error', 'worktree.history[].history[].commandPreview', 'worktree.history[].history[].reason',
    'worktree.history[].entries[].commandPreview',
  ] },
  '/worktree-lifecycle/operations/:operationId': { from: 'projected', fields: [
    'operation.error', 'operation.history[].commandPreview', 'operation.history[].reason', 'operation.entries[].commandPreview',
  ] },
  '/workspace/runs-index': { from: 'projected', fields: ['runs[].title', 'runs[].titleSummary'] },
  '/workspace/dashboard': { from: 'projected', fields: [
    'coverage.projects[].reason', 'questions', 'questions.rows[].title', 'questions.rows[].titleSummary', 'reviews.rows[].title', 'reviews.rows[].titleSummary',
  ] },
  '/workspace/dashboard/costs': { from: 'projected', fields: ['coverage.projects[].reason', 'tasks.rows[].title'] },
  '/workspace/dashboard/feed': { from: 'projected', fields: [
    'rows[].run.title', 'rows[].run.titleSummary', 'rows[].title', 'sources[].reason', 'coverage.projects[].reason',
  ] },
  '/workspace/dashboard/insights': { from: 'projected', fields: [
    'coverage.projects[].reason', 'failures.reasons[].latest.title', 'failures.reasons[].latest.message',
  ] },
  '/workspace/dashboard/overview': { from: 'projected', fields: ['coverage.projects[].reason', 'page.rows[].title', 'page.rows[].titleSummary'] },
  '/workspace/dashboard/tasks': { from: 'projected', fields: ['coverage.projects[].reason', 'page.rows[].title', 'page.rows[].titleSummary'] },
  '/workspace/self-update': { from: 'projected', fields: [
    'reason', 'job.log', 'job.error', 'installed[].commit.subject', 'branch.running.subject', 'branch.tip.subject', 'branch.error',
  ] },
  '/repo': { from: 'repository', fields: ['log', 'log[].subject', 'checkedOutElsewhere.*'] },
  '/repo/search': { from: 'repository', fields: ['matches[].text'] },
  '/repo/sync': { from: 'repository', fields: ['incoming[].subject'] },
  '/runs/:id/commits': { from: 'repository', fields: ['commits[].subject'] },
  '/runs/:id/search': { from: 'repository', fields: ['matches[].text'] },
  '/skills': { from: 'repository', fields: ['[].description', '[].body'] },
  '/skills/importable': { from: 'repository', fields: ['[].description', '[].body'] },
  '/workflows': { from: 'repository', fields: [
    'workflows[].description', 'workflows[].steps[].prompt', 'workflows[].steps[].command', 'workflows[].graph.nodes[].prompt',
    'workflows[].graph.nodes[].command', 'workflows[].graph.nodes[].message', 'workflows[].graph.nodes[].title',
    'workflows[].graph.nodes[].body', 'issues[].message',
  ] },
  '/workflows/nodes': { from: 'repository', fields: ['nodes[].description'] },
  '/github': { from: 'forge', fields: ['reason', 'issues[].title', 'issues[].body', 'prs[].title', 'prs[].body', 'labelColors.*'] },
  '/github/comments/:kind/:number': { from: 'forge', fields: [
    'reason', 'comments[].body', 'events[].message', 'events[].subject', 'events[].refTitle', 'detail', 'detail.body',
  ] },
  '/github/prs/:number/merge-state': { from: 'forge', fields: ['mergeState.title', 'mergeState.checksReason', 'mergeState.blockers[].message', 'reason'] },
  '/github/search': { from: 'forge', fields: ['reason', 'items[].title', 'items[].body', 'labelColors.*'] },
  '/runs/:id/tracker-issue': { from: 'forge', fields: ['item.title', 'item.body', 'comments.items[].body', 'comments.reason', 'reason'] },
  '/tracker': { from: 'forge', fields: ['items[].title', 'items[].body', 'reason'] },
  '/tracker/:id': { from: 'forge', fields: ['item.title', 'item.body', 'comments.items[].body', 'comments.reason', 'reason'] },
  '/tracker/search': { from: 'forge', fields: ['items[].title', 'items[].body', 'reason'] },
  '/tracker/watch/:watchId': { from: 'forge', fields: ['result', 'result.items[].title', 'result.items[].body', 'result.reason'] },
  '/docker': { from: 'degrade', fields: ['reason'], also: { from: 'projected', fields: ['stacks[].task', 'stacks[].task.title'] } },
  '/github/checks': { from: 'degrade', fields: ['reason'] },
  '/github/prs/:number/changes': { from: 'degrade', fields: ['reason'] },
  '/providers/status': { from: 'degrade', fields: ['providers[].hint'] },
  '/github/ref-status': { from: 'degrade', fields: ['reason'] },
  '/tracker/:id/transitions': { from: 'degrade', fields: ['targets[].reason', 'reason'] },
  '/tracker/automation-options': { from: 'degrade', fields: ['reason'] },
  '/tracker/candidates': { from: 'degrade', fields: ['reason'] },
  '/workspace/host-usage': { from: 'degrade', fields: ['admission.reason'] },
  '/workspace/skills-update': { from: 'degrade', fields: ['scopes[].reason'] },
};

/** Read routes the contract gives no JSON body to pin, and what they hand out instead. */
const READ_WITHOUT_SCHEMA: Record<string, 'projected stream' | 'image' | 'repository'> = {
  '/events': 'projected stream',
  '/workspace/events': 'projected stream',
  '/projects/:projectId/icon': 'image',
  '/workspace/branding-logo': 'image',
  '/repo/commit/:sha': 'repository',
  '/repo/diff': 'repository',
  '/repo/files': 'repository',
  '/runs/:id/commit/:sha': 'repository',
  '/runs/:id/diff': 'repository',
  '/runs/:id/files': 'repository',
};

// zod's internal def, read structurally: the walk needs no schema type.
const defOf = (node: unknown) => (node as { _zod?: { def: Record<string, any> } } | undefined)?._zod?.def;

/** Whether a value of this schema can carry a string anywhere (a record of counts cannot). */
function holdsText(node: unknown, seen = new Set<unknown>()): boolean {
  const def = defOf(node);
  if (!def || seen.has(node)) return false;
  seen.add(node);
  switch (def.type) {
    case 'string': case 'unknown': case 'any': case 'template_literal': return true;
    case 'object': return Object.values(def.shape as Record<string, unknown>).some((value) => holdsText(value, seen))
      || Boolean(def.catchall && def.catchall._zod.def.type !== 'never');
    case 'array': return holdsText(def.element, seen);
    case 'record': return holdsText(def.valueType, seen);
    case 'union': return (def.options as unknown[]).some((option) => holdsText(option, seen));
    case 'intersection': return holdsText(def.left, seen) || holdsText(def.right, seen);
    case 'tuple': return (def.items as unknown[]).some((item) => holdsText(item, seen));
    case 'lazy': return holdsText(def.getter(), seen);
    case 'pipe': return holdsText(def.out._zod.def.type === 'transform' ? def.in : def.out, seen);
    default: return def.innerType ? holdsText(def.innerType, seen) : false;
  }
}

/**
 * Every field path a response schema names (`a.b[].c`), and the OPEN paths: an object that passes
 * unknown keys through, or a record whose values can hold text (`graphState.outputs.*`) — its
 * keys are nobody's field names, so a name-based pin cannot judge what it carries.
 */
function responseFields(schema: z.ZodType): { fields: string[]; open: string[]; textual: string[] } {
  const fields = new Set<string>();
  const textual = new Set<string>();
  const open = new Set<string>();
  const seen = new Set<unknown>();
  const join = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);
  const walk = (node: unknown, prefix: string): void => {
    const def = defOf(node);
    if (!def || seen.has(node)) return;
    seen.add(node);
    switch (def.type) {
      case 'object':
        for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
          fields.add(join(prefix, key));
          if (holdsText(value)) textual.add(join(prefix, key));
          walk(value, join(prefix, key));
        }
        if (def.catchall && def.catchall._zod.def.type !== 'never') open.add(join(prefix, '*'));
        break;
      case 'array': walk(def.element, `${prefix}[]`); break;
      case 'record':
        if (holdsText(def.valueType)) open.add(join(prefix, '*'));
        walk(def.valueType, join(prefix, '*'));
        break;
      case 'union': for (const option of def.options as unknown[]) walk(option, prefix); break;
      case 'intersection': walk(def.left, prefix); walk(def.right, prefix); break;
      case 'tuple': for (const item of def.items as unknown[]) walk(item, `${prefix}[]`); break;
      case 'lazy': walk(def.getter(), prefix); break;
      case 'pipe': walk(def.out._zod.def.type === 'transform' ? def.in : def.out, prefix); break;
      default: if (def.innerType) walk(def.innerType, prefix);
    }
    seen.delete(node);
  };
  walk(schema, '');
  return { fields: [...fields], open: [...open], textual: [...textual] };
}

/** Every value at a field path (`a.b[].c`, `outputs.*`); `[]` and `*` fan out, a missing key yields none. */
function valuesAt(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of path.split('.')) {
    const many = segment.endsWith('[]');
    const key = many ? segment.slice(0, -2) : segment;
    let next: unknown[] = [];
    for (const value of current) {
      if (value === null || typeof value !== 'object') continue;
      if (key === '') next.push(value);
      else if (key === '*') next.push(...Object.values(value));
      else if ((value as Record<string, unknown>)[key] !== undefined) next.push((value as Record<string, unknown>)[key]);
    }
    if (many) next = next.flatMap((value) => (Array.isArray(value) ? value : []));
    current = next;
  }
  return current;
}

/** A field is free text when its name's last word is one of {@link FREE_TEXT_WORDS}. */
function isFreeText(path: string): boolean {
  const name = path.split('.').pop()!.replace(/\[\]$/, '');
  return FREE_TEXT_WORDS.includes(name.split(/(?=[A-Z])|_/).pop()!.toLowerCase());
}

describe('what read may say, per route and field', () => {
  const contracts = routeContracts as Record<string, { response?: z.ZodType }>;

  it('every read route has a pinned response, or says why it has none', () => {
    expect([...READ_ROUTES].filter((route) => !contracts[`GET ${route}`]?.response && !(route in READ_WITHOUT_SCHEMA))).toEqual([]);
    expect(Object.keys(READ_WITHOUT_SCHEMA).filter((route) => !READ_ROUTES.has(route) || contracts[`GET ${route}`]?.response)).toEqual([]);
  });

  it('no read route returns free text it has not declared, nor an object open to any key', () => {
    const drift: Record<string, { undeclared?: string[]; stale?: string[]; open?: string[] }> = {};
    for (const route of READ_ROUTES) {
      const schema = contracts[`GET ${route}`]?.response;
      if (!schema) continue;
      const { open: openPaths, textual } = responseFields(schema);
      const declared = [...(READ_FREE_TEXT[route]?.fields ?? []), ...(READ_FREE_TEXT[route]?.also?.fields ?? [])];
      // A count or an enum named `questions` or `action` says nothing.
      const free = textual.filter(isFreeText);
      const undeclared = free.filter((field) => !declared.includes(field));
      // An open path fails like an undeclared field until a route lists it.
      const open = openPaths.filter((path) => !declared.includes(path));
      const stale = declared.filter((field) => !free.includes(field) && !openPaths.includes(field));
      if (undeclared.length || stale.length || open.length) {
        drift[route] = { ...(undeclared.length ? { undeclared } : {}), ...(stale.length ? { stale } : {}), ...(open.length ? { open } : {}) };
      }
    }
    expect(drift).toEqual({});
    expect(Object.keys(READ_FREE_TEXT).filter((route) => !READ_ROUTES.has(route))).toEqual([]);
  });

  it('a task record’s listed fields are absent or reduced on the projected record, but the user’s own', () => {
    const full = agentWrittenRun();
    const projected = redactRunForScope(full, ['read']);
    const kept: string[] = [];
    for (const [route, sample, original] of [['/runs/:id', projected, full], ['/runs', [projected], [full]]] as const) {
      for (const field of READ_FREE_TEXT[route]!.fields) {
        const before = valuesAt(original, field);
        // The fixture fills every listed field, or this check proves nothing about it.
        expect(before.length, `${route} ${field}: the fixture leaves it empty`).toBeGreaterThan(0);

        const after = valuesAt(sample, field);
        if (RUN_SURVIVES.includes(field.replace(/^\[\]\./, ''))) {
          expect(after, `${route} ${field}`).toEqual(before);
          kept.push(field);
        } else {
          expect(JSON.stringify(before), `${route} ${field}: the fixture writes no marker there`).toContain(AGENT_WRITTEN);
          expect(JSON.stringify(after), `${route} ${field}`).not.toContain(AGENT_WRITTEN);
        }
      }
    }
    expect(kept).toHaveLength(RUN_SURVIVES.length * 2);
  });

  it('sees nested, optional, array, union and open fields', () => {
    const schema = z.object({
      id: z.string(),
      rows: z.array(z.object({ titleSummary: z.string().optional(), outputTokens: z.number() })).nullable(),
      job: z.union([z.object({ log: z.array(z.string()) }), z.object({ projected: z.literal(true) })]),
      bag: z.looseObject({ ok: z.boolean() }),
      loops: z.record(z.string(), z.number()),
      outputs: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()]))).optional(),
      report: z.object({ result: z.string(), side_effects: z.array(z.string()) }),
    });
    const { fields, open, textual } = responseFields(schema);
    expect(textual.filter(isFreeText).sort()).toEqual(['job.log', 'report.result', 'report.side_effects', 'rows[].titleSummary']);
    expect(fields).toContain('rows[].outputTokens');
    // A record of counts is closed; a record of text is open, however deep it nests.
    expect(open.sort()).toEqual(['bag.*', 'outputs.*', 'outputs.*.*']);
    expect(isFreeText('steps[].error')).toBe(true);
  });
});

describe('API tokens in the auth store', () => {
  let dir: string;
  let storePath: string;
  let now: number;
  let service: AuthService;
  let secret: string;
  let userId: string;

  const code = (at = now) => hotp(base32Decode(secret)!, totpStep(at));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cez-tokens-'));
    storePath = join(dir, 'auth.json');
    process.env.CEZ_HOME = dir;
    now = Date.UTC(2026, 9, 24, 12, 0, 0);
    service = new AuthService({ storePath, sessionsPath: join(dir, 'auth-sessions.json'), scrypt: FAST, now: () => now });
    const issued = issueSetupCode({ path: storePath, now });
    if (!issued.ok) throw new Error('setup refused');
    const begun = await service.beginSetup({ code: issued.setup.code, username: 'mateusz', password: 'a long enough password' }, META);
    if (!begun.ok) throw new Error(begun.error);
    secret = begun.secret;
    const done = service.completeSetup({ ticket: begun.ticket, code: code() }, META);
    if (!done.ok) throw new Error(done.error);
    userId = done.user.id;
    now += 31_000; // the next time step: setup spent this one
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mints with a fresh authenticator code, stores only the hash, and verifies the value', () => {
    expect(service.createApiToken(userId, { name: 'laptop', scopes: ['tasks'], code: '000000' }, META)).toMatchObject({ ok: false, status: 401 });
    const created = service.createApiToken(userId, { name: 'laptop', scopes: ['tasks', 'tasks'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(created.token).toMatchObject({ name: 'laptop', scopes: ['tasks'] });
    expect(readFileSync(storePath, 'utf8')).not.toContain(created.value);
    expect(service.verifyApiToken(created.value)).toMatchObject({ tokenId: created.token.id, scopes: ['tasks'], user: { name: 'mateusz' } });
    expect(service.verifyApiToken(`${created.value}x`)).toBeNull();
    expect(service.verifyApiToken(created.value.replace(/_[^_]+$/, '_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'))).toBeNull();
  });

  it('lists with last use, revokes, and a revoked token opens nothing', () => {
    const created = service.createApiToken(userId, { name: 'ci', scopes: ['read'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(service.listApiTokens(userId)[0]?.lastUsedAt).toBeUndefined();
    service.verifyApiToken(created.value, { touch: true });
    expect(service.listApiTokens(userId)[0]?.lastUsedAt).toBe(new Date(now).toISOString());
    expect(service.revokeApiToken('someone-else', created.token.id)).toBe(false);
    expect(service.revokeApiToken(userId, created.token.id)).toBe(true);
    expect(service.verifyApiToken(created.value)).toBeNull();
    expect(service.listApiTokens(userId)).toEqual([]);
  });

  it('expires, and refuses an expiry in the past', () => {
    expect(service.createApiToken(userId, { name: 'old', scopes: ['read'], code: code(), expiresAt: new Date(now - 1).toISOString() }, META))
      .toMatchObject({ ok: false, status: 400 });
    const created = service.createApiToken(userId, { name: 'day', scopes: ['read'], code: code(), expiresAt: new Date(now + 86_400_000).toISOString() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(service.verifyApiToken(created.value)).not.toBeNull();
    now += 86_400_000;
    expect(service.verifyApiToken(created.value)).toBeNull();
  });

  it('dies with "sign out everywhere else" and with a password change', async () => {
    const mint = (name: string) => {
      const created = service.createApiToken(userId, { name, scopes: ['read'], code: code() }, META);
      if (!created.ok) throw new Error(created.error);
      now += 31_000;
      return created.value;
    };
    const first = mint('a');
    service.revokeOtherSessions(userId, 'this-session');
    expect(service.verifyApiToken(first)).toBeNull();
    const second = mint('b');
    const changed = await service.changePassword(userId, 'this-session', { currentPassword: 'a long enough password', code: code(), newPassword: 'another long password' }, META);
    expect(changed.ok).toBe(true);
    expect(service.verifyApiToken(second)).toBeNull();
    expect(service.listApiTokens(userId)).toEqual([]);
  });

  it('the trusted operator lists and revokes every user\'s tokens', () => {
    const created = service.createApiToken(userId, { name: 'ci', scopes: ['read'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(service.listApiTokens(undefined).map((token) => token.id)).toEqual([created.token.id]);
    expect(service.revokeApiToken(undefined, created.token.id)).toBe(true);
    expect(service.verifyApiToken(created.value)).toBeNull();
  });

  it('dies with an account reset, and one bad row on disk never revokes the rest', () => {
    const created = service.createApiToken(userId, { name: 'ci', scopes: ['read'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { tokens: unknown[] };
    expect(readAuthStore(storePath).tokens).toHaveLength(1);
    raw.tokens.push({ id: 'not-an-id' });
    writeFileSync(storePath, JSON.stringify(raw));
    expect(readAuthStore(storePath).tokens).toHaveLength(1);
    expect(service.verifyApiToken(created.value)).not.toBeNull();
    expect(issueSetupCode({ path: storePath, now, resetUser: 'mateusz' }).ok).toBe(true);
    expect(service.verifyApiToken(created.value)).toBeNull();
    expect(readAuthStore(storePath).tokens).toEqual([]);
  });
});
