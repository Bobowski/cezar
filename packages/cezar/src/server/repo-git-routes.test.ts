import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoGitActionResponse, RepoGraph, RepoIndex, RepoRemotes } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** The Git page's routes (spec 2026-10-24-git-view §4) through a real app on a temp checkout. */
describe('the Git page routes', () => {
  let base: string;
  let repo: string;
  let store: RunStore;
  let app: Hono;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    delete process.env.CEZ_DRY_RUN;
    base = mkdtempSync(join(tmpdir(), 'cez-git-routes-'));
    repo = join(base, 'repo');
    g(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'origin.git'));
    g(base, 'clone', '-q', join(base, 'origin.git'), repo);
    for (const [key, value] of [['user.email', 't@cezar.local'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
      g(repo, 'config', key!, value!);
    }
    g(repo, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), '.ai/\n');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'first');
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    store = RunStore.open(join(repo, '.ai/cezar'));
    app = createApp({ repoRoot: repo, store, manager: {} as unknown as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    removeTempDir(base);
  });

  it('GET /repo/graph labels a task branch with its task, on both mounts', async () => {
    g(repo, 'checkout', '-q', '-b', 'feat/named');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'task commit');
    g(repo, 'checkout', '-q', 'main');
    const run = store.createRun({ title: 'Named thing', task: 'Do the named thing', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { branch: 'feat/named' });

    for (const path of ['/api/v1/repo/graph?filter=tasks', '/api/v1/p/default/repo/graph?filter=tasks']) {
      const res = await apiRequest(app, path);
      expect(res.status).toBe(200);
      const graph = (await res.json()) as RepoGraph;
      expect(graph.refs.find((r) => r.name === 'feat/named')).toMatchObject({ isTask: true, task: { runId: run.id, title: 'Named thing' } });
      expect(graph.commits.map((c) => c.subject)).toContain('task commit');
    }
    expect((await apiRequest(app, '/api/v1/repo/graph?filter=nope')).status).toBe(400);
  });

  it('a branch name with a slash reaches the action through an encoded path segment', async () => {
    g(repo, 'branch', 'feat/slash');
    const res = await apiRequest(app, `/api/v1/repo/branch/${encodeURIComponent('feat/slash')}/checkout`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RepoGitActionResponse).message).toBe('switched to feat/slash');
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/slash');
  });

  it('refuses an option-like branch name and answers git failures as 409 { error }', async () => {
    const dash = await apiRequest(app, `/api/v1/repo/branch/${encodeURIComponent('--orphan')}/merge`, { method: 'POST' });
    expect(dash.status).toBe(409);
    expect(((await dash.json()) as { error: string }).error).toContain('invalid branch name');
    const missing = await apiRequest(app, '/api/v1/repo/branch/ghost/rebase', { method: 'POST' });
    expect(missing.status).toBe(409);
  });

  it('checkout is refused while an in-place task works in the checkout', async () => {
    g(repo, 'branch', 'other');
    const run = store.createRun({ title: 'x', task: 'x', workflow: 'quick-task', worktree: false, steps: [] });
    store.updateRun(run.id, { status: 'running' });
    const res = await apiRequest(app, '/api/v1/repo/branch/other/checkout', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/in-place task/);
  });

  it('stage → index → commit through the API, the body validated as middleware', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect((await apiRequest(app, '/api/v1/repo/stage', { method: 'POST', body: JSON.stringify({ path: 'a.txt' }), headers: { 'content-type': 'application/json' } })).status).toBe(400);
    const staged = await apiRequest(app, '/api/v1/repo/stage', {
      method: 'POST',
      body: JSON.stringify({ paths: ['a.txt'] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(staged.status).toBe(200);
    expect(((await staged.json()) as RepoIndex).staged.map((f) => f.path)).toEqual(['a.txt']);
    const commit = await apiRequest(app, '/api/v1/repo/commit', {
      method: 'POST',
      body: JSON.stringify({ message: 'from the cockpit' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(commit.status).toBe(200);
    expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('from the cockpit');
  });

  it('a hosted cockpit without cezar’s own sign-in refuses every git mutation', async () => {
    g(repo, 'branch', 'other');
    process.env.CEZ_REMOTE = '1';
    process.env.CEZ_AUTH = '0';
    try {
      const res = await apiRequest(app, '/api/v1/repo/branch/other/checkout', { method: 'POST' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/sign-in/);
    } finally {
      delete process.env.CEZ_REMOTE;
      delete process.env.CEZ_AUTH;
    }
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('GET /repo/remotes names the PR target and the push default with their reasons', async () => {
    const res = await apiRequest(app, '/api/v1/repo/remotes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoRemotes;
    expect(body).toMatchObject({ prTarget: 'origin', pushDefault: 'origin', reasons: { prTarget: 'origin', pushDefault: 'origin' } });
  });
});
