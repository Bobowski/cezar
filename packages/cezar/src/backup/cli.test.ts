import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStateLocations } from '../paths.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { TEST_IDENTITY, TEST_RECIPIENT } from './age-vector.testkit.ts';
import { runBackupCommand } from './cli.ts';
import { BackupService } from './service.ts';

describe('cezar backup', () => {
  let dir: string;
  let saved: string | undefined;
  const lines: string[] = [];
  const errors: string[] = [];
  const none = (base: string): AgentStateLocations => ({
    claude: join(base, 'c'), claudeState: null, codex: join(base, 'x'), gh: join(base, 'g'), ssh: join(base, 's'), gitconfig: join(base, 'gc'),
  });
  const io = (secret = '') => ({ log: (line: string) => lines.push(line), error: (line: string) => errors.push(line), secret: async () => secret });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-backup-cli-'));
    saved = process.env.CEZ_HOME;
    process.env.CEZ_HOME = join(dir, 'home');
    lines.length = 0;
    errors.length = 0;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved;
    await removeTempDir(dir);
  });

  it('creates, copies out, lists and restores', async () => {
    const service = new BackupService({ version: 't', projects: async () => [], locations: () => none(dir), hostname: 'box' });
    expect(await runBackupCommand(['create'], { version: 't', service, io: io() })).toBe(1);
    expect(errors.join('\n')).toMatch(/encrypted to first/);

    service.setRecipient({ recipient: TEST_RECIPIENT });
    const out = join(dir, 'copy.age');
    expect(await runBackupCommand(['create', '--out', out], { version: 't', service, io: io() })).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(await runBackupCommand(['list'], { version: 't', service, io: io() })).toBe(0);
    expect(lines.some((line) => /cezar-backup-box-\d{8}T\d{4}Z/.test(line))).toBe(true);

    process.env.CEZ_HOME = join(dir, 'fresh');
    const fresh = new BackupService({ version: 't', projects: async () => [], locations: () => none(join(dir, 'fresh-agents')) });
    expect(await runBackupCommand(['restore', out], { version: 't', service: fresh, io: io(`${TEST_IDENTITY}\n`) })).toBe(0);
    expect(existsSync(join(dir, 'fresh', 'backup.json'))).toBe(true);
    expect(await runBackupCommand(['restore', join(dir, 'missing.age')], { version: 't', service: fresh, io: io() })).toBe(2);
  }, 30_000);
});
