import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { designDraftsResponseSchema, reorderPromptQueueResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore, type QueuedMessage } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { resolveCapabilities } from './capabilities.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { PreviewGateways } from './preview/gateway.ts';
import { createApp } from './server.ts';

/**
 * The routes of spec `2026-10-24-design-mode-third-cut` §4: reordering the prompt queue, the
 * project's design drafts, and Design Mode through the preview gateway.
 */
describe('Design Mode, third cut — the API', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let gateways: PreviewGateways | undefined;
  let app: Hono;
  const saved = { remote: process.env.CEZ_REMOTE, design: process.env.CEZ_DESIGN_MODE };

  const send = (path: string, method: string, body?: unknown) =>
    apiRequest(app, path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_DESIGN_MODE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-design3-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    gateways = new PreviewGateways({ ports: [0] });
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', previewGateways: gateways });
  });
  afterEach(() => {
    gateways?.closeAll();
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    for (const [name, value] of [['CEZ_REMOTE', saved.remote], ['CEZ_DESIGN_MODE', saved.design]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('PUT /runs/:id/prompt-queue', () => {
    const queued = (id: string): QueuedMessage => ({ id, text: `prompt ${id}`, createdAt: '2026-10-24T00:00:00.000Z' });
    const seed = () => {
      const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
      store.updateRun(run.id, { promptQueue: [queued('a'), queued('b'), queued('c')] });
      return run.id;
    };

    it('reorders the waiting prompts, and answers the queue as it now stands', async () => {
      const id = seed();
      const res = await send(`/api/v1/runs/${id}/prompt-queue`, 'PUT', { order: ['c', 'a', 'b'] });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(reorderPromptQueueResponseSchema.safeParse(body).success).toBe(true);
      expect((body as { promptQueue: QueuedMessage[] }).promptQueue.map((m) => m.id)).toEqual(['c', 'a', 'b']);
      expect(store.getRun(id)?.promptQueue?.map((m) => m.text)).toEqual(['prompt c', 'prompt a', 'prompt b']);
    });

    it('refuses an order that is not exactly the queue — missing, extra or twice — and changes nothing', async () => {
      const id = seed();
      for (const order of [['a', 'b'], ['a', 'b', 'c', 'd'], ['a', 'a', 'b'], ['a', 'b', 'x']]) {
        const res = await send(`/api/v1/runs/${id}/prompt-queue`, 'PUT', { order });
        expect(res.status, JSON.stringify(order)).toBe(409);
      }
      expect(store.getRun(id)?.promptQueue?.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('404s an unknown run and 400s a malformed body in middleware', async () => {
      expect((await send('/api/v1/runs/nope/prompt-queue', 'PUT', { order: [] })).status).toBe(404);
      const id = seed();
      expect((await send(`/api/v1/runs/${id}/prompt-queue`, 'PUT', { order: 'a,b' })).status).toBe(400);
    });

    it('is mounted under the project scope too', async () => {
      const id = seed();
      const res = await send(`/api/v1/p/default/runs/${id}/prompt-queue`, 'PUT', { order: ['b', 'c', 'a'] });
      expect(res.status).toBe(200);
    });
  });

  describe('/repo/design-drafts', () => {
    const pick = {
      url: 'http://localhost:5173/',
      selector: 'main > button.save',
      tag: 'button',
      text: 'Save',
      html: '<button class="save">Save</button>',
      styles: { color: 'red' },
      rect: { x: 1, y: 2, width: 3, height: 4 },
      viewport: { width: 100, height: 100 },
      components: ['SaveButton'],
      source: { file: 'src/save.tsx', line: 12 },
      mark: 'abc123-1',
      note: 'make it bigger',
    };

    it('is empty for a project that collected nothing', async () => {
      const res = await send('/api/v1/repo/design-drafts', 'GET');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ picks: [] });
    });

    it('keeps what was put, in order, and an empty put clears it', async () => {
      const second = { ...pick, mark: 'abc123-2', note: '' };
      expect((await send('/api/v1/repo/design-drafts', 'PUT', { picks: [pick, second] })).status).toBe(200);
      const res = await send('/api/v1/p/default/repo/design-drafts', 'GET');
      const body: unknown = await res.json();
      expect(designDraftsResponseSchema.safeParse(body).success).toBe(true);
      expect(body).toEqual({ picks: [pick, second] });

      expect((await send('/api/v1/repo/design-drafts', 'PUT', { picks: [] })).status).toBe(200);
      expect(await (await send('/api/v1/repo/design-drafts', 'GET')).json()).toEqual({ picks: [] });
    });

    it('refuses what is not a pick, in middleware', async () => {
      for (const picks of [[{ ...pick, selector: '' }], [{ ...pick, source: { file: '/etc/passwd'.repeat(100) } }], 'x']) {
        expect((await send('/api/v1/repo/design-drafts', 'PUT', { picks })).status).toBe(400);
      }
      expect((await send('/api/v1/repo/design-drafts', 'PUT', { picks: Array.from({ length: 13 }, (_, n) => ({ ...pick, mark: `m-${n}` })) })).status).toBe(400);
    });
  });

  describe('Design Mode on a hosted cockpit', () => {
    it('is available, local or hosted, and CEZ_DESIGN_MODE=0 still turns it off', () => {
      expect(resolveCapabilities({}, '127.0.0.1').designMode).toBe(true);
      expect(resolveCapabilities({ CEZ_REMOTE: '1' }, '127.0.0.1').designMode).toBe(true);
      expect(resolveCapabilities({}, '0.0.0.0').designMode).toBe(true);
      expect(resolveCapabilities({ CEZ_DESIGN_MODE: '0' }, '127.0.0.1').designMode).toBe(false);
      expect(resolveCapabilities({ CEZ_DESIGN_MODE: '0', CEZ_REMOTE: '1' }, '127.0.0.1').designMode).toBe(false);
    });

    it('opens a design slot through the gateway', async () => {
      process.env.CEZ_REMOTE = '1';
      const res = await send('/api/v1/preview/gateway', 'POST', { target: 'http://localhost:3000', parentOrigin: 'https://cezar.example.com', designMode: true });
      expect(res.status).toBe(200);
      expect(gateways?.size).toBe(1);
    });

    it('refuses a design slot with CEZ_DESIGN_MODE=0, and still opens a plain preview', async () => {
      process.env.CEZ_REMOTE = '1';
      process.env.CEZ_DESIGN_MODE = '0';
      const body = { target: 'http://localhost:3000', parentOrigin: 'https://cezar.example.com' };
      expect((await send('/api/v1/preview/gateway', 'POST', { ...body, designMode: true })).status).toBe(409);
      expect(gateways?.size).toBe(0);
      expect((await send('/api/v1/preview/gateway', 'POST', body)).status).toBe(200);
    });

    it('does not open the loopback mirror there — the gateway is the way in', async () => {
      process.env.CEZ_REMOTE = '1';
      const res = await send('/api/v1/preview/design-proxy', 'POST', { target: 'http://localhost:5173', parentOrigin: 'https://cezar.example.com' });
      expect(res.status).toBe(409);
    });
  });
});
