import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHostKey, readHostKey } from './auth/host-key.ts';
import { withCockpitAuth } from './cockpit-address.ts';

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
});
