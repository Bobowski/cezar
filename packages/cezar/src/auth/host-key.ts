import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, authHostKeyPath } from '../paths.ts';
import { randomToken, sameHash, sha256 } from './store.ts';

/**
 * The credential a shell on this host shows its own cockpit — `cezar runs list` under enforced
 * auth (spec `2026-10-12-cockpit-authentication.md` §7). A `0600` file: whoever can read it is
 * already the OS user cezar runs as, which is the trust boundary that spec names.
 */
const PREFIX = 'cezhost_';

export function isHostKey(token: string): boolean {
  return token.startsWith(PREFIX);
}

/** Undefined when there is none or it cannot be read — the caller then sends no credential. */
export function readHostKey(path: string = authHostKeyPath()): string | undefined {
  try {
    const key = readFileSync(path, 'utf8').trim();
    return key.startsWith(PREFIX) && key.length > PREFIX.length + 20 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** True when a file is there that can never be a key: too short, or not ours to read. */
function invalidKeyFile(path: string): boolean {
  try {
    readFileSync(path, 'utf8');
    return readHostKey(path) === undefined;
  } catch (error) {
    // Only "permission denied" — a transient read error must not cost a valid key.
    return (error as NodeJS.ErrnoException).code === 'EACCES';
  }
}

/** Create the key if it is not there. Best-effort: a read-only home just has no host CLI access. */
export function ensureHostKey(path: string = authHostKeyPath()): void {
  if (readHostKey(path)) return;
  const key = `${PREFIX}${randomToken()}\n`;
  try {
    assertCezarHomeWriteIsSandboxed(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (invalidKeyFile(path)) {
      // `wx` would fail on it for ever (state may be written, never repaired by hand): replace it.
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
        if (!readHostKey(path)) renameSync(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
      return;
    }
    writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  } catch {
    // Lost a race with another cockpit on this host, or the home is read-only.
  }
}

let cached: { path: string; stamp: string; hash: string } | undefined;

export function verifyHostKey(token: string, path: string = authHostKeyPath()): boolean {
  if (!isHostKey(token)) return false;
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return false;
  }
  if (!cached || cached.path !== path || cached.stamp !== stamp) {
    const key = readHostKey(path);
    if (!key) return false;
    cached = { path, stamp, hash: sha256(key) };
  }
  return sameHash(cached.hash, sha256(token));
}
