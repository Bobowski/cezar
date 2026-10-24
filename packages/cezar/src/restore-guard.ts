import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { restoreMarkerPath } from './paths.ts';

/**
 * The first boot after a restore removes nothing it calls an orphan (spec
 * `2026-10-23-backup-restore.md` §10): a worktree, layout or lifecycle record the restored index
 * does not know may be work this machine made after the backup. That boot only lists them.
 */

let suspended = false;

/** Written once a restore has placed its files; best-effort — a read-only home just loses it. */
export function writeRestoreMarker(info: { archive?: string } = {}): void {
  try {
    writeFileSync(restoreMarkerPath(), `${JSON.stringify({ restoredAt: new Date().toISOString(), ...info })}\n`, { mode: 0o600 });
  } catch {
    /* the merge alone still keeps every known task */
  }
}

/** A marker that cannot be removed is renamed aside, and one that cannot be either is only logged: never a failed boot. */
function retireMarker(log: (line: string) => void): void {
  const path = restoreMarkerPath();
  try {
    rmSync(path, { force: true });
    return;
  } catch (error) {
    try {
      renameSync(path, `${path}.consumed`);
      return;
    } catch {
      log(`  could not remove ${path} (${error instanceof Error ? error.message : String(error)}); the next boot will list orphans instead of pruning them too`);
    }
  }
}

/** Boot: a marker suspends orphan pruning for this whole process, and is removed so the next boot is ordinary. */
export function consumeRestoreMarker(log: (line: string) => void = console.log): boolean {
  let raw: string;
  try {
    raw = readFileSync(restoreMarkerPath(), 'utf8');
  } catch {
    return false;
  }
  suspended = true;
  retireMarker(log);
  let at = '';
  try {
    at = String((JSON.parse(raw) as { restoredAt?: unknown }).restoredAt ?? '');
  } catch {
    /* a marker is a marker, whatever it holds */
  }
  log(`  first boot after a restore${at ? ` (${at})` : ''}: orphaned worktrees are listed, not removed`);
  return true;
}

/** The restoring process itself suspends too: anything it builds before it restarts must not prune. */
export function suspendOrphanPrune(): void {
  suspended = true;
}

export function orphanPruneSuspended(): boolean {
  return suspended;
}

export function resetRestoreGuardForTests(): void {
  suspended = false;
}
