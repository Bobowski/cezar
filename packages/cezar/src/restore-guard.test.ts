import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreMarkerPath } from './paths.ts';
import { consumeRestoreMarker, orphanPruneSuspended, resetRestoreGuardForTests } from './restore-guard.ts';

const failing = vi.hoisted(() => ({ rm: false, rename: false }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (failing.rm) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return actual.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (failing.rename) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return actual.renameSync(...args);
    },
  };
});

/** A marker that will not go away never fails the boot that consumes it (review round 4). */
describe('consumeRestoreMarker when the marker cannot be removed', () => {
  let home: string;
  const saved = process.env.CEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-restore-guard-'));
    process.env.CEZ_HOME = home;
    writeFileSync(restoreMarkerPath(), '{"restoredAt":"2026-01-01T00:00:00.000Z"}\n');
    resetRestoreGuardForTests();
  });

  afterEach(() => {
    failing.rm = false;
    failing.rename = false;
    resetRestoreGuardForTests();
    if (saved === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('renames it aside, so the next boot is ordinary', () => {
    failing.rm = true;
    expect(consumeRestoreMarker(() => {})).toBe(true);
    expect(orphanPruneSuspended()).toBe(true);
    expect(existsSync(restoreMarkerPath())).toBe(false);
    expect(readFileSync(`${restoreMarkerPath()}.consumed`, 'utf8')).toContain('restoredAt');
  });

  it('logs and carries on when it cannot be renamed either', () => {
    failing.rm = true;
    failing.rename = true;
    const lines: string[] = [];
    expect(consumeRestoreMarker((line) => lines.push(line))).toBe(true);
    expect(orphanPruneSuspended()).toBe(true);
    expect(lines.join('\n')).toMatch(/could not remove .*EPERM/);
  });
});
