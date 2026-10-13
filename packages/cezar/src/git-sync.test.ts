import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pullFastForward, refreshRepoSync, repoSyncCounts } from './git-sync.ts';
import { removeTempDir } from './test-fixtures/remove-temp-dir.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

// Real git on Windows: see the same note in `git-worktree.test.ts`.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTempDir(...roots.splice(0));
});

async function commit(dir: string, file: string): Promise<void> {
  writeFileSync(join(dir, file), `${file}\n`);
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', file], { cwd: dir });
}

/** A clone whose origin then gained `upstream` commits the clone has not fetched. */
async function cloneBehind(upstream = 2): Promise<{ origin: string; work: string }> {
  const origin = mkdtempSync(join(tmpdir(), 'cez-gitsync-origin-'));
  const work = mkdtempSync(join(tmpdir(), 'cez-gitsync-work-'));
  roots.push(origin, work);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: origin });
  await commit(origin, 'base.txt');
  await run('git', ['clone', '-q', '-c', 'gc.auto=0', origin, work], { cwd: tmpdir() });
  await run('git', ['config', 'user.name', 'test'], { cwd: work });
  await run('git', ['config', 'user.email', 'test@local'], { cwd: work });
  for (let i = 0; i < upstream; i++) await commit(origin, `upstream-${i}.txt`);
  return { origin, work };
}

describe('repo sync (real git)', () => {
  it('reads counts locally, and sees upstream commits only after the background fetch', async () => {
    const { work } = await cloneBehind();
    expect(await repoSyncCounts(work)).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, fetchedAt: null });
    expect(await refreshRepoSync(work)).toBe(true);
    const after = await repoSyncCounts(work);
    expect(after).toMatchObject({ ahead: 0, behind: 2 });
    expect(after.fetchedAt).not.toBeNull();
  });

  it('throttles the background fetch', async () => {
    const { origin, work } = await cloneBehind();
    expect(await refreshRepoSync(work)).toBe(true);
    await commit(origin, 'later.txt');
    expect(await refreshRepoSync(work)).toBe(false);
    expect((await repoSyncCounts(work)).behind).toBe(2);
  });

  it('CEZ_REPO_AUTO_SYNC=0 stops the background fetch but not an explicit pull', async () => {
    vi.stubEnv('CEZ_REPO_AUTO_SYNC', '0');
    const { work } = await cloneBehind();
    expect(await refreshRepoSync(work)).toBe(false);
    expect((await repoSyncCounts(work)).behind).toBe(0);
    expect(await pullFastForward(work)).toEqual({ ok: true, updated: 2 });
  });

  it('pull fast-forwards a checkout that is only behind', async () => {
    const { work } = await cloneBehind();
    expect(await pullFastForward(work)).toEqual({ ok: true, updated: 2 });
    expect(existsSync(join(work, 'upstream-1.txt'))).toBe(true);
    expect(await repoSyncCounts(work)).toMatchObject({ ahead: 0, behind: 0 });
    expect(await pullFastForward(work)).toEqual({ ok: true, updated: 0 });
  });

  it('pull refuses a diverged branch and leaves it untouched', async () => {
    const { work } = await cloneBehind();
    await commit(work, 'mine.txt');
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout;
    const pulled = await pullFastForward(work);
    expect(pulled).toMatchObject({ ok: false });
    expect(pulled.ok ? '' : pulled.error).toContain('diverged');
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout).toBe(head);
  });

  it('requireClean refuses a dirty tree; without it an unrelated edit rides along', async () => {
    const { work } = await cloneBehind();
    writeFileSync(join(work, 'scratch.txt'), 'wip\n');
    expect(await pullFastForward(work, { requireClean: true })).toMatchObject({ ok: false });
    expect(existsSync(join(work, 'upstream-0.txt'))).toBe(false);
    expect(await pullFastForward(work)).toEqual({ ok: true, updated: 2 });
    expect(existsSync(join(work, 'scratch.txt'))).toBe(true);
  });

  it('answers quietly for a detached HEAD and a repo with no origin', async () => {
    const { origin, work } = await cloneBehind();
    expect(await repoSyncCounts(origin)).toMatchObject({ branch: 'main', upstream: null, behind: 0 });
    expect(await refreshRepoSync(origin)).toBe(false);
    await run('git', ['checkout', '-q', '--detach'], { cwd: work });
    expect(await repoSyncCounts(work)).toMatchObject({ branch: null, upstream: null });
    expect(await pullFastForward(work)).toMatchObject({ ok: false });
  });
});
