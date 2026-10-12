import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AUTH_USERNAME_RE, authRoleSchema } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, authAuditPath, authSessionsPath, authStorePath } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * `~/.cezar/auth.json` and its siblings (spec `2026-10-12-cockpit-authentication.md` §5.5).
 *
 * The `agent-accounts.json` house rules, with ONE deliberate difference: an unreadable file is
 * treated as "no account", which under enforced auth means "setup required" — it fails CLOSED,
 * never to an open cockpit. The corrupt file is kept beside it as `auth.json.corrupt`.
 *
 * Reads are synchronous and cached on `mtime+size`: the CLI (`cezar auth reset`) writes this file
 * from another process, and the guard must see that on the very next request.
 */

const SETUP_TTL_MS = 15 * 60_000;
/** The audit log rotates to one `.1` here, so a caller who can append for free cannot fill the disk. */
const AUDIT_MAX_BYTES = 4 * 1024 * 1024;

const userSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().regex(AUTH_USERNAME_RE),
    role: authRoleSchema.catch('owner'),
    /** Bumped by a reset, a password change and "sign out other devices"; a session minted under
     *  an older epoch is dead, in every cockpit that shares this file. */
    epoch: z.number().int().min(0).catch(0),
    /** Absent after `cezar auth reset`, until setup is completed again. */
    password: z.string().max(512).optional().catch(undefined),
    totp: z
      .object({ secret: z.string().min(16).max(128), lastStep: z.number().int().catch(-1) })
      .passthrough()
      .optional()
      .catch(undefined),
    /** SHA-256 of each unused recovery code. */
    recovery: z.array(z.string().max(128)).catch(() => []),
    createdAt: z.string().max(64).catch(''),
  })
  .passthrough();
export type StoredUser = z.infer<typeof userSchema>;

const setupSchema = z
  .object({
    codeHash: z.string().min(1).max(128),
    expiresAt: z.number(),
    /** Set by a reset: setup re-credentials THIS user instead of creating one. */
    userId: z.string().max(64).optional().catch(undefined),
  })
  .passthrough();

const storeSchema = z
  .object({
    version: z.number().int().min(0).default(1).catch(1),
    users: z
      .array(z.unknown())
      .default(() => [])
      .catch(() => [])
      .transform((entries) => {
        const seen = new Set<string>();
        return entries.flatMap((entry) => {
          const parsed = userSchema.safeParse(entry);
          if (!parsed.success || seen.has(parsed.data.id) || seen.has(`n:${parsed.data.name}`)) return [];
          seen.add(parsed.data.id);
          seen.add(`n:${parsed.data.name}`);
          return [parsed.data];
        });
      }),
    setup: setupSchema.optional().catch(undefined),
  })
  .passthrough();
export type AuthStore = z.infer<typeof storeSchema>;

const sessionSchema = z
  .object({
    id: z.string().min(1).max(64),
    tokenHash: z.string().min(1).max(128),
    userId: z.string().min(1).max(64),
    epoch: z.number().int().min(0),
    label: z.string().max(200).catch(''),
    createdAt: z.number(),
    lastSeenAt: z.number(),
  })
  .passthrough();
export type StoredSession = z.infer<typeof sessionSchema>;

const sessionsSchema = z
  .object({
    sessions: z
      .array(z.unknown())
      .default(() => [])
      .catch(() => [])
      .transform((entries) => entries.flatMap((entry) => {
        const parsed = sessionSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })),
  })
  .passthrough();

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Constant-time compare of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A user that can actually sign in. A reset leaves the row and removes the credentials. */
export function hasCredentials(user: StoredUser): boolean {
  return Boolean(user.password && user.totp);
}

const emptyStore = (): AuthStore => storeSchema.parse({});

let cached: { path: string; stamp: string; store: AuthStore } | undefined;
let warned = false;

function stampOf(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** The store as it is on disk right now. Missing or unreadable → empty (see the header). */
export function readAuthStore(path: string = authStorePath()): AuthStore {
  const stamp = stampOf(path);
  if (stamp === null) return emptyStore();
  if (cached && cached.path === path && cached.stamp === stamp) return cached.store;
  let store: AuthStore;
  try {
    store = storeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(`[cez] ${path} is unreadable (${(error as Error).message}) — treating it as no account; run \`cezar auth setup\` on this host`);
    }
    return emptyStore();
  }
  cached = { path, stamp, store };
  return store;
}

/**
 * Read-modify-write, synchronous so two requests in one process cannot interleave. The mutator
 * always sees what is on disk, so a CLI write between two server writes is not lost.
 */
export function mutateAuthStore<T>(mutator: (store: AuthStore) => T, path: string = authStorePath()): T {
  assertCezarHomeWriteIsSandboxed(path);
  let store: AuthStore;
  let salvaged = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    store = storeSchema.parse(raw);
    const rows = (raw as { users?: unknown } | null)?.users;
    salvaged = Array.isArray(rows) && rows.length !== store.users.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { copyFileSync(path, `${path}.corrupt`); } catch { /* best effort */ }
    }
    store = emptyStore();
  }
  const before = JSON.stringify(store);
  const result = mutator(store);
  // A rejected code changes nothing: do not rewrite the file (or widen the unlocked
  // read-to-rename window another process can lose a write in) for it.
  if (JSON.stringify(store) === before) return result;
  if (salvaged) {
    // This write drops the rows that did not parse; keep what they were.
    try { copyFileSync(path, `${path}.corrupt`); } catch { /* best effort */ }
  }
  atomicWriteJsonSync(path, store);
  cached = undefined;
  return result;
}

export interface IssuedSetup {
  code: string;
  expiresAt: number;
}

export type IssueSetupResult =
  | { ok: true; setup: IssuedSetup }
  | { ok: false; reason: 'owner-exists' | 'unknown-user' };

/**
 * Mint the one-time setup code (§5.1). With no `resetUser`, only when no account can sign in yet.
 * With one, strip that user's credentials and bump the epoch — every session they held dies with
 * the next request, without the server being told.
 */
export function issueSetupCode(
  options: { resetUser?: string; now?: number; path?: string } = {},
): IssueSetupResult {
  const now = options.now ?? Date.now();
  return mutateAuthStore((store): IssueSetupResult => {
    let userId: string | undefined;
    if (options.resetUser !== undefined) {
      const user = store.users.find((entry) => entry.name === options.resetUser);
      if (!user) return { ok: false, reason: 'unknown-user' };
      user.password = undefined;
      user.totp = undefined;
      user.recovery = [];
      user.epoch += 1;
      userId = user.id;
    } else if (store.users.some(hasCredentials)) {
      return { ok: false, reason: 'owner-exists' };
    } else {
      // A reset that was never completed stays bound to its user.
      userId = store.users[0]?.id;
    }
    const code = randomToken();
    const expiresAt = now + SETUP_TTL_MS;
    store.setup = { codeHash: sha256(code), expiresAt, ...(userId ? { userId } : {}) };
    return { ok: true, setup: { code, expiresAt } };
  }, options.path);
}

export function newUserId(): string {
  return randomUUID();
}

export function readSessions(path: string = authSessionsPath()): StoredSession[] {
  try {
    return sessionsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).sessions;
  } catch {
    return [];
  }
}

export function writeSessions(sessions: StoredSession[], path: string = authSessionsPath()): void {
  assertCezarHomeWriteIsSandboxed(path);
  atomicWriteJsonSync(path, { version: 1, sessions });
}

export interface AuditEntry {
  event: string;
  user?: string;
  session?: string;
  address?: string;
  detail?: string;
}

/** Append-only and best-effort: an unwritable home must not turn a login into a 500. */
export function appendAudit(entry: AuditEntry, now: number = Date.now(), path: string = authAuditPath()): void {
  try {
    assertCezarHomeWriteIsSandboxed(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size >= AUDIT_MAX_BYTES) {
        chmodSync(path, 0o600);
        renameSync(path, `${path}.1`);
      }
    } catch { /* no log yet, or it could not be rotated: append anyway */ }
    appendFileSync(path, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // non-fatal
  }
}
