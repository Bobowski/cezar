import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dockerDiskSchema, dockerImagesSchema, dockerLogsSchema, dockerOkSchema, dockerReclaimPlanSchema, dockerReclaimResultSchema,
  dockerStateSchema, dockerVolumesSchema,
} from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { DockerExec } from '../services/docker.ts';
import type { DockerSpawn } from '../services/docker-logs.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../services/__fixtures__/docker29', name), 'utf8');
const C = (ch: string) => ch.repeat(64);
const I = (pair: string) => pair.repeat(32);

describe('docker management API (spec 2026-10-23-docker-management)', () => {
  let root: string;
  let store: RunStore;
  let calls: Array<{ args: string; cwd?: string }>;
  let liveRun: string;
  let extraImages: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-docker-manage-')));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    const run = store.createRun({ title: 'ffp-570', workflow: 'w', task: 'fix the fence', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    liveRun = run.id;
    mkdirSync(join(root, '.ai/cezar/worktrees', liveRun), { recursive: true });
    calls = [];
    extraImages = '';
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const ps = () => [
    [C('a'), 'mine-postgres-1', 'postgres:16', 'running', 'Up 2 hours', '', 'mine', 'postgres', root, 'mine_pg', [join(root, 'compose.yml'), join(root, 'compose.dev.yml')].join(',')],
    [C('b'), 'gone-postgres-1', 'postgres:16', 'running', 'Up 5 days', '', 'gone', 'postgres', join(root, '.ai/cezar/worktrees/removed'), 'gone_pg', join(root, '.ai/cezar/worktrees/removed/compose.yml')],
    [C('c'), 'live-postgres-1', 'postgres:16', 'running', 'Up 1 hour', '', 'live', 'postgres', join(root, '.ai/cezar/worktrees', liveRun), 'live_pg'],
  ].map((cells) => cells.join('\t')).join('\n');
  const volumes = ['mine', 'gone', 'live'].map((stack) => JSON.stringify({
    Driver: 'local', Labels: `com.docker.compose.project=${stack},com.docker.compose.volume=pg`, Name: `${stack}_pg`, Scope: 'local',
  })).join('\n');
  const exec: DockerExec = async (args, options) => {
    calls.push({ args: args.join(' '), cwd: options?.cwd });
    const command = args.slice(0, 2).join(' ');
    if (args[0] === 'ps') return { ok: true, stdout: ps() };
    if (command === 'container inspect') return { ok: true, stdout: [C('a'), C('b'), C('c')].map((id) => `${id}\tsha256:${I('1a')}`).join('\n') };
    if (command === 'image ls') return { ok: true, stdout: fixture('image-ls.ndjson') + extraImages };
    if (command === 'volume ls') return { ok: true, stdout: volumes };
    if (command === 'system df') return { ok: true, stdout: args.includes('-v') ? fixture('system-df-v.json') : fixture('system-df.ndjson') };
    if (command === 'info --format') return { ok: true, stdout: '/var/lib/docker\n' };
    if (command === 'image prune') return { ok: true, stdout: 'Total reclaimed space: 120MB\n' };
    if (command === 'builder prune') return { ok: true, stdout: 'Total:\t1.2GB\n' };
    if (args[0] === 'compose' && args.includes('config')) return { ok: true, stdout: '{"services":{}}' };
    return { ok: true, stdout: '' };
  };
  const spawned: string[][] = [];
  const spawn: DockerSpawn = (args, on) => {
    spawned.push(args);
    queueMicrotask(() => on.data('out', `boot\nAPI_TOKEN=${'x'.repeat(4)}ghp_abcdefghijklmnopqrstuvwxyz123456\n`));
    return { kill: () => undefined };
  };
  const app = async () => {
    const project = await registerProject(root);
    const instance = createApp({
      repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id,
      dockerExec: exec, dockerSpawn: spawn, dockerStatfs: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 100_000 }),
    });
    return { id: project.id, instance };
  };
  const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ran = () => calls.map((call) => call.args).filter((args) => !/^(ps|volume ls|image ls|container inspect|system df|info)/.test(args));

  it('names a stack’s task, its volumes and whether its dir is still there', async () => {
    const { instance } = await app();
    const state = dockerStateSchema.parse(await (await apiRequest(instance, '/api/v1/docker')).json());
    const of = (name: string) => state.stacks.find((stack) => stack.name === name)!;
    expect(of('mine')).toMatchObject({ dirState: 'exists', task: null, volumes: ['mine_pg'] });
    expect(of('gone')).toMatchObject({ dirState: 'gone', task: null });
    expect(of('live')).toMatchObject({ dirState: 'exists', task: { id: liveRun, title: 'ffp-570', status: 'running', active: true } });
  });

  it('reads images, volumes and disk on both mounts', async () => {
    const { id, instance } = await app();
    for (const base of ['/api/v1', `/api/v1/p/${id}`]) {
      const images = dockerImagesSchema.parse(await (await apiRequest(instance, `${base}/docker/images`)).json());
      expect(images.images[0]).toMatchObject({ tags: ['postgres:16', 'postgres:16-alpine-local'], usedBy: [{ name: 'mine-postgres-1' }, { name: 'gone-postgres-1' }, { name: 'live-postgres-1' }] });
      const vols = dockerVolumesSchema.parse(await (await apiRequest(instance, `${base}/docker/volumes`)).json());
      expect(vols.volumes.map((v) => [v.name, v.mine, v.usedBy.length])).toEqual([['gone_pg', true, 1], ['live_pg', true, 1], ['mine_pg', true, 1]]);
      const disk = dockerDiskSchema.parse(await (await apiRequest(instance, `${base}/docker/disk`)).json());
      expect(disk).toMatchObject({ available: true, warning: true, dataRoot: { usedPct: 90 } });
    }
  });

  it('downs a stack where its compose file is, with the files it was started from and its volumes when asked', async () => {
    writeFileSync(join(root, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(root, 'compose.dev.yml'), 'services: {}\n');
    const { instance } = await app();
    const down = await apiRequest(instance, '/api/v1/docker/stacks/mine/down', json('POST', { volumes: true }));
    expect(dockerOkSchema.parse(await down.json())).toEqual({ ok: true });
    expect(await (await apiRequest(instance, '/api/v1/docker/stacks/gone/down', json('POST', {}))).json()).toEqual({ ok: true });
    const downs = calls.filter((call) => call.args.startsWith('compose -p'));
    // `gone` named a file that no longer exists: compose would fail on it, so the labels alone drive `down`.
    expect(downs).toEqual([
      { args: `compose -p mine -f ${join(root, 'compose.yml')} -f ${join(root, 'compose.dev.yml')} down --volumes`, cwd: root },
      { args: 'compose -p gone down', cwd: tmpdir() },
    ]);
    expect((await apiRequest(instance, '/api/v1/docker/stacks/nope/down', json('POST', {}))).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/docker/stacks/mine/down', json('POST', { volumes: 'yes' }))).status).toBe(400);
  });

  it('removes a container, an image and a volume only when the listing shows it', async () => {
    const { instance } = await app();
    expect((await apiRequest(instance, `/api/v1/docker/containers/${C('a')}?force=1`, { method: 'DELETE' })).status).toBe(200);
    expect((await apiRequest(instance, `/api/v1/docker/images/${I('2b').slice(0, 12)}`, { method: 'DELETE' })).status).toBe(200);
    expect((await apiRequest(instance, '/api/v1/docker/volumes/gone_pg?force=1', { method: 'DELETE' })).status).toBe(200);
    expect(ran()).toEqual([`rm -f ${C('a')}`, `image rm -f ${I('2b')}`, `rm -f ${C('b')}`, 'volume rm gone_pg']);
    expect((await apiRequest(instance, `/api/v1/docker/containers/${C('9')}`, { method: 'DELETE' })).status).toBe(404);
    expect((await apiRequest(instance, `/api/v1/docker/images/${'9'.repeat(12)}`, { method: 'DELETE' })).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/docker/volumes/nope', { method: 'DELETE' })).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/docker/volumes/--all', { method: 'DELETE' })).status).toBe(400);
    expect((await apiRequest(instance, `/api/v1/docker/containers/${C('a')}?force=yes`, { method: 'DELETE' })).status).toBe(400);
  });

  it('does what the confirm says for what is in use: an image always with -f, its running users stopped first, a volume’s users removed first', async () => {
    const { instance } = await app();
    // Not confirmed: Docker would refuse either, so nothing runs.
    expect((await apiRequest(instance, `/api/v1/docker/images/${I('1a')}`, { method: 'DELETE' })).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/docker/volumes/live_pg', { method: 'DELETE' })).status).toBe(409);
    expect(ran()).toEqual([]);
    // 1a carries two tags: without -f Docker would refuse it as "referenced in multiple repositories".
    expect((await apiRequest(instance, `/api/v1/docker/images/${I('1a')}?force=1`, { method: 'DELETE' })).status).toBe(200);
    expect((await apiRequest(instance, '/api/v1/docker/volumes/live_pg?force=1', { method: 'DELETE' })).status).toBe(200);
    expect(ran()).toEqual([`stop ${C('a')} ${C('b')} ${C('c')}`, `image rm -f ${I('1a')}`, `rm -f ${C('c')}`, 'volume rm live_pg']);
  });

  it('removes an image by its exact id or a unique prefix, and refuses an ambiguous one', async () => {
    const twin = `1a1a1a1a1a1a${'f'.repeat(52)}`;
    extraImages = `\n${JSON.stringify({ ID: `sha256:${twin}`, Repository: 'twin', Tag: 'latest', Size: '1MB', CreatedAt: '' })}`;
    const { instance } = await app();
    const ambiguous = await apiRequest(instance, `/api/v1/docker/images/${I('1a').slice(0, 12)}`, { method: 'DELETE' });
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json() as { error: string }).error).toMatch(/ambiguous/);
    expect(ran()).toEqual([]);
    expect((await apiRequest(instance, `/api/v1/docker/images/${twin}`, { method: 'DELETE' })).status).toBe(200);
    expect((await apiRequest(instance, `/api/v1/docker/images/${twin.slice(0, 13)}`, { method: 'DELETE' })).status).toBe(200);
    expect(ran().every((args) => args.endsWith(twin))).toBe(true);
  });

  it('plans Reclaim and runs only the steps the plan still holds', async () => {
    const { instance } = await app();
    const plan = dockerReclaimPlanSchema.parse(await (await apiRequest(instance, '/api/v1/docker/reclaim/plan', { method: 'POST' })).json());
    expect(plan.items.map((item) => item.step)).toEqual([{ kind: 'dangling-images' }, { kind: 'build-cache' }, { kind: 'stack', name: 'gone' }]);
    const result = dockerReclaimResultSchema.parse(await (await apiRequest(instance, '/api/v1/docker/reclaim', json('POST', {
      steps: [{ kind: 'build-cache' }, { kind: 'stack', name: 'gone' }, { kind: 'stack', name: 'live' }, { kind: 'dangling-images' }],
    }))).json());
    expect(ran()).toEqual(['compose -p gone down --volumes', 'image prune -f', 'builder prune -f']);
    expect(result.log).toContain('skipped stack:live: no longer in the plan');
    expect(result.freedBytes).toBe(plan.items[2]!.bytes + 120_000_000 + 1_200_000_000);
    expect((await apiRequest(instance, '/api/v1/docker/reclaim', json('POST', { steps: [{ kind: 'stack', name: '--x' }] }))).status).toBe(400);
  });

  it('streams a container’s logs by cursor, redacted, behind a cursor-only topic', async () => {
    const { instance } = await app();
    const first = dockerLogsSchema.parse(await (await apiRequest(instance, `/api/v1/docker/containers/${C('a')}/logs`)).json());
    expect(first).toMatchObject({ topic: `docker-logs:${C('a')}`, following: true });
    expect(spawned.at(-1)).toEqual(['logs', '--tail', '500', '--follow', C('a')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = dockerLogsSchema.parse(await (await apiRequest(instance, `/api/v1/docker/containers/${C('a')}/logs?cursor=${first.cursor}`)).json());
    expect(next.data).toBe('boot\nAPI_TOKEN=xxxx[REDACTED]\n');
    expect((await apiRequest(instance, `/api/v1/docker/containers/${C('9')}/logs`)).status).toBe(404);
  });

  it('refuses every removal on a hosted cockpit without its own sign-in, and reads still work', async () => {
    vi.stubEnv('CEZ_REMOTE', '1');
    vi.stubEnv('CEZ_AUTH', '0');
    vi.stubEnv('CEZ_TERMINAL', '1');
    const { instance } = await app();
    expect(dockerImagesSchema.parse(await (await apiRequest(instance, '/api/v1/docker/images')).json()).available).toBe(true);
    const refused = [
      await apiRequest(instance, `/api/v1/docker/containers/${C('a')}`, { method: 'DELETE' }),
      await apiRequest(instance, `/api/v1/docker/images/${I('2b')}`, { method: 'DELETE' }),
      await apiRequest(instance, '/api/v1/docker/volumes/gone_pg', { method: 'DELETE' }),
      await apiRequest(instance, '/api/v1/docker/stacks/mine/down', json('POST', {})),
      await apiRequest(instance, '/api/v1/docker/reclaim', json('POST', { steps: [{ kind: 'build-cache' }] })),
    ];
    expect(refused.map((res) => res.status)).toEqual([409, 409, 409, 409, 409]);
    expect(ran()).toEqual([]);
  });

  it('follows the terminal policy: nothing read and nothing removed where a shell is not allowed', async () => {
    const { instance } = await app();
    vi.stubEnv('CEZ_TERMINAL', '0');
    expect(dockerImagesSchema.parse(await (await apiRequest(instance, '/api/v1/docker/images')).json()).available).toBe(false);
    expect(dockerVolumesSchema.parse(await (await apiRequest(instance, '/api/v1/docker/volumes')).json()).available).toBe(false);
    expect(dockerDiskSchema.parse(await (await apiRequest(instance, '/api/v1/docker/disk')).json()).available).toBe(false);
    expect(dockerReclaimPlanSchema.parse(await (await apiRequest(instance, '/api/v1/docker/reclaim/plan', { method: 'POST' })).json()).available).toBe(false);
    expect((await apiRequest(instance, `/api/v1/docker/containers/${C('a')}/logs`)).status).toBe(409);
    expect((await apiRequest(instance, `/api/v1/docker/containers/${C('a')}`, { method: 'DELETE' })).status).toBe(409);
    expect(calls).toEqual([]);
  });
});
