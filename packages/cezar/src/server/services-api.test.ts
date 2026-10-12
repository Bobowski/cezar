import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceLogsSchema, servicePinSchema, servicesStateSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { fakeServiceBinding } from '../services/testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { TerminalSessions } from './terminal/sessions.ts';

describe('services API (spec 2026-10-11-project-services)', () => {
  let root: string;
  let store: RunStore;
  let sessions: TerminalSessions;
  let spawned: ReturnType<typeof fakeServiceBinding>['spawned'];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-services-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } }));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    const fake = fakeServiceBinding();
    spawned = fake.spawned;
    sessions = new TerminalSessions(fake.binding, undefined, () => null);
  });
  afterEach(() => {
    sessions.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async () => {
    const project = await registerProject(root);
    return {
      id: project.id,
      instance: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id, terminalSessions: sessions }),
    };
  };
  const send = (method: string, body?: unknown): RequestInit => ({
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const state = async (instance: ReturnType<typeof createApp>, path = '/api/v1/services') =>
    servicesStateSchema.parse(await (await apiRequest(instance, path)).json());

  it('offers candidates, pins one, runs it, reads its output and logs, and stops it — under both mounts', async () => {
    const { id, instance } = await app();
    const empty = await state(instance);
    expect(empty.services).toEqual([]);
    expect(empty.candidates.map((c) => [c.name, c.command, c.primary])).toEqual([['dev', 'npm run dev', true], ['test', 'npm run test', false]]);
    expect(empty.topic).toBe(`services:${id}`);

    const created = await apiRequest(instance, `/api/v1/p/${id}/services`, send('POST', { name: 'web', command: 'npm run dev', cwd: '' }));
    expect(created.status).toBe(201);
    const pin = servicePinSchema.parse(await created.json());
    // A pinned command is no longer offered as a candidate.
    expect((await state(instance)).candidates.map((c) => c.name)).toEqual(['test']);

    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/start`, send('POST'))).status).toBe(204);
    expect(spawned).toHaveLength(1);
    spawned[0]?.emit('\x1b[32mready\x1b[0m on http://localhost:5173\r\n');
    const running = (await state(instance, `/api/v1/p/${id}/services`)).services[0];
    expect(running).toMatchObject({ id: pin.id, status: 'running' });
    expect(running?.topic).toMatch(/^terminal:/);

    const output = await (await apiRequest(instance, `/api/v1/services/${pin.id}/output`)).json() as { data: string };
    expect(output.data).toContain('ready');
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/input`, send('POST', { data: 'r' }))).status).toBe(200);
    expect(spawned[0]?.written).toEqual(['r']);
    const logs = serviceLogsSchema.parse(await (await apiRequest(instance, '/api/v1/services/web/logs?tail=5')).json());
    expect(logs).toMatchObject({ name: 'web', status: 'running', logs: 'ready on http://localhost:5173\n' });

    expect((await apiRequest(instance, `/api/v1/services/${pin.id}`, send('DELETE'))).status).toBe(409);
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/stop`, send('POST'))).status).toBe(204);
    expect((await state(instance)).services[0]).toMatchObject({ status: 'stopped', topic: null });
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}`, send('PATCH', { name: 'frontend' }))).status).toBe(200);
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}`, send('DELETE'))).status).toBe(204);
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/start`, send('POST'))).status).toBe(404);
  });

  it('starts every pin, stops every pin, and offers the stopped stack for resume only after a shutdown', async () => {
    const { instance } = await app();
    for (const name of ['a', 'b']) await apiRequest(instance, '/api/v1/services', send('POST', { name, command: `run ${name}`, cwd: '' }));
    const all = servicesStateSchema.parse(await (await apiRequest(instance, '/api/v1/services/start-all', send('POST'))).json());
    expect(all.services.map((s) => s.status)).toEqual(['running', 'running']);
    sessions.closeAll();
    const down = await state(instance);
    expect(down.services.map((s) => s.status)).toEqual(['stopped', 'stopped']);
    expect(down.lastRunning).toHaveLength(2);
    const resumed = servicesStateSchema.parse(await (await apiRequest(instance, '/api/v1/services/resume', send('POST'))).json());
    expect(resumed.services.map((s) => s.status)).toEqual(['running', 'running']);
    const stopped = servicesStateSchema.parse(await (await apiRequest(instance, '/api/v1/services/stop-all', send('POST'))).json());
    expect(stopped.services.map((s) => s.status)).toEqual(['stopped', 'stopped']);
    expect(stopped.lastRunning).toEqual([]);
  });

  it('rejects a pin that is not one command inside the repository', async () => {
    const { instance } = await app();
    for (const body of [{ name: 'x', command: 'a\nb', cwd: '' }, { name: 'x', command: 'a', cwd: '../up' }, { name: '', command: 'a', cwd: '' }]) {
      expect((await apiRequest(instance, '/api/v1/services', send('POST', body))).status).toBe(400);
    }
  });

  it('follows the terminal policy: nothing listed, started or read where a shell is not allowed', async () => {
    const { instance } = await app();
    const created = await apiRequest(instance, '/api/v1/services', send('POST', { name: 'web', command: 'npm run dev', cwd: '' }));
    const pin = servicePinSchema.parse(await created.json());
    vi.stubEnv('CEZ_TERMINAL', '0');
    const off = await state(instance);
    expect(off).toMatchObject({ available: false, services: [], candidates: [] });
    expect(off.reason).toContain('services are disabled');
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/start`, send('POST'))).status).toBe(409);
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/output`)).status).toBe(409);
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/logs`)).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/services', send('POST', { name: 'y', command: 'y', cwd: '' }))).status).toBe(409);
    expect(spawned).toHaveLength(0);
    // Stopping stays reachable: it is the one action that reduces exposure.
    expect((await apiRequest(instance, `/api/v1/services/${pin.id}/stop`, send('POST'))).status).toBe(204);
  });
});
