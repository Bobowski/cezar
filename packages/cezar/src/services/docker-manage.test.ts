import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupStacks, listContainers, type DockerExec } from './docker.ts';
import {
  buildImages, buildVolumes, judgeDir, parseHumanSize, parseImageList, parseReclaimed, parseSystemDf, parseSystemDfVerbose,
  parseVolumeList, planReclaim, readDisk, stepKey, volumesByStack, withImageIds, worktreeRunOf,
} from './docker-manage.ts';

// Captured from Docker 29 (`--format json`), ids replaced with readable ones.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, '__fixtures__/docker29', name), 'utf8');
const IMAGE_LS = fixture('image-ls.ndjson');
const VOLUME_LS = fixture('volume-ls.ndjson');
const SYSTEM_DF = fixture('system-df.ndjson');
const SYSTEM_DF_V = fixture('system-df-v.json');

const C = (ch: string) => ch.repeat(64);
const I = (pair: string) => pair.repeat(32);
const ROOT = '/srv/ffp';
const GONE = `${ROOT}/.ai/cezar/worktrees/run-gone`;
const LIVE = `${ROOT}/.ai/cezar/worktrees/run-live`;
const row = (...cells: string[]) => cells.join('\t');
const PS = [
  row(C('a'), 'ffp-postgres-1', 'postgres:16', 'running', 'Up 2 hours', '0.0.0.0:5432->5432/tcp', 'ffp', 'postgres', ROOT, 'ffp_pg'),
  row(C('b'), 'ffp-4100-postgres-1', 'postgres:16', 'running', 'Up 5 days', '0.0.0.0:4100->5432/tcp', 'ffp-4100', 'postgres', GONE, 'ffp-4100_pg'),
  row(C('c'), 'ffp-4100-app-1', 'ffp-4100-app', 'exited', 'Exited (0) 3 days ago', '', 'ffp-4100', 'app', GONE, ''),
  row(C('0'), 'ffp-4100-minio-1', 'minio/minio', 'running', 'Up 5 days', '', 'ffp-4100', 'minio', GONE, 'ffp-4100_minio'),
  row(C('d'), 'ffp-4200-postgres-1', 'postgres:16', 'running', 'Up 1 hour', '', 'ffp-4200', 'postgres', LIVE, 'ffp-4200_pg'),
  row(C('e'), 'ffp-oneoff', 'ffp-4100-app', 'exited', 'Exited (1) 4 days ago', '', '', '', '', ''),
  row(C('1'), 'scratchpad', '4d4d4d4d4d4d', 'exited', 'Exited (0) 7 days ago', '', '', '', '', '/home/me/scratch'),
].join('\n');
const INSPECT = [
  [C('a'), `sha256:${I('1a')}`], [C('b'), `sha256:${I('1a')}`], [C('c'), `sha256:${I('2b')}`], [C('0'), `sha256:${I('5e')}`],
  [C('d'), `sha256:${I('1a')}`], [C('e'), `sha256:${I('2b')}`], [C('1'), `sha256:${I('4d')}`],
].map((pair) => pair.join('\t')).join('\n');

const exec: DockerExec = async (args) => {
  const command = args.slice(0, 2).join(' ');
  if (args[0] === 'ps') return { ok: true, stdout: PS };
  if (command === 'container inspect') return { ok: true, stdout: INSPECT };
  if (command === 'image ls') return { ok: true, stdout: IMAGE_LS };
  if (command === 'volume ls') return { ok: true, stdout: VOLUME_LS };
  if (command === 'system df') return { ok: true, stdout: args.includes('-v') ? SYSTEM_DF_V : SYSTEM_DF };
  if (command === 'info --format') return { ok: true, stdout: '/var/lib/docker\n' };
  return { ok: false, reason: `unexpected ${args.join(' ')}` };
};
const PROJECTS = [{ id: 'ffp', root: ROOT, name: 'Fancy Fence Panels' }];
const exists = (path: string) => !path.includes('/worktrees/');
const facts = {
  dirState: (dir: string | null) => judgeDir(dir, 'linux', exists),
  task: (dir: string) => (worktreeRunOf(dir) === 'run-live' ? { id: 'run-live', title: 'ffp-570', status: 'running', active: true } : null),
  volumes: volumesByStack(parseVolumeList(VOLUME_LS)),
};

async function inventory() {
  const listed = await listContainers(exec);
  if (!listed.ok) throw new Error(listed.reason);
  const stacks = groupStacks(listed.containers, PROJECTS, 'ffp', facts);
  const managed = await withImageIds(exec, listed.containers);
  const images = buildImages(parseImageList(IMAGE_LS), managed);
  return { listed: listed.containers, stacks, managed, images };
}

describe('docker management parsers (spec 2026-10-23-docker-management, Docker 29 fixtures)', () => {
  it('reads Docker’s human sizes, decimal and binary, and says nothing for N/A', () => {
    expect(parseHumanSize('2.252GB')).toBe(2_252_000_000);
    expect(parseHumanSize('218.5MB (8%)')).toBe(218_500_000);
    expect(parseHumanSize('12.3kB')).toBe(12_300);
    expect(parseHumanSize('63B')).toBe(63);
    expect(parseHumanSize('1.5GiB')).toBe(1.5 * 1024 ** 3);
    expect(parseHumanSize('N/A')).toBeNull();
    expect(parseReclaimed('Deleted Images:\nuntagged: x\n\nTotal reclaimed space: 120MB\n')).toBe(120_000_000);
    expect(parseReclaimed('ID\tRECLAIMABLE\tSIZE\nk2j3\ttrue\t1.2GB\nTotal:\t1.2GB\n')).toBe(1_200_000_000);
  });

  it('folds an image’s tags into one row and marks the untagged ones dangling', () => {
    const images = parseImageList(IMAGE_LS);
    expect(images.map((image) => [image.id.slice(0, 4), image.tags, image.dangling])).toEqual([
      ['1a1a', ['postgres:16', 'postgres:16-alpine-local'], false],
      ['2b2b', ['ffp-4100-app:latest'], false],
      ['3c3c', [], true],
      ['4d4d', [], true],
      ['5e5e', ['minio/minio:latest'], false],
    ]);
    expect(images[0]?.sizeBytes).toBe(649_000_000);
  });

  it('names who uses each image, by digest rather than by tag', async () => {
    const { images } = await inventory();
    const by = (prefix: string) => images.find((image) => image.id.startsWith(prefix))!.usedBy.map((user) => user.name).sort();
    expect(by('1a1a')).toEqual(['ffp-4100-postgres-1', 'ffp-4200-postgres-1', 'ffp-postgres-1']);
    expect(by('2b2b')).toEqual(['ffp-4100-app-1', 'ffp-oneoff']);
    expect(by('3c3c')).toEqual([]);
    // In use first, the unused dangling one last.
    expect(images.at(-1)?.id.startsWith('3c3c')).toBe(true);
  });

  it('reads volume labels and sizes, and resolves a volume’s owner through its stack', async () => {
    const { listed, stacks } = await inventory();
    const sizes = parseSystemDfVerbose(SYSTEM_DF_V);
    expect(sizes.volumes.get('ffp-4100_pg')).toBe(48_210_000);
    expect(sizes.containers.get(C('c'))).toBe(2_000_000);
    const volumes = buildVolumes(parseVolumeList(VOLUME_LS), sizes.volumes, listed, stacks);
    expect(volumes.map((volume) => [volume.name, volume.stack, volume.project?.id ?? null, volume.mine, volume.usedBy.map((u) => u.name)])).toEqual([
      ['ffp_pg', 'ffp', 'ffp', true, ['ffp-postgres-1']],
      ['ffp-4100_minio', 'ffp-4100', 'ffp', true, ['ffp-4100-minio-1']],
      ['ffp-4100_pg', 'ffp-4100', 'ffp', true, ['ffp-4100-postgres-1']],
      ['ffp-4200_pg', 'ffp-4200', 'ffp', true, ['ffp-4200-postgres-1']],
      // A stack with no container left has no working dir to name an owner by.
      ['ffp-3900_pg', 'ffp-3900', null, false, []],
      ['scratch', null, null, false, []],
    ]);
    expect(volumes.find((volume) => volume.name === 'ffp-3900_pg')?.sizeBytes).toBe(330_000_000);
  });

  it('gives a stack its volumes, its dir state and its task', async () => {
    const { stacks } = await inventory();
    const of = (name: string) => stacks.find((stack) => stack.name === name)!;
    expect(of('ffp-4100')).toMatchObject({ dirState: 'gone', task: null, volumes: ['ffp-4100_minio', 'ffp-4100_pg'] });
    expect(of('ffp-4200')).toMatchObject({ dirState: 'gone', task: { title: 'ffp-570', active: true } });
    expect(of('ffp')).toMatchObject({ dirState: 'exists', volumes: ['ffp_pg'] });
    expect(of('')).toMatchObject({ dirState: 'unknown', volumes: [] });
    // `mounts` is bookkeeping: it never reaches a container on the wire.
    expect(Object.keys(of('ffp').containers[0]!)).not.toContain('mounts');
  });

  it('reads `system df` per kind, and the data root only where this host can see it', async () => {
    expect(parseSystemDf(SYSTEM_DF).map((entry) => [entry.kind, entry.count, entry.totalBytes, entry.reclaimableBytes])).toEqual([
      ['images', 5, 2_252_000_000, 218_500_000],
      ['containers', 6, 1_020_000, 12_300],
      ['volumes', 6, 824_600_000, 330_000_000],
      ['build-cache', 21, 1_200_000_000, 1_200_000_000],
    ]);
    const statfs = async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 100_000 });
    const disk = await readDisk(exec, statfs);
    expect(disk.totalBytes).toBe(2_252_000_000 + 1_020_000 + 824_600_000 + 1_200_000_000);
    expect(disk.dataRoot).toEqual({ path: '/var/lib/docker', sizeBytes: 4_096_000_000, freeBytes: 409_600_000, usedPct: 90 });
    expect(disk.warning).toBe(true);
    const roomy = await readDisk(exec, async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 500_000 }));
    expect(roomy.warning).toBe(false);
    const hidden = await readDisk(exec, async () => { throw new Error('ENOENT'); });
    expect([hidden.dataRoot, hidden.warning]).toEqual([null, false]);
    expect(judgeDir('/var/lib/docker', 'win32', () => true)).toBe('unknown');
    expect(judgeDir('C:\\work\\ffp', 'win32', () => false)).toBe('gone');
    expect(judgeDir(null)).toBe('unknown');
    expect(worktreeRunOf('F:\\repo\\.ai\\cezar\\worktrees\\abc123\\docker')).toBe('abc123');
    expect(worktreeRunOf(ROOT)).toBeNull();
  });
});

describe('Reclaim planner (spec 2026-10-23-docker-management §3.6)', () => {
  const plan = async () => {
    const { stacks, managed, images } = await inventory();
    const sizes = parseSystemDfVerbose(SYSTEM_DF_V);
    return planReclaim({
      stacks, containers: managed, images, buildCacheBytes: 1_200_000_000, volumeSizes: sizes.volumes, containerSizes: sizes.containers,
    });
  };

  it('lists dangling images, build cache, a stack whose dir is gone, and stopped containers of its images', async () => {
    const items = await plan();
    expect(items.map((item) => stepKey(item.step))).toEqual(['dangling-images', 'build-cache', 'stack:ffp-4100', `container:${C('e')}`]);
    // Only the dangling image no container uses: 3c, not 4d.
    expect(items[0]).toMatchObject({ label: '1 dangling image', bytes: 120_000_000 });
    expect(items[2]?.detail).toBe('3 containers · volumes ffp-4100_minio, ffp-4100_pg');
    expect(items[2]?.bytes).toBe(1_000 + 2_000_000 + 48_210_000 + 3_500_000);
  });

  it('never lists a stack whose dir exists, nor one of an active task', async () => {
    const keys = (await plan()).map((item) => stepKey(item.step));
    expect(keys).not.toContain('stack:ffp');
    expect(keys).not.toContain('stack:ffp-4200');
    // A stopped container of a stack whose dir exists stays that stack's.
    expect(keys).not.toContain(`container:${C('c')}`);
  });

  it('a gone non-task stack is not listed: Reclaim frees task worktrees only', async () => {
    const { stacks, managed, images } = await inventory();
    // `ffp` runs from the project root, not a task worktree: its dir being gone is not Reclaim's call.
    const goneRoot = stacks.map((stack) => (stack.name === 'ffp' ? { ...stack, dirState: 'gone' as const } : stack));
    const items = planReclaim({ stacks: goneRoot, containers: managed, images, buildCacheBytes: 0, volumeSizes: new Map(), containerSizes: new Map() });
    expect(items.map((item) => stepKey(item.step))).toEqual(['dangling-images', 'stack:ffp-4100', `container:${C('e')}`]);
  });

  it('lists nothing about a stack whose dir cannot be judged from here', async () => {
    const { stacks, managed, images } = await inventory();
    const unjudged = stacks.map((stack) => (stack.name === 'ffp-4100' ? { ...stack, dirState: 'unknown' as const } : stack));
    const items = planReclaim({ stacks: unjudged, containers: managed, images, buildCacheBytes: 0, volumeSizes: new Map(), containerSizes: new Map() });
    expect(items.map((item) => stepKey(item.step))).toEqual(['dangling-images']);
  });
});
