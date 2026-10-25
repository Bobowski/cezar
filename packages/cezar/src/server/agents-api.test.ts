import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { personaFileResponseSchema, personasResponseSchema, putPersonaResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/**
 * The agents family (spec 2026-10-24-personas §6): list, read, write and delete the project's
 * personas — and `--as` on the dispatch route, which resolves a persona before the manager sees it.
 */
describe('the agents routes', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let dispatched: unknown[][];
  const savedFlag = process.env.CEZ_DISPATCH;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agents-api-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    dispatched = [];
    process.env.CEZ_DISPATCH = '1';
    const manager = {
      dispatch: (...args: unknown[]) => {
        dispatched.push(args);
        return { id: 'child-1' };
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(async () => {
    if (savedFlag === undefined) delete process.env.CEZ_DISPATCH;
    else process.env.CEZ_DISPATCH = savedFlag;
    store.flush();
    await removeTempDir(repoRoot);
  });

  const agentsDir = () => join(repoRoot, '.ai/cezar/agents');
  const put = (name: string, markdown: string) =>
    apiRequest(app, `/api/v1/agents/${name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown }),
    });

  it('lists nothing — and is editable — when the project has no personas', async () => {
    const res = await apiRequest(app, '/api/v1/agents');
    expect(res.status).toBe(200);
    expect(personasResponseSchema.parse(await res.json())).toEqual({ personas: [], issues: [], editable: true });
  });

  it('writes a persona file byte for byte, reads it back, lists it, and deletes it', async () => {
    const markdown = '---\nname: reviewer\nrunner: claude\n# a comment the editor keeps\n---\nReview.\n';
    const saved = await put('reviewer', markdown);
    expect(saved.status).toBe(200);
    expect(putPersonaResponseSchema.parse(await saved.json()).persona).toMatchObject({ name: 'reviewer', runner: 'claude', source: 'project' });
    expect(readFileSync(join(agentsDir(), 'reviewer.md'), 'utf8')).toBe(markdown);

    const file = personaFileResponseSchema.parse(await (await apiRequest(app, '/api/v1/agents/reviewer')).json());
    expect(file.markdown).toBe(markdown);

    const listed = personasResponseSchema.parse(await (await apiRequest(app, '/api/v1/agents')).json());
    expect(listed.personas.map((p) => p.name)).toEqual(['reviewer']);

    const removed = await apiRequest(app, '/api/v1/agents/reviewer', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(existsSync(join(agentsDir(), 'reviewer.md'))).toBe(false);
  });

  it('refuses a file that does not validate, or that names another persona, writing nothing', async () => {
    const bad = await put('reviewer', '---\nrunner: nope\n---\nx');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('runner: must be one of');
    const renamed = await put('reviewer', '---\nname: writer\n---\nx');
    expect(renamed.status).toBe(400);
    expect(existsSync(agentsDir())).toBe(false);
  });

  it("never overwrites another persona's file: x.md that names itself z is z's, not x's", async () => {
    mkdirSync(agentsDir(), { recursive: true });
    const theirs = '---\nname: z\n---\nI am z.\n';
    writeFileSync(join(agentsDir(), 'x.md'), theirs);
    const res = await put('x', '---\nname: x\n---\nI am x.\n');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/x\.md already holds the "z" persona/);
    expect(readFileSync(join(agentsDir(), 'x.md'), 'utf8')).toBe(theirs);
    // z itself still saves to its own file.
    expect((await put('z', '---\nname: z\n---\nStill z.\n')).status).toBe(200);
    expect(readFileSync(join(agentsDir(), 'x.md'), 'utf8')).toBe('---\nname: z\n---\nStill z.\n');
  });

  it('400s a name that is not a file stem', async () => {
    expect((await put('..%2Fevil', 'x')).status).toBe(400);
  });

  it('never deletes a Claude subagent file — it is listed read-only', async () => {
    mkdirSync(join(repoRoot, '.claude/agents'), { recursive: true });
    writeFileSync(join(repoRoot, '.claude/agents/helper.md'), '---\nname: helper\n---\nHelp.');
    const listed = personasResponseSchema.parse(await (await apiRequest(app, '/api/v1/agents')).json());
    expect(listed.personas).toEqual([expect.objectContaining({ name: 'helper', source: 'claude', runner: 'claude' })]);
    const res = await apiRequest(app, '/api/v1/agents/helper', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(existsSync(join(repoRoot, '.claude/agents/helper.md'))).toBe(true);
  });

  it('dispatch --as hands the manager the resolved persona, and 400s an unknown one', async () => {
    mkdirSync(agentsDir(), { recursive: true });
    writeFileSync(join(agentsDir(), 'reviewer.md'), '---\nrunner: codex\n---\nReview.');
    const post = (body: unknown) =>
      apiRequest(app, '/api/v1/runs/parent-1/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ok = await post({ objective: 'review it', as: 'reviewer' });
    expect(ok.status).toBe(201);
    expect(dispatched[0]).toEqual([
      'parent-1',
      { objective: 'review it', as: 'reviewer' },
      { persona: expect.objectContaining({ name: 'reviewer', runner: 'codex' }) },
    ]);
    const unknown = await post({ objective: 'x', as: 'ghost' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe('unknown persona "ghost" — this project has reviewer');
    expect(dispatched).toHaveLength(1);
  });

  it('refuses to save a workflow whose step names no persona', async () => {
    const res = await apiRequest(app, '/api/v1/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'review', steps: [{ id: 'r', agent: 'ghost' }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown agent persona "ghost"/);
  });
});
