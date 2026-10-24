import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleLiveRuns, type BackupManifest } from '../backup/collect.ts';
import { applyStaged } from '../backup/restore.ts';
import { branchFor, pruneOrphans, worktreePathFor } from '../git-worktree.ts';
import type { AgentStateLocations } from '../paths.ts';
import { consumeRestoreMarker, orphanPruneSuspended, resetRestoreGuardForTests, writeRestoreMarker } from '../restore-guard.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { RunStore } from './store.ts';

/** The archive's index, as a restore places it (spec 2026-10-23-backup-restore §10). */
const RESTORED = [{
  id: 'restored-1',
  title: 'from the backup',
  workflow: 'quick-task',
  task: 'from the backup',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
}];

describe('RunStore.holdIndex — a restored runs.json survives the restart flush', () => {
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dataDir = mkdtempSync(join(tmpdir(), 'cez-store-hold-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('drops the pending debounced save and every flush while held; the next open reads the restored file', () => {
    const store = RunStore.open(dataDir);
    const mine = store.createRun({ title: 'local', workflow: 'quick-task', task: 'local', steps: [] });
    const release = store.holdIndex();
    const restored = JSON.stringify(RESTORED);
    writeFileSync(join(dataDir, 'runs.json'), restored);

    store.updateRun(mine.id, { title: 'renamed while held' });
    vi.advanceTimersByTime(5_000);
    store.flush({ pretty: true }); // index.ts restartCockpit
    store.flush({ throwOnError: true }); // startServer's shutdownLifecycle
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(restored);
    expect(RunStore.open(dataDir).listRuns().map((run) => run.id)).toEqual(['restored-1']);

    release();
    release(); // idempotent
    store.flush();
    expect(RunStore.open(dataDir).listRuns().map((run) => run.id).sort()).toEqual([mine.id, 'restored-1'].sort());
  });
});

/**
 * A restore on a live install never destroys work made after the backup (spec 2026-10-23 §10):
 * the archive's index MERGES into this machine's, and the first boot after it prunes nothing.
 */
describe('restoring over a live install keeps the tasks created after the backup', () => {
  let dir: string;
  let root: string;
  let home: string;
  const saved = process.env.CEZ_HOME;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
  const none = (base: string): AgentStateLocations => ({
    claude: join(base, 'claude'), claudeState: null, codex: join(base, 'codex'), gh: join(base, 'gh'), ssh: join(base, 'ssh'), gitconfig: join(base, 'gitconfig'),
  });
  const manifest = (): BackupManifest => ({
    version: 1, createdAt: '2026-01-01T00:00:00.000Z', cezarVersion: 't', host: 'box', compression: 'gzip',
    projects: [{ id: 'app', root, remote: null, branch: null }],
    sizes: { data: 0, agents: 0, projects: 0, files: 0 },
  });
  /** Stage an archive by hand: the project's `.ai/cezar` files, as a backup carried them. */
  const stage = (files: Record<string, string>): string => {
    const staging = join(home, '.restore-test');
    for (const [rel, body] of Object.entries(files)) {
      const at = join(staging, 'projects', 'app', ...rel.split('/'));
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, body);
    }
    return staging;
  };
  const apply = (staging: string, log: string[] = []) =>
    applyStaged({
      staging, manifest: manifest(), cezarHome: home, locations: none(join(dir, 'agents')),
      rootPolicy: { registry: [{ id: 'app', root }], projectsDir: null, cezarHome: home },
      log: (line) => log.push(line),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-restore-live-'));
    home = join(dir, 'home');
    root = join(dir, 'app');
    process.env.CEZ_HOME = home;
    mkdirSync(home, { recursive: true });
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'commit', '--allow-empty', '-q', '-m', 'base');
    resetRestoreGuardForTests();
  });

  afterEach(async () => {
    resetRestoreGuardForTests();
    if (saved === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved;
    await removeTempDir(dir);
  });

  it('merges the archive index: the newer task, its event file and its worktree survive the boot prune', async () => {
    const dataDir = join(root, '.ai', 'cezar');
    const live = RunStore.open(dataDir);
    const old = live.createRun({ title: 'in the backup', workflow: 'quick-task', task: 'old', steps: [] });
    const archived = { ...live.getRun(old.id)!, title: 'as the backup has it' };
    const newer = live.createRun({ title: 'after the backup', workflow: 'quick-task', task: 'new', steps: [] });
    live.updateRun(old.id, { title: 'renamed after the backup', finishedAt: new Date(Date.now() + 60_000).toISOString() });
    live.flush();
    git(root, 'worktree', 'add', '-q', '-b', branchFor(newer.id), worktreePathFor(root, newer.id), 'main');
    const oldEvents = join(dataDir, 'runs', `${old.id}.ndjson`);
    writeFileSync(oldEvents, '{"seq":1}\n{"seq":2}\n');

    await apply(stage({
      '.ai/cezar/runs.json': JSON.stringify([archived]),
      [`.ai/cezar/runs/${old.id}.ndjson`]: '{"seq":1}\n',
    }));

    const reopened = RunStore.open(dataDir, { keepLive: true });
    expect(reopened.listRuns().map((run) => run.id).sort()).toEqual([old.id, newer.id].sort());
    // Both sides have it; this machine's copy is the newer one.
    expect(reopened.getRun(old.id)?.title).toBe('renamed after the backup');
    expect(readFileSync(oldEvents, 'utf8')).toBe('{"seq":1}\n{"seq":2}\n');
    expect(await pruneOrphans(root, new Set(reopened.listRuns().map((run) => run.id)))).toEqual([]);
    expect(existsSync(worktreePathFor(root, newer.id))).toBe(true);
    expect(git(root, 'branch', '--list', branchFor(newer.id)).trim()).not.toBe('');
  }, 30_000);

  it('takes an archived record that is newer, and places an archive-only one', async () => {
    const dataDir = join(root, '.ai', 'cezar');
    const live = RunStore.open(dataDir);
    const both = live.createRun({ title: 'here', workflow: 'quick-task', task: 'x', steps: [] });
    live.flush();
    const fromArchive = { ...live.getRun(both.id)!, title: 'newer in the archive', finishedAt: new Date(Date.now() + 60_000).toISOString() };
    const onlyArchived = { ...RESTORED[0]!, id: 'only-archived' };
    await apply(stage({ '.ai/cezar/runs.json': JSON.stringify([fromArchive, onlyArchived]) }));
    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(both.id)?.title).toBe('newer in the archive');
    expect(reopened.getRun('only-archived')?.title).toBe('from the backup');
  });

  it('never revives an archived live record: it comes back terminal, whatever wrote the archive', async () => {
    const running = { ...RESTORED[0]!, id: 'was-running', status: 'running', steps: [{ id: 'agent', name: 'Agent', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 }] };
    const queued = { ...RESTORED[0]!, id: 'was-queued', status: 'queued' };
    await apply(stage({ '.ai/cezar/runs.json': JSON.stringify([running, queued]) }));
    // keepLive, as `serve` opens it: a live-looking row here would be re-queued or resumed.
    const reopened = RunStore.open(join(root, '.ai', 'cezar'), { keepLive: true });
    for (const id of ['was-running', 'was-queued']) {
      expect(reopened.getRun(id)?.status, id).toBe('failed');
      expect(reopened.getRun(id)?.error, id).toMatch(/^interrupted — /);
    }
    expect(reopened.getRun('was-running')?.steps[0]?.status).toBe('failed');
  });

  it('keeps no promise to resume a task the old host parked on a usage limit', async () => {
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    const parked = { ...RESTORED[0]!, id: 'limit-parked', status: 'failed', error: 'usage limit', autoResumeAt: inAnHour, autoResumeAttempts: 1 };
    // Archive time: the backup's copy is settled already.
    const [captured] = settleLiveRuns([parked], 'backup x') as Array<Record<string, unknown>>;
    expect(captured?.autoResumeAt).toBeUndefined();
    expect(captured?.error).toMatch(/usage limit\nautomatic resume cancelled — captured by backup x/);

    // Restore time: an archive written before that is settled as it is placed.
    const log: string[] = [];
    await apply(stage({ '.ai/cezar/runs.json': JSON.stringify([parked]) }), log);
    const store = RunStore.open(join(root, '.ai', 'cezar'), { keepLive: true });
    expect(store.getRun('limit-parked')?.autoResumeAt).toBeUndefined();
    expect(store.getRun('limit-parked')?.error).toMatch(/automatic resume cancelled — captured by the backup from box/);
    const savedDry = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    const manager = new RunManager(store, root);
    try {
      await manager.recover(); // → reconcileAutoResumes
      expect((manager as unknown as { autoResumeTimers: Map<string, unknown> }).autoResumeTimers.size).toBe(0);
      expect(store.getRun('limit-parked')?.status).toBe('failed');
    } finally {
      manager.dispose();
      store.flush();
      if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDry;
    }
  });

  it('prunes nothing on the first boot after a restore, says what it kept, and prunes on the next', async () => {
    const stray = 'stray-run-with-no-record';
    git(root, 'worktree', 'add', '-q', '-b', branchFor(stray), worktreePathFor(root, stray), 'main');
    writeRestoreMarker({ archive: 'cezar-backup-box-20260101T0000Z.tar.gz.age' });
    const lines: string[] = [];
    expect(consumeRestoreMarker((line) => lines.push(line))).toBe(true);
    expect(orphanPruneSuspended()).toBe(true);
    expect(await pruneOrphans(root, new Set(), undefined, (line) => lines.push(line))).toEqual([]);
    expect(existsSync(worktreePathFor(root, stray))).toBe(true);
    expect(lines.join('\n')).toContain(stray.slice(0, 8));

    // The marker is consumed: the boot after that one is an ordinary boot.
    resetRestoreGuardForTests();
    expect(consumeRestoreMarker(() => {})).toBe(false);
    expect(await pruneOrphans(root, new Set())).toEqual([stray]);
  }, 30_000);
});
