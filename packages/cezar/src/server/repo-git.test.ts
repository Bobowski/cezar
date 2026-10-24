import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTaskRemotes } from '../git-remotes.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import {
  abortOperation,
  checkoutBranch,
  cherryPick,
  commitIndex,
  compareWithCurrent,
  continueOperation,
  deleteBranch,
  discardPaths,
  extractHunk,
  fetchRemote,
  listRemotes,
  listStashes,
  mergeBranch,
  pushBranch,
  rebaseOnto,
  renameBranch,
  repoGraph,
  repoIndex,
  stagePaths,
  stashPop,
  stashPush,
  stripCredentials,
  unstagePaths,
} from './repo-git.ts';

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function identity(dir: string): void {
  g(dir, 'config', 'user.email', 'test@cezar.local');
  g(dir, 'config', 'user.name', 'cezar-test');
  g(dir, 'config', 'commit.gpgsign', 'false');
  g(dir, 'config', 'core.autocrlf', 'false');
}

function commit(dir: string, file: string, content: string, message = content): string {
  writeFileSync(join(dir, file), `${content}\n`);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', message);
  return g(dir, 'rev-parse', 'HEAD').trim();
}

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

describe('the Git page against a temp repo with a bare origin', () => {
  let base: string;
  let remote: string;
  let repo: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN;
    base = mkdtempSync(join(tmpdir(), 'cez-git-view-'));
    remote = join(base, 'origin.git');
    repo = join(base, 'repo');
    g(base, 'init', '-q', '--bare', '-b', 'main', remote);
    g(base, 'clone', '-q', remote, repo);
    identity(repo);
    g(repo, 'checkout', '-q', '-b', 'main');
    commit(repo, 'a.txt', 'first');
    g(repo, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => {
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    removeTempDir(base);
  });

  describe('graph', () => {
    it('lists HEAD, local, remote and task branches with labels, merged marks and fork points', async () => {
      const forkPoint = g(repo, 'rev-parse', 'HEAD').trim();
      g(repo, 'checkout', '-q', '-b', 'cez/1a2b3c4d');
      commit(repo, 't.txt', 'task work');
      g(repo, 'checkout', '-q', 'main');
      g(repo, 'checkout', '-q', '-b', 'feat/named');
      commit(repo, 'n.txt', 'named task');
      g(repo, 'checkout', '-q', 'main');
      g(repo, 'branch', 'cez/merged');
      commit(repo, 'b.txt', 'second');

      const tasks = new Map([['feat/named', { runId: 'r1', title: 'Named task', status: 'review' as const }]]);
      const res = await repoGraph(repo, { tasks });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const { graph } = res;
      expect(graph.head).toBe(g(repo, 'rev-parse', 'HEAD').trim());
      expect(graph.commits.map((c) => c.subject)).toEqual(expect.arrayContaining(['second', 'task work', 'named task', 'first']));
      // Children before parents, so lanes can be drawn top-down.
      const order = graph.commits.map((c) => c.subject);
      expect(order.indexOf('second')).toBeLessThan(order.indexOf('first'));
      const ref = (name: string) => graph.refs.find((r) => r.name === name);
      expect(ref('main')).toMatchObject({ current: true, base: true, kind: 'local', isTask: false });
      expect(ref('origin/main')).toMatchObject({ kind: 'remote', remote: 'origin', branch: 'main' });
      expect(ref('cez/1a2b3c4d')).toMatchObject({ isTask: true, task: null, merged: false, mergeBase: forkPoint });
      expect(ref('feat/named')).toMatchObject({ isTask: true, task: { runId: 'r1', title: 'Named task', status: 'review' } });
      expect(ref('cez/merged')).toMatchObject({ isTask: true, merged: true });
      expect(graph.refs.some((r) => r.name === 'origin/HEAD')).toBe(false);
    });

    it('filters to task branches and pages with a cursor', async () => {
      g(repo, 'checkout', '-q', '-b', 'cez/aaaa1111');
      commit(repo, 't.txt', 'task');
      g(repo, 'checkout', '-q', 'main');
      g(repo, 'branch', 'side');
      for (let i = 0; i < 4; i++) commit(repo, 'c.txt', `c${i}`);

      const tasks = await repoGraph(repo, { filter: 'tasks' });
      expect(tasks.ok && tasks.graph.refs.map((r) => r.name).sort()).toEqual(['cez/aaaa1111', 'main']);
      const mine = await repoGraph(repo, { filter: 'mine' });
      expect(mine.ok && mine.graph.refs.map((r) => r.name).sort()).toEqual(['main', 'side']);

      const first = await repoGraph(repo, { limit: 2 });
      expect(first.ok && first.graph.commits.length).toBe(2);
      expect(first.ok && first.graph.next).toBe('2');
      const rest = await repoGraph(repo, { limit: 100, skip: 2 });
      expect(rest.ok && rest.graph.next).toBeNull();
      expect(rest.ok && rest.graph.commits.length).toBeGreaterThan(0);
    });
  });

  describe('merge and conflicts', () => {
    it('merges a clean branch', async () => {
      g(repo, 'checkout', '-q', '-b', 'feature');
      commit(repo, 'f.txt', 'feature');
      g(repo, 'checkout', '-q', 'main');
      const res = await mergeBranch(repo, 'feature');
      expect(res).toEqual({ ok: true, message: 'merged feature into main', conflicts: [] });
      expect(existsSync(join(repo, 'f.txt'))).toBe(true);
    });

    it('refuses to merge over a dirty tree, naming the files, and leaves them as they were', async () => {
      g(repo, 'checkout', '-q', '-b', 'feature');
      commit(repo, 'f.txt', 'feature');
      g(repo, 'checkout', '-q', 'main');
      writeFileSync(join(repo, 'a.txt'), 'mine, unsaved\n');
      const head = g(repo, 'rev-parse', 'HEAD').trim();
      const refused = await mergeBranch(repo, 'feature');
      expect(refused).toEqual({ ok: false, error: expect.stringMatching(/uncommitted changes \(a\.txt\)/) });
      expect(g(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('mine, unsaved\n');
    });

    it('stops on a conflict, lists the files, and Abort restores the state before it', async () => {
      g(repo, 'checkout', '-q', '-b', 'feature');
      commit(repo, 'a.txt', 'theirs');
      g(repo, 'checkout', '-q', 'main');
      const before = commit(repo, 'a.txt', 'ours');

      const res = await mergeBranch(repo, 'feature');
      expect(res.ok && res.conflicts).toEqual(['a.txt']);
      const index = await repoIndex(repo);
      expect(index.ok && index.index.conflicted).toEqual(['a.txt']);
      expect(index.ok && index.index.operation?.kind).toBe('merge');
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('<<<<<<<');

      // Continue refuses while the conflict is unresolved.
      const early = await continueOperation(repo);
      expect(early.ok).toBe(false);

      const aborted = await abortOperation(repo);
      expect(aborted).toEqual({ ok: true, message: 'merge aborted', conflicts: [] });
      expect(g(repo, 'rev-parse', 'HEAD').trim()).toBe(before);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('ours\n');
      const after = await repoIndex(repo);
      expect(after.ok && after.index.operation).toBeNull();
    });

    it('Continue concludes a merge once the conflict is resolved and staged', async () => {
      g(repo, 'checkout', '-q', '-b', 'feature');
      commit(repo, 'a.txt', 'theirs');
      g(repo, 'checkout', '-q', 'main');
      commit(repo, 'a.txt', 'ours');
      await mergeBranch(repo, 'feature');
      writeFileSync(join(repo, 'a.txt'), 'both\n');
      expect((await stagePaths(repo, { paths: ['a.txt'] })).ok).toBe(true);
      const res = await continueOperation(repo);
      expect(res).toEqual({ ok: true, message: 'merge finished', conflicts: [] });
      expect(g(repo, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
    });

    it('cherry-picks a commit', async () => {
      g(repo, 'checkout', '-q', '-b', 'feature');
      const sha = commit(repo, 'p.txt', 'picked');
      g(repo, 'checkout', '-q', 'main');
      const res = await cherryPick(repo, sha);
      expect(res.ok && res.message).toBe(`cherry-picked ${sha.slice(0, 8)}`);
      expect(readFileSync(join(repo, 'p.txt'), 'utf8')).toBe('picked\n');
    });
  });

  describe('rebase and amend never rewrite pushed commits', () => {
    it('refuses to rebase a branch whose commits are on a remote, and rebases a local one', async () => {
      g(repo, 'checkout', '-q', '-b', 'feature');
      commit(repo, 'f.txt', 'feature');
      g(repo, 'push', '-q', '-u', 'origin', 'feature');
      g(repo, 'checkout', '-q', 'main');
      commit(repo, 'm.txt', 'main moved');
      g(repo, 'checkout', '-q', 'feature');

      const refused = await rebaseOnto(repo, 'main');
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error).toMatch(/already on a remote/);

      g(repo, 'checkout', '-q', '-b', 'local-only', 'main~1');
      commit(repo, 'l.txt', 'local');
      const res = await rebaseOnto(repo, 'main');
      expect(res).toEqual({ ok: true, message: 'rebased local-only onto main', conflicts: [] });
      expect(g(repo, 'merge-base', '--is-ancestor', 'main', 'HEAD')).toBe('');
    });

    it('refuses to amend a pushed HEAD and amends an unpushed one', async () => {
      writeFileSync(join(repo, 'a.txt'), 'changed\n');
      await stagePaths(repo, { paths: ['a.txt'] });
      const refused = await commitIndex(repo, { message: 'x', amend: true });
      expect(!refused.ok && refused.error).toMatch(/already on origin\/main/);

      const made = await commitIndex(repo, { message: 'local commit' });
      expect(made.ok).toBe(true);
      writeFileSync(join(repo, 'z.txt'), 'z\n');
      await stagePaths(repo, { paths: ['z.txt'] });
      const amended = await commitIndex(repo, { message: '', amend: true });
      expect(amended.ok).toBe(true);
      expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('local commit');
      expect(g(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'z.txt']);
    });

    it('commits the index only, never the unstaged rest', async () => {
      writeFileSync(join(repo, 'a.txt'), 'staged\n');
      writeFileSync(join(repo, 'u.txt'), 'untracked\n');
      await stagePaths(repo, { paths: ['a.txt'] });
      const made = await commitIndex(repo, { message: 'only a' });
      expect(made.ok).toBe(true);
      expect(g(repo, 'status', '--porcelain').trim()).toBe('?? u.txt');
      expect((await commitIndex(repo, { message: '' })).ok).toBe(false);
    });
  });

  describe('staging', () => {
    beforeEach(() => {
      commit(repo, 'h.txt', TEN.join('\n'), 'ten lines');
    });

    it('stages and unstages one hunk of a file, round trip', async () => {
      const lines = [...TEN];
      lines[0] = 'line 1 changed';
      lines[9] = 'line 10 changed';
      writeFileSync(join(repo, 'h.txt'), `${lines.join('\n')}\n`);
      g(repo, 'config', 'diff.context', '1');

      const before = await repoIndex(repo);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const file = before.index.unstaged.find((f) => f.path === 'h.txt')!;
      const hunks = file.patch.split('\n').filter((l) => l.startsWith('@@'));
      expect(hunks).toHaveLength(2);

      expect(await stagePaths(repo, { path: 'h.txt', hunk: hunks[1]! })).toEqual({ ok: true });
      const staged = g(repo, 'diff', '--cached', '--', 'h.txt');
      expect(staged).toContain('+line 10 changed');
      expect(staged).not.toContain('+line 1 changed');
      expect(g(repo, 'diff', '--', 'h.txt')).toContain('+line 1 changed');

      const mid = await repoIndex(repo);
      const stagedHunk = mid.ok ? mid.index.staged.find((f) => f.path === 'h.txt')!.patch.split('\n').find((l) => l.startsWith('@@'))! : '';
      expect(await unstagePaths(repo, { path: 'h.txt', hunk: stagedHunk })).toEqual({ ok: true });
      expect(g(repo, 'diff', '--cached').trim()).toBe('');
      expect(readFileSync(join(repo, 'h.txt'), 'utf8')).toBe(`${lines.join('\n')}\n`);
    });

    it('a hunk that is gone is refused with a reason', async () => {
      const res = await stagePaths(repo, { path: 'h.txt', hunk: '@@ -1,3 +1,3 @@' });
      expect(res.ok).toBe(false);
    });

    it('lists untracked files on the unstaged side without writing the real index', async () => {
      writeFileSync(join(repo, 'new.txt'), 'new\n');
      const index = await repoIndex(repo);
      expect(index.ok && index.index.unstaged.find((f) => f.path === 'new.txt')).toMatchObject({ status: 'added', untracked: true });
      expect(g(repo, 'status', '--porcelain').trim()).toBe('?? new.txt');
      // Staging one hunk of an untracked file adds it.
      const hunk = index.ok ? index.index.unstaged.find((f) => f.path === 'new.txt')!.patch.split('\n').find((l) => l.startsWith('@@'))! : '';
      expect(await stagePaths(repo, { path: 'new.txt', hunk })).toEqual({ ok: true });
      expect(g(repo, 'status', '--porcelain').trim()).toBe('A  new.txt');
    });

    it('discards a file, an untracked file and a hunk', async () => {
      writeFileSync(join(repo, 'h.txt'), 'rewritten\n');
      writeFileSync(join(repo, 'junk.txt'), 'junk\n');
      expect(await discardPaths(repo, { paths: ['h.txt', 'junk.txt'], confirm: true, untracked: true })).toEqual({ ok: true });
      expect(readFileSync(join(repo, 'h.txt'), 'utf8')).toBe(`${TEN.join('\n')}\n`);
      expect(existsSync(join(repo, 'junk.txt'))).toBe(false);

      const lines = [...TEN];
      lines[0] = 'one';
      lines[9] = 'ten';
      writeFileSync(join(repo, 'h.txt'), `${lines.join('\n')}\n`);
      g(repo, 'config', 'diff.context', '1');
      const index = await repoIndex(repo);
      const first = index.ok ? index.index.unstaged[0]!.patch.split('\n').find((l) => l.startsWith('@@'))! : '';
      expect(await discardPaths(repo, { path: 'h.txt', hunk: first })).toMatchObject({ ok: false });
      expect(await discardPaths(repo, { path: 'h.txt', hunk: first, confirm: true })).toEqual({ ok: true });
      const now = readFileSync(join(repo, 'h.txt'), 'utf8');
      expect(now).toContain('line 1\n');
      expect(now).toContain('ten\n');
    });

    it('discards nothing without the confirm, a directory or stale path, or an untracked file it was not told about', async () => {
      mkdirSync(join(repo, 'dir'));
      writeFileSync(join(repo, 'dir/keep.txt'), 'mine\n');
      writeFileSync(join(repo, 'h.txt'), 'rewritten\n');
      const refused = await discardPaths(repo, { paths: ['h.txt'] });
      expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/confirm/) });
      expect(readFileSync(join(repo, 'h.txt'), 'utf8')).toBe('rewritten\n');
      // A directory would match every file under it; only an exact file is accepted.
      expect(await discardPaths(repo, { paths: ['dir'], confirm: true, untracked: true })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not an unstaged file: dir/),
      });
      expect(await discardPaths(repo, { paths: ['dir/keep.txt'], confirm: true })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/untracked/),
      });
      expect(existsSync(join(repo, 'dir/keep.txt'))).toBe(true);
      expect(readFileSync(join(repo, 'h.txt'), 'utf8')).toBe('rewritten\n');
    });

    it('stashes, lists and pops', async () => {
      writeFileSync(join(repo, 'h.txt'), 'wip\n');
      expect(await stashPush(repo, { message: 'my wip' })).toEqual({ ok: true, message: 'stashed “my wip”' });
      expect(g(repo, 'status', '--porcelain').trim()).toBe('');
      const list = await listStashes(repo);
      expect(list.ok && list.stashes).toEqual([{ index: 0, message: 'On main: my wip', when: expect.any(String) }]);
      expect((await stashPush(repo, {})).ok).toBe(false);
      expect(await stashPop(repo, 0)).toEqual({ ok: true, message: 'popped stash@{0}', conflicts: [] });
      expect(readFileSync(join(repo, 'h.txt'), 'utf8')).toBe('wip\n');
      expect((await stashPop(repo, 0)).ok).toBe(false);
    });
  });

  describe('branch actions', () => {
    it('refuses to check out over a dirty tree, then checks out a remote-only branch as a tracking branch', async () => {
      g(repo, 'push', '-q', 'origin', 'main:refs/heads/remote-only');
      g(repo, 'fetch', '-q', 'origin');
      writeFileSync(join(repo, 'a.txt'), 'dirty\n');
      const refused = await checkoutBranch(repo, 'origin/remote-only');
      expect(!refused.ok && refused.error).toMatch(/uncommitted changes/);
      g(repo, 'checkout', '--', 'a.txt');
      const res = await checkoutBranch(repo, 'origin/remote-only');
      expect(res.ok).toBe(true);
      expect(g(repo, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/remote-only');
    });

    it('renames, pushes to a named remote and deletes local and remote', async () => {
      g(repo, 'checkout', '-q', '-b', 'topic');
      commit(repo, 't.txt', 'topic');
      g(repo, 'checkout', '-q', 'main');
      expect((await renameBranch(repo, 'topic', 'topic-2')).ok).toBe(true);
      expect((await renameBranch(repo, 'topic-2', 'bad name')).ok).toBe(false);

      expect(await pushBranch(repo, 'topic-2', 'origin')).toEqual({ ok: true, message: 'pushed topic-2 to origin', conflicts: [] });
      expect(g(remote, 'branch', '--list', 'topic-2').trim()).toBe('topic-2');
      expect((await pushBranch(repo, 'topic-2', 'nowhere')).ok).toBe(false);

      g(repo, 'checkout', '-q', '-b', 'unpushed');
      commit(repo, 'u.txt', 'unpushed');
      g(repo, 'checkout', '-q', 'main');
      const unmerged = await deleteBranch(repo, 'unpushed');
      expect(!unmerged.ok && unmerged.error).toMatch(/not fully merged/);
      expect((await deleteBranch(repo, 'unpushed', { force: true })).ok).toBe(true);

      const res = await deleteBranch(repo, 'topic-2', { remote: true, force: true });
      expect(res).toEqual({ ok: true, message: 'deleted topic-2, deleted origin/topic-2', conflicts: [] });
      expect(g(remote, 'branch', '--list', 'topic-2').trim()).toBe('');
      expect((await deleteBranch(repo, 'main')).ok).toBe(false);
    });

    it('compares a branch with the current one from their merge-base', async () => {
      g(repo, 'checkout', '-q', '-b', 'feature');
      commit(repo, 'f.txt', 'feature');
      g(repo, 'checkout', '-q', 'main');
      commit(repo, 'm.txt', 'main only');
      const res = await compareWithCurrent(repo, 'feature');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.compare.files.map((f) => f.path)).toEqual(['f.txt']);
      expect(res.compare.against).toBe('main');
      expect((await compareWithCurrent(repo, '--output=x')).ok).toBe(false);
    });
  });

  describe('remotes', () => {
    it('lists every remote with the same answer resolveTaskRemotes gives, credentials stripped', async () => {
      g(repo, 'remote', 'add', 'upstream', 'https://user:secret@example.com/acme/repo.git');
      g(repo, 'config', 'remote.pushDefault', 'upstream');
      const res = await listRemotes(repo);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const resolved = await resolveTaskRemotes((args) => Promise.resolve({ ok: true, stdout: g(repo, ...args) }));
      expect(res.remotes.prTarget).toBe(resolved.base);
      expect(res.remotes.pushDefault).toBe(resolved.push);
      expect(res.remotes.reasons).toEqual({ prTarget: resolved.baseReason, pushDefault: resolved.pushReason });
      expect(res.remotes.reasons).toEqual({ prTarget: 'origin', pushDefault: 'push-default' });
      expect(res.remotes.remotes.find((r) => r.name === 'upstream')?.url).toBe('https://example.com/acme/repo.git');
      expect(res.remotes.remotes.find((r) => r.name === 'origin')?.branches).toEqual(['main']);
    });

    it('fetches a named remote, refusing an unknown one', async () => {
      expect(await fetchRemote(repo, 'origin')).toEqual({ ok: true, message: 'fetched origin' });
      expect((await fetchRemote(repo, 'nope')).ok).toBe(false);
    });

    it('strips credentials from URLs', () => {
      expect(stripCredentials('https://x-access-token:abc@github.com/a/b.git')).toBe('https://github.com/a/b.git');
      expect(stripCredentials('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    });
  });
});

describe('extractHunk', () => {
  const patch = [
    'diff --git a/x b/x',
    'index 1..2 100644',
    '--- a/x',
    '+++ b/x',
    '@@ -1,2 +1,2 @@ fn',
    '-a',
    '+b',
    ' c',
    '@@ -9 +9 @@',
    '-y',
    '+z',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('cuts one hunk with the file header, whatever context the header carried', () => {
    expect(extractHunk(patch, '@@ -9,1 +9,1 @@')).toBe(
      ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -9 +9 @@', '-y', '+z', '\\ No newline at end of file', ''].join('\n'),
    );
    expect(extractHunk(patch, '@@ -1,2 +1,2 @@')).toContain('-a\n+b\n c\n');
    expect(extractHunk(patch, '@@ -5 +5 @@')).toBeNull();
    expect(extractHunk(patch, 'nonsense')).toBeNull();
  });
});
