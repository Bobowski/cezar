/**
 * `<CEZ_HOME>/rollback.json` — written by the container's supervisor loop (docker/supervise.sh)
 * when a freshly activated version exits within 30 s and `previous` is relinked (spec
 * 2026-10-23 §4.3). The status reports it until the next successful apply, which removes it.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { selfUpdateRollbackSchema, type SelfUpdateRollback } from '@open-mercato/cezar-contract';

import { cezarHomeDir } from '../paths.ts';

export function rollbackFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'rollback.json');
}

export function readRollback(env: NodeJS.ProcessEnv = process.env): SelfUpdateRollback | null {
  try {
    const parsed = selfUpdateRollbackSchema.safeParse(JSON.parse(readFileSync(rollbackFile(env), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearRollback(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(rollbackFile(env), { force: true });
}
