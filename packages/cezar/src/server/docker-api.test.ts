import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerStateSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { DockerExec } from '../services/docker.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('docker API (spec 2026-10-13-docker-view)', () => {
  let root: string;
  let store: RunStore;
  let calls: string[];
  const OTHER = 'a'.repeat(12);
  const MINE = 'b'.repeat(12);
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-docker-api-')));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    writeFileSync(join(root, 'compose.yml'), 'services: {}\n');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    calls = [];
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const exec: DockerExec = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'ps') {
      return {
        ok: true,
        stdout: [
          [OTHER, 'other-db-1', 'postgres:16', 'running', 'Up 2 hours', '0.0.0.0:5432->5432/tcp', 'other', 'db', '/elsewhere/other'].join('\t'),
          [MINE, 'mine-redis-1', 'redis:7', 'exited', 'Exited (0)', '', 'mine', 'redis', root].join('\t'),
        ].join('\n'),
      };
    }
    if (args[0] === 'compose' && args.includes('config')) return { ok: true, stdout: JSON.stringify({ services: { db: { ports: [{ published: '5432' }] } } }) };
    return { ok: true, stdout: '' };
  };
  const app = async (dockerExec: DockerExec = exec) => {
    const project = await registerProject(root);
    return { id: project.id, instance: createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id, dockerExec }) };
  };
  const post = { method: 'POST' };

  it('lists the stacks, marks this project’s own, and names the port another stack holds', async () => {
    const { id, instance } = await app();
    const state = dockerStateSchema.parse(await (await apiRequest(instance, `/api/v1/p/${id}/docker`)).json());
    expect(state.available).toBe(true);
    expect(state.stacks.map((s) => [s.name, s.mine, s.project?.id ?? null])).toEqual([['mine', true, id], ['other', false, null]]);
    expect(state.conflicts).toEqual([{ port: 5432, service: 'db', file: 'compose.yml', stack: 'other', container: 'other-db-1' }]);
    expect(dockerStateSchema.parse(await (await apiRequest(instance, '/api/v1/docker')).json())).toEqual(state);
  });

  it('stops and starts only what the listing shows', async () => {
    const { instance } = await app();
    expect((await apiRequest(instance, '/api/v1/docker/stacks/other/stop', post)).status).toBe(204);
    expect((await apiRequest(instance, `/api/v1/docker/containers/${MINE}/start`, post)).status).toBe(204);
    expect(calls.filter((c) => !c.startsWith('ps'))).toEqual(['compose -p other stop', `start ${MINE}`]);
    expect((await apiRequest(instance, '/api/v1/docker/stacks/nope/stop', post)).status).toBe(404);
    expect((await apiRequest(instance, `/api/v1/docker/containers/${'c'.repeat(12)}/stop`, post)).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/docker/stacks/--rm/stop', post)).status).toBe(400);
  });

  it('says why when docker cannot be read, and refuses an action then', async () => {
    const down = await app(async () => ({ ok: false, reason: 'Docker is installed, but its daemon is not running' }));
    const state = dockerStateSchema.parse(await (await apiRequest(down.instance, '/api/v1/docker')).json());
    expect(state).toMatchObject({ available: false, reason: 'Docker is installed, but its daemon is not running', stacks: [] });
    expect((await apiRequest(down.instance, '/api/v1/docker/stacks/other/stop', post)).status).toBe(409);
  });

  it('follows the terminal policy: nothing read and nothing stopped where a shell is not allowed', async () => {
    const { instance } = await app();
    vi.stubEnv('CEZ_TERMINAL', '0');
    const state = dockerStateSchema.parse(await (await apiRequest(instance, '/api/v1/docker')).json());
    expect(state.available).toBe(false);
    expect(state.reason).toContain('the Docker view is disabled');
    expect((await apiRequest(instance, '/api/v1/docker/stacks/other/stop', post)).status).toBe(409);
    expect(calls).toEqual([]);
  });
});
