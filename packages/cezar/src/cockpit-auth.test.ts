import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHostKey, readHostKey } from './auth/host-key.ts';
import { takeServerFlags, withCockpitAuth } from './cockpit-address.ts';

describe('withCockpitAuth', () => {
  let home: string;
  const calls: Array<[unknown, RequestInit | undefined]> = [];
  const io = { fetch: (async (input: unknown, init?: RequestInit) => { calls.push([input, init]); return new Response('{}'); }) as typeof fetch };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-cockpitauth-'));
    process.env.CEZ_HOME = home;
    calls.length = 0;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('leaves requests untouched when there is no credential — a cockpit without auth sees no change', async () => {
    expect(withCockpitAuth(io, {})).toBe(io);
  });

  it('sends a task’s own token, keeping the headers the caller set', async () => {
    await withCockpitAuth(io, { CEZ_API_TOKEN: 'cezrun_abc', CEZ_TASK_ID: 'r1' })
      .fetch('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' } });
    const headers = new Headers(calls[0]![1]!.headers);
    expect(headers.get('authorization')).toBe('Bearer cezrun_abc');
    expect(headers.get('content-type')).toBe('application/json');
    expect(calls[0]![1]!.method).toBe('POST');
  });

  it('gives a person at a shell the host key, and never hands it to a task', async () => {
    ensureHostKey();
    await withCockpitAuth(io, {}).fetch('http://x/api');
    expect(new Headers(calls[0]![1]!.headers).get('authorization')).toBe(`Bearer ${readHostKey()}`);
    expect(withCockpitAuth(io, { CEZ_TASK_ID: 'r1' })).toBe(io);
  });

  it('never carries the host key to another machine — `--server https://elsewhere` needs a token', async () => {
    ensureHostKey();
    expect(withCockpitAuth(io, { CEZ_API_URL: 'https://agents.example.dev' })).toBe(io);
    expect(withCockpitAuth(io, { CEZ_API_URL: 'http://127.0.0.1:4321' })).not.toBe(io);
    expect(withCockpitAuth(io, { CEZ_API_URL: 'http://localhost:4321' })).not.toBe(io);
    await withCockpitAuth(io, { CEZ_API_URL: 'https://agents.example.dev', CEZ_API_TOKEN: 'ceztok_x' }).fetch('https://agents.example.dev/api');
    expect(new Headers(calls[0]![1]!.headers).get('authorization')).toBe('Bearer ceztok_x');
  });
});

describe('cez --server / --token', () => {
  it('takes both flags anywhere on the line, in either spelling, into the CLI address variables', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(takeServerFlags(['--server', 'https://a.dev', 'task', 'create', 'x', '--token=ceztok_1'], env)).toEqual(['task', 'create', 'x']);
    expect(env).toMatchObject({ CEZ_API_URL: 'https://a.dev', CEZ_API_TOKEN: 'ceztok_1' });
  });

  it('beats a task’s own address; CEZ_SERVER / CEZ_TOKEN only fill what is unset', () => {
    const flagged: NodeJS.ProcessEnv = { CEZ_API_URL: 'http://127.0.0.1:4321' };
    takeServerFlags(['--server=https://b.dev'], flagged);
    expect(flagged.CEZ_API_URL).toBe('https://b.dev');
    const task: NodeJS.ProcessEnv = { CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_API_TOKEN: 'cezrun_1', CEZ_SERVER: 'https://c.dev', CEZ_TOKEN: 'ceztok_2' };
    takeServerFlags([], task);
    expect(task).toMatchObject({ CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_API_TOKEN: 'cezrun_1' });
    const shell: NodeJS.ProcessEnv = { CEZ_SERVER: 'https://c.dev', CEZ_TOKEN: 'ceztok_2' };
    takeServerFlags([], shell);
    expect(shell).toMatchObject({ CEZ_API_URL: 'https://c.dev', CEZ_API_TOKEN: 'ceztok_2' });
  });

  it('refuses a flag without a value', () => {
    expect(() => takeServerFlags(['task', '--server'], {})).toThrow(/--server needs a value/);
  });
});
