import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAuthCommand } from './cli.ts';
import { readAuthStore, sha256 } from './store.ts';

describe('cezar auth', () => {
  let home: string;
  let out: string[];
  let err: string[];
  const io = { log: (line: string) => out.push(line), error: (line: string) => err.push(line) };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-authcli-'));
    process.env.CEZ_HOME = home;
    out = [];
    err = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('setup prints a one-time link whose code is stored only as a hash', async () => {
    expect(await runAuthCommand(['setup', '--url', 'https://agents.example.dev/'], io)).toBe(0);
    const link = out.join('\n').match(/https:\/\/agents\.example\.dev\/setup#code=(\S+)/);
    expect(link).not.toBeNull(); // the code rides in the fragment, out of any access log
    const setup = readAuthStore().setup!;
    expect(setup.codeHash).toBe(sha256(link![1]!));
    expect(JSON.stringify(readAuthStore())).not.toContain(link![1]!);
  });

  it('says what to do when there is no address to print, or no such user', async () => {
    expect(await runAuthCommand(['setup'], io)).toBe(0);
    expect(out.join('\n')).toContain('<your cockpit address>/setup#code=');
    expect(await runAuthCommand(['reset', 'nobody'], io)).toBe(1);
    expect(await runAuthCommand(['reset'], io)).toBe(2);
    expect(await runAuthCommand(['frobnicate'], io)).toBe(2);
    expect(err.join('\n')).toContain('no user named "nobody"');
  });

  it('status reports an empty store without creating one', async () => {
    expect(await runAuthCommand(['status'], io)).toBe(0);
    expect(out.join('\n')).toContain('No account yet');
  });
});
