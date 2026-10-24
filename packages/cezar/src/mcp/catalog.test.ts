import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeContractOf, routeContracts } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from '../server/server.ts';
import { jsonZodValidator, queryZodValidator, routeInputOf } from '../server/validators.ts';
import { buildCatalog, DEFAULT_TOOL_SETS, destructiveHintOf, jsonSchemaOf, selectTools, toolSetsOf, type Catalog, type RouteRow } from './catalog.ts';
import { requestFor } from './execute.ts';
import { PROMPT_TOOLS } from './server.ts';

/**
 * The generator over a BUILT app's route table (spec 2026-10-24-cezar-mcp-server §8): every route
 * has a route-table entry (the build's rule), every tool's schemas are its route's contract, the
 * sets partition the catalog. Read off `app.routes`, so tomorrow's route is covered unasked.
 */
describe('the MCP tool catalog', () => {
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let routes: RouteRow[];
  let catalog: Catalog;
  let problems: { missing: string[]; stale: string[] };
  const savedHome = process.env.CEZ_HOME;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-catalog-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-catalog-repo-'));
    process.env.CEZ_HOME = home;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const app = createApp({ repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' });
    routes = app.routes;
    ({ catalog, problems } = buildCatalog(routes));
  });

  afterAll(async () => {
    store.flush();
    await removeTempDir(home, repoRoot);
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it('every served route has a route-table entry, and every entry is a served route', () => {
    expect(problems.missing, 'add these to packages/contract/src/routes.ts').toEqual([]);
    expect(problems.stale, 'these entries name routes the cockpit does not serve').toEqual([]);
  });

  it('reports a route that has no entry instead of inventing a tool for it', () => {
    const { catalog: extra, problems: found } = buildCatalog([...routes, { method: 'POST', path: '/api/v1/brand-new', handler: () => {} }]);
    expect(found.missing).toEqual(['POST /brand-new']);
    expect(extra.tools).toHaveLength(catalog.tools.length);
  });

  it('is not vacuous: most of the API is tools, and streams, bytes, sign-in and MCP itself are not', () => {
    expect(catalog.tools.length).toBeGreaterThan(200);
    const paths = new Set(catalog.tools.map((tool) => `${tool.method} ${tool.path}`));
    for (const absent of ['GET /runs/:id/events', 'GET /events', 'GET /runs/:id/images/:file', 'POST /auth/login', 'GET /auth/tokens', 'POST /mcp']) {
      expect(paths.has(absent), absent).toBe(false);
    }
  });

  it('a tool\'s input is exactly its route\'s validators: path params, query, then the body', () => {
    for (const tool of catalog.tools) {
      const rows = routes.filter((row) => row.method === tool.method && (row.path === `/api/v1${tool.path}` || row.path === `/api/v1/p/:projectId${tool.path}`));
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      for (const name of tool.params) expect(properties[name], `${tool.name}.${name}`).toBeDefined();
      for (const row of rows) {
        const input = routeInputOf(row.handler);
        if (!input || input.target === 'param') continue;
        const schema = jsonSchemaOf(typeof input.schema === 'function' ? input.schema() : input.schema, 'input');
        if (input.target === 'json' && tool.body === 'nested') {
          expect(properties.body, tool.name).toEqual(schema);
          continue;
        }
        const own = (schema.properties ?? {}) as Record<string, unknown>;
        for (const [name, prop] of Object.entries(own)) {
          if (input.target === 'query' && tool.params.includes(name)) continue;
          expect(properties[name], `${tool.name}.${name}`).toEqual(prop);
        }
      }
      // The scope input is cezar's own; a workspace route may still name a project in its path or body.
      if (tool.scoped) expect((properties.projectId as { description?: string }).description, tool.name).toMatch(/projects_list/);
      else if ('projectId' in properties) expect([...tool.params, ...tool.query, ...tool.bodyKeys], tool.name).toContain('projectId');
    }
  });

  it('a tool\'s output is exactly its route-table response, made an object where it is not one', () => {
    let checked = 0;
    for (const tool of catalog.tools) {
      const entry = routeContractOf(tool.method, tool.path)!;
      if (!entry.response) {
        expect(tool.outputSchema, tool.name).toBeUndefined();
        continue;
      }
      checked += 1;
      const schema = jsonSchemaOf(entry.response, 'output');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
      if (tool.outputWrapped) {
        const { $defs, ...rest } = schema;
        expect((tool.outputSchema?.properties as { result: unknown }).result, tool.name).toEqual(rest);
        expect(tool.outputSchema?.$defs, tool.name).toEqual($defs);
      } else {
        expect(tool.outputSchema, tool.name).toEqual({ type: 'object', ...schema });
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('names are unique, valid, and the spec\'s own examples', () => {
    expect(new Set(catalog.tools.map((tool) => tool.name)).size).toBe(catalog.tools.length);
    for (const name of ['runs_create', 'runs_get', 'runs_send_message', 'workflows_put', 'automations_create', 'repo_changes', 'docker_stacks_stop']) {
      expect(catalog.byName.has(name), name).toBe(true);
    }
    for (const name of PROMPT_TOOLS) expect(catalog.byName.has(name), name).toBe(true);
  });

  it('annotates reads, deletes and the steps the cockpit confirms', () => {
    expect(catalog.byName.get('runs_list')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(catalog.byName.get('runs_delete')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(catalog.byName.get('runs_remove_worktree')?.annotations.destructiveHint).toBe(true);
    expect(catalog.byName.get('runs_create')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(catalog.byName.get('github_list')?.annotations.openWorldHint).toBe(true);
    // A backup prunes the older archives past the kept count.
    const backup = [...catalog.byName.values()].find((tool) => tool.method === 'POST' && tool.path === '/workspace/backup');
    expect(backup?.annotations.destructiveHint).toBe(true);
  });

  it('every write route states whether it is destructive — a new one is a decision, not a default', () => {
    const unstated = Object.entries(routeContracts as Record<string, { notTool?: string; destructive?: boolean }>)
      .filter(([key, entry]) => !key.startsWith('GET ') && !entry.notTool && typeof entry.destructive !== 'boolean')
      .map(([key]) => key);
    expect(unstated).toEqual([]);
    // …and a write route that left it out would still be destructive.
    expect(destructiveHintOf('POST', { summary: 'x' })).toBe(true);
    expect(destructiveHintOf('POST', { summary: 'x', destructive: false })).toBe(false);
    expect(destructiveHintOf('GET', { summary: 'x' })).toBe(false);
  });

  it('marks the writes that run a shell, overwrite files or config, push, stop or discard as destructive', () => {
    const destructive = (method: string, path: string) =>
      catalog.tools.find((tool) => tool.method === method && tool.path === path)?.annotations.destructiveHint;
    for (const [method, path] of [
      ['POST', '/runs/:id/terminal'], ['POST', '/runs/:id/terminal/:sessionId/input'],
      ['POST', '/repo/terminal'], ['POST', '/repo/terminal/:sessionId/input'],
      ['PUT', '/repo/files'], ['PUT', '/runs/:id/files'], ['POST', '/runs/:id/files'],
      ['PUT', '/agent-config/:id'], ['PUT', '/config'], ['PUT', '/workspace/config'],
      ['POST', '/repo/push'], ['POST', '/runs/:id/git/push'],
      ['POST', '/docker/containers/:id/stop'], ['POST', '/docker/stacks/:name/stop'],
      ['POST', '/services/:id/stop'], ['POST', '/services/stop-all'],
      ['POST', '/runs/:id/remove-worktree'], ['POST', '/workspace/self-update/apply'],
      // Overwrites what someone wrote, or reaches outside this machine.
      ['POST', '/workflows/graph'], ['POST', '/runs/:id/pr'], ['PUT', '/runs/:id/drafts/:surface'],
      ['PATCH', '/runs/:id/prompt-queue/:msgId'], ['PATCH', '/runs/:id/queued-messages/:msgId'],
      ['PUT', '/projects/:projectId/icon'], ['POST', '/projects/create'],
      ['POST', '/tracker/:id/transition'], ['PUT', '/tracker/association'],
    ] as const) {
      expect(destructive(method, path), `${method} ${path}`).toBe(true);
    }
    expect(destructive('POST', '/runs/:id/messages')).toBe(false);
    expect(destructive('POST', '/runs/read-all')).toBe(false);
  });

  it('tool sets partition the catalog; the default is about thirty tools and covers the prompts', () => {
    const sets = toolSetsOf(catalog);
    const union = sets.flatMap((set) => {
      const picked = selectTools(catalog, set);
      return 'tools' in picked ? picked.tools.map((tool) => tool.name) : [];
    });
    expect(union.length).toBe(catalog.tools.length);
    expect(new Set(union).size).toBe(catalog.tools.length);
    // A new set is a decision someone made, not a family that fell through.
    expect(sets).toEqual(['automations', 'env', 'github', 'projects', 'repo', 'runs', 'services', 'settings', 'skills', 'tasks', 'tracker', 'workflows', 'workspace']);
    const defaults = selectTools(catalog, undefined);
    if (!('tools' in defaults)) throw new Error(defaults.error);
    expect(defaults.tools.length).toBeGreaterThanOrEqual(25);
    expect(defaults.tools.length).toBeLessThanOrEqual(40);
    expect(new Set(defaults.tools.map((tool) => tool.set))).toEqual(new Set(DEFAULT_TOOL_SETS));
    for (const name of PROMPT_TOOLS) expect(defaults.tools.some((tool) => tool.name === name), name).toBe(true);
    expect(selectTools(catalog, 'all')).toEqual({ tools: catalog.tools });
    expect(selectTools(catalog, 'tasks,nope')).toEqual({ error: expect.stringContaining('unknown tool set: nope') });
  });

  it('every route-table key is a well-formed METHOD /path', () => {
    for (const key of Object.keys(routeContracts)) expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/[^\s]*$/);
  });
});

describe('a tool call\'s request', () => {
  const routes: RouteRow[] = [
    { method: 'POST', path: '/api/v1/p/:projectId/runs/:id/messages', handler: jsonZodValidator(z.object({ text: z.string() })) },
    { method: 'POST', path: '/api/v1/runs/:id/messages', handler: jsonZodValidator(z.object({ text: z.string() })) },
    { method: 'GET', path: '/api/v1/repo/search', handler: queryZodValidator(z.object({ q: z.string(), glob: z.array(z.string()).optional() })) },
    { method: 'GET', path: '/api/v1/p/:projectId/repo/search', handler: queryZodValidator(z.object({ q: z.string(), glob: z.array(z.string()).optional() })) },
    { method: 'PUT', path: '/api/v1/p/:projectId/tracker/connection', handler: jsonZodValidator(z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b') })])) },
    { method: 'PUT', path: '/api/v1/tracker/connection', handler: jsonZodValidator(z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b') })])) },
  ];
  const { catalog } = buildCatalog(routes);

  it('fills and encodes path params, scopes to a project only when asked, and sends a flat body', () => {
    const tool = catalog.byName.get('runs_send_message')!;
    expect(tool.body).toBe('flat');
    expect(requestFor(tool, { id: 'a b', text: 'hi' }, 'http://127.0.0.1:4321')).toEqual({
      url: 'http://127.0.0.1:4321/api/v1/runs/a%20b/messages',
      body: '{"text":"hi"}',
    });
    expect(requestFor(tool, { id: 'r1', text: 'hi', projectId: 'p 1' }, 'https://agents.example.dev')).toMatchObject({
      url: 'https://agents.example.dev/api/v1/p/p%201/runs/r1/messages',
    });
    expect(requestFor(tool, { text: 'hi' }, 'http://x')).toEqual({ error: 'missing id' });
  });

  it('refuses a path parameter that could change the route: a slash, a dot segment, a control character', () => {
    const tool = catalog.byName.get('runs_send_message')!;
    for (const id of ['a/b', '..', '.', '../workflows', 'a\\b', 'r1\n', 'r\u00001', '..%2F']) {
      expect(requestFor(tool, { id, text: 'hi' }, 'http://x'), JSON.stringify(id)).toMatchObject({ error: expect.stringMatching(/^invalid id/) });
    }
    for (const projectId of ['..', 'p/q', 'p\t']) {
      expect(requestFor(tool, { id: 'r1', text: 'hi', projectId }, 'http://x'), projectId).toMatchObject({ error: expect.stringMatching(/^invalid projectId/) });
    }
    expect(requestFor(tool, { id: 'a.b-c_1', text: 'hi' }, 'http://x')).toMatchObject({ url: 'http://x/api/v1/runs/a.b-c_1/messages' });
  });

  it('repeats an array query key and sends no body on a GET', () => {
    const tool = catalog.byName.get('repo_search')!;
    expect(requestFor(tool, { q: 'login', glob: ['*.ts', '*.tsx'] }, 'http://x')).toEqual({
      url: 'http://x/api/v1/repo/search?q=login&glob=*.ts&glob=*.tsx',
    });
  });

  it('nests a body that is not one plain object', () => {
    const tool = catalog.byName.get('tracker_connection_put')!;
    expect(tool.body).toBe('nested');
    expect(requestFor(tool, { body: { kind: 'a' } }, 'http://x')).toEqual({ url: 'http://x/api/v1/tracker/connection', body: '{"kind":"a"}' });
  });
});
