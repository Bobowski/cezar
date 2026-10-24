import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authSetupBeginResponseSchema, type RepoGitActionResponse, type RepoGraph, type RepoIndex, type RepoRemotes } from '@open-mercato/cezar-contract';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode } from '../auth/store.ts';
import { base32Decode, hotp, totpStep } from '../auth/totp.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { landInPlace } from '../workflows/landing.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { serializeCheckout } from './repo-sync.ts';
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

  it('delete refuses a branch a task owns, locally or on its remote, naming the task', async () => {
    g(repo, 'branch', 'feat/owned');
    g(repo, 'push', '-q', 'origin', 'feat/owned');
    const run = store.createRun({ title: 'Owned thing', task: 'Do it', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { branch: 'feat/owned' });
    for (const [name, query] of [['feat/owned', ''], ['origin/feat/owned', '?remote=1'], ['feat/owned', '?remote=1&force=1']] as const) {
      const res = await apiRequest(app, `/api/v1/repo/branch/${encodeURIComponent(name)}/delete${query}`, { method: 'POST' });
      expect(res.status, name).toBe(409);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('Owned thing');
      expect(error).toContain(run.id.slice(0, 8));
    }
    expect(g(repo, 'branch', '--list', 'feat/owned').trim()).toBe('feat/owned');
    expect(g(repo, 'ls-remote', '--heads', 'origin', 'feat/owned').trim()).not.toBe('');
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

  it('stage, unstage, commit and amend are refused while an in-place task works in the checkout', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    g(repo, 'add', 'a.txt');
    const run = store.createRun({ title: 'x', task: 'x', workflow: 'quick-task', worktree: false, steps: [] });
    store.updateRun(run.id, { status: 'running' });
    const post = (path: string, body: unknown) =>
      apiRequest(app, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    for (const [path, body] of [
      ['/api/v1/repo/stage', { paths: ['a.txt'] }],
      ['/api/v1/repo/unstage', { paths: ['a.txt'] }],
      ['/api/v1/repo/commit', { message: 'mid-task' }],
      ['/api/v1/repo/commit', { message: '', amend: true }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status, path).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/in-place task/);
    }
    expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('first');
    expect(g(repo, 'status', '--porcelain', '--', 'a.txt')).toBe('M  a.txt\n');
  });

  it('a Git-page action refuses while a landing holds the checkout, so the push lands main’s own commit', async () => {
    // The landing's pathspec names .ai/cezar, which `git add` refuses when .gitignore ignores .ai/.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    g(repo, 'commit', '-q', '-am', 'stop ignoring .ai');
    g(repo, 'push', '-q');
    g(repo, 'branch', 'other');
    writeFileSync(join(repo, 'a.txt'), 'landed\n');
    let checking!: () => void;
    const inChecks = new Promise<void>((resolve) => (checking = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const landing = landInPlace(repo, {
      describe: async () => 'the landing',
      checks: ['slow check'],
      runCheck: async () => {
        checking();
        await gate;
        return { ok: true, output: '' };
      },
    });
    await inChecks;
    const checkout = await apiRequest(app, '/api/v1/repo/branch/other/checkout', { method: 'POST' });
    expect(checkout.status).toBe(409);
    expect(((await checkout.json()) as { error: string }).error).toMatch(/landing is in progress/);
    const stage = await apiRequest(app, '/api/v1/repo/stage', {
      method: 'POST',
      body: JSON.stringify({ paths: ['a.txt'] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(stage.status).toBe(409);
    release();
    expect(await landing).toMatchObject({ result: 'landed', branch: 'main', pushed: true });
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(g(repo, 'log', '-1', '--format=%s', 'origin/main').trim()).toBe('the landing');
    // Once the landing is done the same action goes through.
    expect((await apiRequest(app, '/api/v1/repo/branch/other/checkout', { method: 'POST' })).status).toBe(200);
  });

  it('POST /repo/branch waits its turn on the checkout queue', async () => {
    let release!: () => void;
    const held = serializeCheckout(repo, () => new Promise<void>((resolve) => (release = resolve)));
    let settled = false;
    const created = apiRequest(app, '/api/v1/repo/branch', {
      method: 'POST',
      body: JSON.stringify({ name: 'queued-branch' }),
      headers: { 'content-type': 'application/json' },
    }).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(settled).toBe(false);
    expect(g(repo, 'branch', '--list', 'queued-branch').trim()).toBe('');
    release();
    await held;
    expect((await created).status).toBe(200);
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('queued-branch');
  });

  it('fetch, pull, push and sync answer 409 during a landing instead of queueing behind it', async () => {
    writeFileSync(join(repo, 'a.txt'), 'landed\n');
    let checking!: () => void;
    const inChecks = new Promise<void>((resolve) => (checking = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const landing = landInPlace(repo, {
      describe: async () => 'the landing',
      checks: ['slow check'],
      runCheck: async () => {
        checking();
        await gate;
        return { ok: true, output: '' };
      },
    });
    await inChecks;
    try {
      for (const path of ['/api/v1/repo/fetch', '/api/v1/repo/pull', '/api/v1/repo/push', '/api/v1/repo/sync']) {
        // A queued request would wait for the gate; a refusal answers at once.
        const answer = await Promise.race([
          apiRequest(app, path, { method: 'POST' }),
          new Promise<'queued'>((resolve) => setTimeout(() => resolve('queued'), 3_000)),
        ]);
        expect(answer, path).not.toBe('queued');
        const res = answer as Response;
        expect(res.status, path).toBe(409);
        expect(((await res.json()) as { error: string }).error).toMatch(/landing is in progress/);
      }
    } finally {
      release();
    }
    expect(await landing).toMatchObject({ result: 'landed', pushed: true });
  });

  it('POST /repo/branch answers 409 during a landing instead of queueing behind it', async () => {
    writeFileSync(join(repo, 'a.txt'), 'landed\n');
    let checking!: () => void;
    const inChecks = new Promise<void>((resolve) => (checking = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const landing = landInPlace(repo, {
      describe: async () => 'the landing',
      checks: ['slow check'],
      runCheck: async () => {
        checking();
        await gate;
        return { ok: true, output: '' };
      },
    });
    await inChecks;
    try {
      const answer = await Promise.race([
        apiRequest(app, '/api/v1/repo/branch', {
          method: 'POST',
          body: JSON.stringify({ name: 'mid-landing' }),
          headers: { 'content-type': 'application/json' },
        }),
        new Promise<'queued'>((resolve) => setTimeout(() => resolve('queued'), 3_000)),
      ]);
      expect(answer).not.toBe('queued');
      const res = answer as Response;
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/landing is in progress/);
    } finally {
      release();
    }
    expect(await landing).toMatchObject({ result: 'landed', branch: 'main', pushed: true });
    expect(g(repo, 'branch', '--list', 'mid-landing').trim()).toBe('');
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

  it('POST /repo/discard 409s without the confirm, and for an untracked file without its own flag', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const discard = (body: Record<string, unknown>) =>
      apiRequest(app, '/api/v1/repo/discard', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await discard({ paths: ['a.txt'] })).status).toBe(409);
    expect((await discard({ paths: ['new.txt'], confirm: true })).status).toBe(409);
    expect(g(repo, 'status', '--porcelain', '--', 'a.txt', 'new.txt')).toBe(' M a.txt\n?? new.txt\n');
    const ok = await discard({ paths: ['a.txt', 'new.txt'], confirm: true, untracked: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RepoIndex).unstaged).toEqual([]);
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

/** A hosted cockpit's signed-in owner: git's refusals reach the browser without host paths. */
describe('the Git page routes, hosted', () => {
  const HOSTED = { host: 'agents.example.dev', 'x-forwarded-proto': 'https' };
  const saved = { remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };
  let base: string;
  let repo: string;
  let store: RunStore;
  let app: Hono;
  let cookie: string;
  let clock = Date.now();

  const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(path, { ...init, headers: { ...HOSTED, ...init.headers } });
  const json = (path: string, body: unknown) =>
    request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  beforeEach(async () => {
    process.env.CEZ_REMOTE = '1';
    delete process.env.CEZ_AUTH;
    base = mkdtempSync(join(tmpdir(), 'cez-git-hosted-'));
    repo = join(base, 'repo');
    g(base, 'init', '-q', '-b', 'main', repo);
    for (const [key, value] of [['user.email', 't@cezar.local'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(repo, 'config', key!, value!);
    writeFileSync(join(repo, '.gitignore'), '.ai/\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'first');
    store = RunStore.open(join(repo, '.ai/cezar'));
    app = createApp({
      repoRoot: repo,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      auth: new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 }, now: () => clock }),
    }) as unknown as Hono;
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('setup refused');
    const begin = await json('/api/v1/auth/setup/begin', { code: issued.setup.code, username: 'owner', password: 'a long enough password' });
    const begun = authSetupBeginResponseSchema.parse(await begin.json());
    const complete = await json('/api/v1/auth/setup/complete', {
      ticket: begun.ticket,
      code: hotp(base32Decode(begun.secret)!, totpStep((clock += 30_000))),
    });
    expect(complete.status).toBe(200);
    cookie = complete.headers.get('set-cookie')!.split(';')[0]!;
  });

  afterEach(() => {
    store.flush();
    for (const [key, value] of [['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempDir(base);
  });

  it('delete passes git’s refusal on with the worktree’s absolute path trimmed', async () => {
    const elsewhere = join(base, 'elsewhere-wt');
    g(repo, 'worktree', 'add', '-q', '-b', 'busy', elsewhere);
    const res = await request('/api/v1/repo/branch/busy/delete', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('elsewhere-wt');
    expect(error).not.toContain(base.replace(/\\/g, '/'));
    expect(error).not.toContain(base);
    expect(g(repo, 'branch', '--list', 'busy').trim()).toBe('+ busy');
  });
});
