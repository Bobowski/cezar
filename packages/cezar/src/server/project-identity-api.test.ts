import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectIconCandidatesSchema, projectsResponseSchema, updateProjectResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-a-png')]);

describe('project identity API (spec 2026-10-12-project-identity)', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-identity-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, 'WRAP-CREATORS/public'), { recursive: true });
    writeFileSync(join(root, 'WRAP-CREATORS/public/favicon.png'), PNG);
    writeFileSync(join(root, 'WRAP-CREATORS/secret.txt'), 'not an icon');
    mkdirSync(join(root, 'WRAP-CREATORS/.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, 'WRAP-CREATORS/.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async () => {
    const project = await registerProject(join(root, 'WRAP-CREATORS'));
    return { id: project.id, instance: createApp({ repoRoot: project.root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id }) };
  };
  const send = (method: string, body?: unknown): RequestInit => ({
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const listed = async (instance: ReturnType<typeof createApp>, id: string) =>
    projectsResponseSchema.parse(await (await apiRequest(instance, '/api/v1/projects')).json()).projects.find((project) => project.id === id);

  it('renames a project without touching its id or root, and resets the name on null', async () => {
    const { id, instance } = await app();
    const before = await listed(instance, id);
    expect(before?.name).toBe('WRAP-CREATORS');
    const renamed = await apiRequest(instance, `/api/v1/projects/${id}`, send('PATCH', { name: '  Wrap Creators  ' }));
    expect(renamed.status).toBe(200);
    expect(updateProjectResponseSchema.parse(await renamed.json()).project).toMatchObject({ id, name: 'Wrap Creators', root: before?.root });
    expect(await listed(instance, id)).toMatchObject({ id, name: 'Wrap Creators' });
    // Registering the same folder again (every boot does) keeps the chosen name.
    await registerProject(join(root, 'WRAP-CREATORS'));
    expect((await listed(instance, id))?.name).toBe('Wrap Creators');
    await apiRequest(instance, `/api/v1/projects/${id}`, send('PATCH', { name: null }));
    expect((await listed(instance, id))?.name).toBe('WRAP-CREATORS');
    for (const body of [{ name: '' }, { name: 'x'.repeat(81) }, {}]) {
      expect((await apiRequest(instance, `/api/v1/projects/${id}`, send('PATCH', body))).status).toBe(400);
    }
  });

  it('sets an uploaded icon, serves it as an inert image, and removes it', async () => {
    const { id, instance } = await app();
    expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`)).status).toBe(404);
    const set = await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('PUT', { data: PNG.toString('base64') }));
    expect(set.status).toBe(200);
    const icon = updateProjectResponseSchema.parse(await set.json()).project.icon;
    expect(icon).toMatch(new RegExp(`^${id}-[0-9a-f]{12}\\.png$`));
    expect((await listed(instance, id))?.icon).toBe(icon);

    const served = await apiRequest(instance, `/api/v1/projects/${id}/icon`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

    const removed = await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('DELETE'));
    expect(updateProjectResponseSchema.parse(await removed.json()).project.icon).toBeUndefined();
    expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`)).status).toBe(404);
    expect(readdirSync(join(root, 'home/project-icons'))).toEqual([]);
  });

  it('offers the repository\'s own favicon and copies only what it offered', async () => {
    const { id, instance } = await app();
    const found = projectIconCandidatesSchema.parse(await (await apiRequest(instance, `/api/v1/projects/${id}/icon-candidates`)).json());
    expect(found.candidates).toEqual(['public/favicon.png']);
    expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('PUT', { path: 'public/favicon.png' }))).status).toBe(200);
    expect((await listed(instance, id))?.icon).toMatch(/\.png$/);
    for (const path of ['secret.txt', '../../home/config.json', '.ai/cezar/runs.json']) {
      expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('PUT', { path }))).status, path).toBe(409);
    }
  });

  it('refuses what is not an image, an unknown project, and single-project mode', async () => {
    const { id, instance } = await app();
    expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('PUT', { data: Buffer.from('<script>alert(1)</script>').toString('base64') }))).status).toBe(409);
    expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('PUT', { data: 'x', path: 'y' }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/projects/nope/icon', send('PUT', { data: PNG.toString('base64') }))).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/projects/nope/icon-candidates')).status).toBe(404);
    vi.stubEnv('CEZ_SINGLE_PROJECT', '1');
    expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('PUT', { data: PNG.toString('base64') }))).status).toBe(409);
    expect((await apiRequest(instance, `/api/v1/projects/${id}/icon`, send('DELETE'))).status).toBe(409);
  });
});
