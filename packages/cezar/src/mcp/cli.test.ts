import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHostKey, readHostKey } from '../auth/host-key.ts';
import { bridgeTarget, runMcpCommand } from './cli.ts';
import { sseMessages } from './stdio.ts';

describe('cezar mcp', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mcp-cli-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('defaults to the local cockpit with this host\'s key, and carries --tools as ?tools=', () => {
    ensureHostKey();
    expect(bridgeTarget({}, 'tasks,repo')).toEqual({
      endpoint: 'http://127.0.0.1:4321/api/v1/mcp?tools=tasks%2Crepo',
      credential: readHostKey(),
    });
  });

  it('a remote cockpit gets the token it was given, never the host key', () => {
    ensureHostKey();
    expect(bridgeTarget({ CEZ_API_URL: 'https://agents.example.dev/' }, undefined)).toEqual({ endpoint: 'https://agents.example.dev/api/v1/mcp' });
    expect(bridgeTarget({ CEZ_API_URL: 'https://agents.example.dev', CEZ_API_TOKEN: 'ceztok_x' }, undefined)).toMatchObject({ credential: 'ceztok_x' });
  });

  it('inside a task, never guesses an address the cockpit did not give', async () => {
    const errors: string[] = [];
    const code = await runMcpCommand([], { CEZ_TASK_ID: 'r1' }, { stdin: new PassThrough(), stdout: new PassThrough(), fetch, error: (line) => errors.push(line) });
    expect(code).toBe(2);
    expect(errors[0]).toContain('CEZ_API_URL is not set');
  });

  it('refuses an unknown flag with the usage', async () => {
    const errors: string[] = [];
    expect(await runMcpCommand(['--nope'], {}, { stdin: new PassThrough(), stdout: new PassThrough(), fetch, error: (line) => errors.push(line) })).toBe(2);
    expect(errors[0]).toContain('cezar mcp —');
  });

  it('reads an SSE answer as its JSON-RPC messages, skipping keepalives', () => {
    expect(sseMessages(': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });
});
