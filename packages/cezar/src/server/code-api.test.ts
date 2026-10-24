import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  codeSearchResultSchema, codeWatchSchema, discoveredCommandsSchema, projectDetectedUrlsSchema, repoPullResponseSchema, repoSyncSchema,
  terminalHistorySchema, terminalSessionSchema, terminalStateSchema, worktreeEntrySchema,
} from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { fakeServiceBinding } from '../services/testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { PreviewGateways } from './preview/gateway.ts';
import { createApp } from './server.ts';
import { DetectedUrls } from './terminal/detected-urls.ts';
import { TerminalHistory } from './terminal/history.ts';
import { TerminalSessions } from './terminal/sessions.ts';

describe('Code page API (spec 2026-10-11-code-page)', () => {
  let root: string;
  let store: RunStore;
  let sessions: TerminalSessions;
  let detected: DetectedUrls;
  let history: TerminalHistory;
  /** The process table the history's prompt check reads: the fake shell (pid 4242) with or without a child. */
  let shellBusy = false;
  /** How long that table takes to read. */
  let psDelayMs = 0;
  /** The history's clock, moved by hand where the time between lines matters. */
  let now = 0;
  /** A host whose process table cannot be read (no `ps`: Windows). */
  let psUnreadable = false;
  let spawned: ReturnType<typeof fakeServiceBinding>['spawned'];
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-code-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    put('.gitignore', '.env\nhome/\n.ai/\nignored/\n');
    put('src/app.ts', 'export const greeting = "hello";\n');
    put('src/util.ts', 'export const HELLO = 1;\n');
    put('.env', 'SECRET=hello-secret\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    put('notes.md', 'untracked hello\n');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    const fake = fakeServiceBinding();
    spawned = fake.spawned;
    shellBusy = false;
    psDelayMs = 0;
    now = 0;
    psUnreadable = false;
    detected = new DetectedUrls();
    history = new TerminalHistory(() => now);
    sessions = new TerminalSessions(fake.binding, detected, () => null);
  });
  afterEach(() => {
    sessions.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const app = async (extra: Partial<Parameters<typeof createApp>[0]> = {}) => {
    const project = await registerProject(root);
    return {
      id: project.id,
      instance: createApp({
        repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id, terminalSessions: sessions,
        detectedUrls: detected, terminalHistory: history, ...extra,
        // The table as it stood when the check began; the answer arrives `psDelayMs` later.
        freshProcesses: async () => {
          const busy = shellBusy;
          if (psUnreadable) return null;
          await new Promise((resolve) => setTimeout(resolve, psDelayMs));
          return [{ pid: 4242, ppid: 1, command: 'bash' }, ...(busy ? [{ pid: 5000, ppid: 4242, command: 'sudo apt update' }] : [])];
        },
      }),
    };
  };
  const send = (method: string, body?: unknown): RequestInit => ({
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const file = (path: string) => `/api/v1/repo/files?path=${encodeURIComponent(path)}`;
  const read = async (instance: ReturnType<typeof createApp>, path: string) => {
    const entry = worktreeEntrySchema.parse(await (await apiRequest(instance, file(path))).json());
    if (entry.type !== 'file') throw new Error('expected a file');
    return entry;
  };

  it('saves a file of the main checkout with the hash it was read with, and refuses a stale one', async () => {
    const { id, instance } = await app();
    const opened = await read(instance, 'src/app.ts');
    expect(opened.editable).toBe(true);
    const saved = await apiRequest(instance, `/api/v1/p/${id}/repo/files?path=src%2Fapp.ts`, send('PUT', { content: 'export const greeting = "hi";\n', baseHash: opened.hash }));
    expect(saved.status).toBe(200);
    expect(readFileSync(join(root, 'src/app.ts'), 'utf8')).toBe('export const greeting = "hi";\n');
    // The agent (or anyone) wrote in between: nothing is written, and the answer says so.
    const stale = await apiRequest(instance, file('src/app.ts'), send('PUT', { content: 'clobber', baseHash: opened.hash }));
    expect(stale.status).toBe(409);
    expect(readFileSync(join(root, 'src/app.ts'), 'utf8')).toBe('export const greeting = "hi";\n');
  });

  it('keeps an ignored file unreachable: not read, written, created, renamed onto, deleted or found by search', async () => {
    const { instance } = await app();
    const wording = 'path is not in the repository index: .env';
    for (const response of [
      await apiRequest(instance, file('.env')),
      await apiRequest(instance, file('.env'), send('PUT', { content: 'x', baseHash: 'x' })),
      await apiRequest(instance, file('.env'), send('DELETE')),
      await apiRequest(instance, '/api/v1/repo/files/rename', send('POST', { from: 'src/app.ts', to: '.env' })),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: wording });
    }
    expect((await apiRequest(instance, file('ignored/new.ts'), send('POST', { content: 'x' }))).status).toBe(409);
    expect(existsSync(join(root, 'ignored/new.ts'))).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('SECRET=hello-secret\n');
    const found = codeSearchResultSchema.parse(await (await apiRequest(instance, '/api/v1/repo/search?q=hello')).json());
    expect(found.matches.map((m) => m.path).sort()).toEqual(['notes.md', 'src/app.ts', 'src/util.ts']);
    expect(JSON.stringify(found)).not.toContain('hello-secret');
  });

  it('refuses .git, traversal and a symlink out of the checkout', async () => {
    const { instance } = await app();
    const outside = mkdtempSync(join(tmpdir(), 'cez-code-outside-'));
    symlinkSync(outside, join(root, 'link'));
    for (const path of ['.git/config', '../escape.ts', 'link/x.ts']) {
      expect((await apiRequest(instance, file(path), send('POST', { content: 'x' }))).status, path).toBe(409);
    }
    expect(existsSync(join(outside, 'x.ts'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('creates, renames and deletes a file — delete answers with the blob that holds the bytes', async () => {
    const { instance } = await app();
    expect((await apiRequest(instance, file('src/new/thing.ts'), send('POST', { content: 'export {};\n' }))).status).toBe(201);
    expect((await apiRequest(instance, file('src/new/thing.ts'), send('POST', { content: 'again' }))).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/repo/files/rename', send('POST', { from: 'src/new/thing.ts', to: 'src/thing.ts' }))).status).toBe(200);
    expect(readFileSync(join(root, 'src/thing.ts'), 'utf8')).toBe('export {};\n');
    const removed = await apiRequest(instance, file('src/util.ts'), send('DELETE'));
    expect(removed.status).toBe(200);
    const body = await removed.json() as { blob?: string };
    expect(existsSync(join(root, 'src/util.ts'))).toBe(false);
    expect(execFileSync('git', ['cat-file', '-p', body.blob as string], { cwd: root, encoding: 'utf8' })).toBe('export const HELLO = 1;\n');
  });

  it('searches fixed-string and case-insensitive by default, and by regex, case and glob when asked', async () => {
    const { instance } = await app();
    const search = async (query: string) => codeSearchResultSchema.parse(await (await apiRequest(instance, `/api/v1/repo/search?${query}`)).json());
    expect((await search('q=HELLO&case=1')).matches).toEqual([{ path: 'src/util.ts', line: 1, text: 'export const HELLO = 1;' }]);
    expect((await search('q=hel.o')).matches).toEqual([]);
    expect((await search('q=hel.o&regex=1&glob=src%2F**')).matches.map((m) => m.path)).toEqual(['src/app.ts', 'src/util.ts']);
    expect((await search('q=nothing-matches-this')).truncated).toBe(false);
    expect((await apiRequest(instance, '/api/v1/repo/search')).status).toBe(400);
  });

  it('writes nothing on a hosted cockpit without sign-in, and still reads and searches', async () => {
    vi.stubEnv('CEZ_REMOTE', '1');
    vi.stubEnv('CEZ_AUTH', '0');
    const { instance } = await app();
    const opened = await read(instance, 'src/app.ts');
    expect((await apiRequest(instance, file('src/app.ts'), send('PUT', { content: 'x', baseHash: opened.hash }))).status).toBe(409);
    expect((await apiRequest(instance, file('src/x.ts'), send('POST', { content: 'x' }))).status).toBe(409);
    expect((await apiRequest(instance, file('src/app.ts'), send('DELETE'))).status).toBe(409);
    expect(readFileSync(join(root, 'src/app.ts'), 'utf8')).toBe('export const greeting = "hello";\n');
    expect((await apiRequest(instance, '/api/v1/repo/search?q=hello')).status).toBe(200);
  });

  it('answers a watch topic or null, never an error, for the main checkout and an unknown tree', async () => {
    const { instance } = await app();
    expect(codeWatchSchema.parse(await (await apiRequest(instance, '/api/v1/repo/watch')).json())).toEqual({ topic: null });
    expect(codeWatchSchema.parse(await (await apiRequest(instance, '/api/v1/repo/watch?tree=nope')).json())).toEqual({ topic: null });
  });

  it('reports the checkout\'s distance from origin and fast-forwards it on pull', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    const origin = mkdtempSync(join(tmpdir(), 'cez-code-api-origin-'));
    try {
      git(tmpdir(), 'clone', '-q', '--bare', root, origin);
      git(root, 'remote', 'add', 'origin', origin);
      git(root, 'fetch', '-q', 'origin');
      const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim();
      git(root, 'branch', '-q', `--set-upstream-to=origin/${branch}`);
      const { id, instance } = await app();
      const sync = async (path = '/api/v1/repo/sync') => repoSyncSchema.parse(await (await apiRequest(instance, path)).json());
      expect(await sync()).toMatchObject({ branch, upstream: `origin/${branch}`, ahead: 0, behind: 0, topic: null });

      // Origin moves on: the local read cannot know until a fetch, which `refresh=1` asks for.
      const other = mkdtempSync(join(tmpdir(), 'cez-code-api-other-'));
      try {
        git(tmpdir(), 'clone', '-q', origin, other);
        writeFileSync(join(other, 'upstream.txt'), 'new\n');
        git(other, 'add', '-A');
        git(other, '-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'upstream');
        git(other, 'push', '-q', 'origin', `HEAD:${branch}`);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
      expect((await sync()).behind).toBe(0);
      expect((await sync(`/api/v1/p/${id}/repo/sync?refresh=1`)).behind).toBe(1);

      const pulled = await apiRequest(instance, '/api/v1/repo/pull', send('POST'));
      expect(pulled.status).toBe(200);
      expect(repoPullResponseSchema.parse(await pulled.json())).toMatchObject({ updated: 1, sync: { behind: 0 } });
      expect(existsSync(join(root, 'upstream.txt'))).toBe(true);
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });

  it('opens a terminal owned by the project in the main checkout, apart from any task\'s', async () => {
    const { id, instance } = await app();
    const created = await apiRequest(instance, `/api/v1/p/${id}/repo/terminal`, send('POST', { cols: 100, rows: 30 }));
    expect(created.status).toBe(201);
    const session = terminalSessionSchema.parse(await created.json());
    expect(session.cwd).toBe(root);
    expect(spawned[0]?.options.env.CEZ_TASK_SLOT).toBe('');
    const state = terminalStateSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal')).json());
    expect(state.sessions.map((s) => s.id)).toEqual([session.id]);
    spawned[0]?.emit('$ ');
    expect(await (await apiRequest(instance, `/api/v1/repo/terminal/${session.id}/output`)).json()).toMatchObject({ data: '$ ' });
    expect((await apiRequest(instance, `/api/v1/repo/terminal/${session.id}/input`, send('POST', { data: 'ls\r' }))).status).toBe(200);
    expect(spawned[0]?.written).toEqual(['ls\r']);
    // A task's url cannot drive the project's shell.
    expect((await apiRequest(instance, `/api/v1/runs/some-run/terminal/${session.id}/output`)).status).toBe(404);
    expect((await apiRequest(instance, `/api/v1/repo/terminal/${session.id}`, send('DELETE'))).status).toBe(200);
    expect((await apiRequest(instance, `/api/v1/repo/terminal/${session.id}/output`)).status).toBe(404);
  });

  describe('the Code terminal\'s strips and history (spec 2026-10-24-code-page-terminal §4)', () => {
    it('lists the addresses the project\'s own terminals printed, and no task\'s', async () => {
      const { id, instance } = await app();
      const session = terminalSessionSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal', send('POST', {}))).json());
      spawned[0]?.emit('  ➜  Local:   http://localhost:5173/\r\n');
      detected.record('some-run', 'http://localhost:9999');
      const urls = projectDetectedUrlsSchema.parse(await (await apiRequest(instance, `/api/v1/p/${id}/repo/terminal/urls`)).json());
      expect(urls.urls.map((entry) => entry.url)).toEqual(['http://localhost:5173']);
      // A local cockpit has no tunnel to offer, so it names no account.
      expect(urls.sshUser).toBeUndefined();
      expect(session.id).toBeTruthy();
    });

    it('names the preview pool\'s public ports to a hosted cockpit, and to no other', async () => {
      const previewGateways = new PreviewGateways({ ports: [8500, 8501], publicPorts: [9500, 9501] });
      const local = await app({ previewGateways });
      const read = async (instance: typeof local.instance) =>
        projectDetectedUrlsSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal/urls')).json());
      expect((await read(local.instance)).gatewayPorts).toBeUndefined();
      vi.stubEnv('CEZ_REMOTE', '1');
      vi.stubEnv('CEZ_AUTH', '0');
      expect((await read(local.instance)).gatewayPorts).toEqual([9500, 9501]);
      // No pool, no gateway: nothing on the cockpit's hostname is one.
      const bare = await app({ previewGateways: new PreviewGateways({ ports: [] }) });
      expect((await read(bare.instance)).gatewayPorts).toBeUndefined();
    });

    it('offers the main checkout\'s scripts', async () => {
      put('package.json', JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } }));
      const { instance } = await app();
      const commands = discoveredCommandsSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal/commands')).json());
      expect(commands.commands.map((entry) => entry.command)).toEqual(['npm run dev', 'npm run test']);
    });

    it('keeps what was typed at the prompt, never what a running program read', async () => {
      const { instance } = await app();
      const session = terminalSessionSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal', send('POST', {}))).json());
      const type = (data: string) => apiRequest(instance, `/api/v1/repo/terminal/${session.id}/input`, send('POST', { data }));
      await type('sudo apt update\r');
      shellBusy = true;
      await type('hunter2\r');
      shellBusy = false;
      now = 5_000;
      await type('npm run dev\r');
      await history.flushed();
      const read = terminalHistorySchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal/history')).json());
      expect(read.lines).toEqual(['npm run dev', 'sudo apt update']);
      // The keystrokes still reached the shell, every one of them.
      expect(spawned[0]?.written).toEqual(['sudo apt update\r', 'hunter2\r', 'npm run dev\r']);
    });

    it('keeps nothing where the process table cannot be read, and still delivers every keystroke', async () => {
      const { instance } = await app();
      const session = terminalSessionSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal', send('POST', {}))).json());
      psUnreadable = true;
      const answer = await apiRequest(instance, `/api/v1/repo/terminal/${session.id}/input`, send('POST', { data: 'ls\r' }));
      expect(await answer.json()).toEqual({ delivered: true });
      await history.flushed();
      const read = terminalHistorySchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal/history')).json());
      expect(read.lines).toEqual([]);
      expect(spawned[0]?.written).toEqual(['ls\r']);
    });

    it('keeps a pasted command and never the password pasted after it', async () => {
      const { instance } = await app();
      const session = terminalSessionSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal', send('POST', {}))).json());
      await apiRequest(instance, `/api/v1/repo/terminal/${session.id}/input`, send('POST', { data: 'ssh host\rpassw0rd\r' }));
      await history.flushed();
      const read = terminalHistorySchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal/history')).json());
      expect(read.lines).toEqual(['ssh host']);
    });

    it('never lets a keystroke overtake the Enter whose prompt check is still running', async () => {
      const { instance } = await app();
      const session = terminalSessionSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal', send('POST', {}))).json());
      const type = (data: string) => apiRequest(instance, `/api/v1/repo/terminal/${session.id}/input`, send('POST', { data }));
      psDelayMs = 50;
      await Promise.all([type('ls\r'), type('c'), type('d')]);
      expect(spawned[0]?.written).toEqual(['ls\r', 'c', 'd']);
    });

    it('writes a keystroke at once, and keeps nothing whose prompt check outlived its timeout', async () => {
      const { instance } = await app();
      const session = terminalSessionSchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal', send('POST', {}))).json());
      const type = (data: string) => apiRequest(instance, `/api/v1/repo/terminal/${session.id}/input`, send('POST', { data }));
      psDelayMs = 1_000;
      const typing = type('ls\r');
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The process table is still being read; the shell has the line anyway.
      expect(spawned[0]?.written).toEqual(['ls\r']);
      await typing;
      const started = Date.now();
      await history.flushed();
      expect(Date.now() - started).toBeLessThan(900);
      const read = terminalHistorySchema.parse(await (await apiRequest(instance, '/api/v1/repo/terminal/history')).json());
      expect(read.lines).toEqual([]);
    });

    it('refuses the history where the terminal is off', async () => {
      vi.stubEnv('CEZ_TERMINAL', '0');
      const { instance } = await app();
      expect((await apiRequest(instance, '/api/v1/repo/terminal/history')).status).toBe(409);
    });
  });
});
