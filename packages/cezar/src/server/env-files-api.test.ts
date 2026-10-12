import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envFileContentSchema, envFilesListSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('env files API (spec 2026-10-12-project-env-files)', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-env-files-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.env\nhome/\n.ai/\n');
    mkdirSync(join(root, 'api'));
    writeFileSync(join(root, 'api/package.json'), '{}');
    writeFileSync(join(root, 'api/.env.example'), 'TOKEN=\n');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async (bindHost?: string) => {
    const project = await registerProject(root);
    return {
      id: project.id,
      instance: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id, ...(bindHost ? { bindHost } : {}) }),
    };
  };
  const put = (body: unknown): RequestInit => ({
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const content = '/api/v1/env-files/content?path=api%2F.env';

  it('lists names, saves a file, reads it back and removes it — under both mounts', async () => {
    const { id, instance } = await app();
    const empty = envFilesListSchema.parse(await (await apiRequest(instance, '/api/v1/env-files')).json());
    expect(empty).toEqual({
      editable: true,
      files: [{ path: 'api/.env', exists: false, variables: [], template: 'api/.env.example', missing: ['TOKEN'], updatedAt: null }],
      suggestions: [],
    });

    const saved = await apiRequest(instance, `/api/v1/p/${id}/env-files`, put({ path: 'api/.env', content: 'TOKEN=secret-value-123\n', version: null }));
    expect(saved.status).toBe(200);
    const version = envFileContentSchema.parse(await saved.json()).version;
    expect(readFileSync(join(root, 'api/.env'), 'utf8')).toBe('TOKEN=secret-value-123\n');

    const listed = await (await apiRequest(instance, `/api/v1/p/${id}/env-files`)).text();
    expect(listed).not.toContain('secret-value-123');
    expect(envFilesListSchema.parse(JSON.parse(listed)).files[0]).toMatchObject({ exists: true, variables: ['TOKEN'], missing: [] });

    const read = envFileContentSchema.parse(await (await apiRequest(instance, content)).json());
    expect(read).toEqual({ path: 'api/.env', content: 'TOKEN=secret-value-123\n', version, template: 'TOKEN=\n' });

    // A stale version is a conflict, not an overwrite.
    expect((await apiRequest(instance, '/api/v1/env-files', put({ path: 'api/.env', content: 'x', version: null }))).status).toBe(409);

    expect((await apiRequest(instance, '/api/v1/env-files?path=api%2F.env', { method: 'DELETE' })).status).toBe(204);
    expect((await apiRequest(instance, '/api/v1/env-files?path=api%2F.env', { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects a path that is not an env file before touching disk', async () => {
    const { instance } = await app();
    expect((await apiRequest(instance, '/api/v1/env-files', put({ path: '../.env', content: '', version: null }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/env-files/content?path=api%2Fpackage.json')).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/env-files/content')).status).toBe(400);
  });

  it('serves and writes no contents on a hosted cockpit without sign-in', async () => {
    vi.stubEnv('CEZ_REMOTE', '1');
    vi.stubEnv('CEZ_AUTH', '0');
    writeFileSync(join(root, 'api/.env'), 'TOKEN=secret-value-123\n');
    const { instance } = await app();
    const list = envFilesListSchema.parse(await (await apiRequest(instance, '/api/v1/env-files')).json());
    expect(list.editable).toBe(false);
    expect(list.files[0]?.variables).toEqual(['TOKEN']);
    expect((await apiRequest(instance, content)).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/env-files', put({ path: 'api/.env', content: 'x', version: null }))).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/env-files?path=api%2F.env', { method: 'DELETE' })).status).toBe(409);
    expect(readFileSync(join(root, 'api/.env'), 'utf8')).toBe('TOKEN=secret-value-123\n');
  });
});
