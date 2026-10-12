import { randomBytes } from 'node:crypto';
import type { AuthDevice, AuthUser } from '@open-mercato/cezar-contract';
import { authSessionsPath, authStorePath } from '../paths.ts';
import { DEFAULT_SCRYPT, hashPassword, verifyPassword, type ScryptParams } from './password.ts';
import {
  appendAudit,
  hasCredentials,
  mutateAuthStore,
  newUserId,
  randomToken,
  readAuthStore,
  readSessions,
  sameHash,
  sha256,
  writeSessions,
  type StoredSession,
  type StoredUser,
} from './store.ts';
import { LoginThrottle, throttleAddress } from './throttle.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

/**
 * Accounts, the two-step login and sessions (spec `2026-10-12-cockpit-authentication.md` §5).
 * Knows nothing about HTTP: the routes own cookies and status codes, the guard owns "who may call
 * what". Every failure is a value, never a throw, so a route cannot forget to catch one.
 */

const IDLE_MS = 7 * 24 * 60 * 60_000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
const TICKET_MS = 5 * 60_000;
const ENROLMENT_MS = 15 * 60_000;
const TICKET_ATTEMPTS = 5;
const RECOVERY_CODES = 10;
/** `lastSeenAt` reaches disk at most this often — it is a display value, not a security one. */
const TOUCH_PERSIST_MS = 5 * 60_000;
const MAX_PENDING = 1_000;
/** Concurrent scrypt verifications: each holds ~128 MB. */
const SCRYPT_SLOTS = 2;
/** Verifications allowed to WAIT for a slot; past it a caller is told to retry, not queued (§5.4). */
const SCRYPT_WAITERS = 8;
const BUSY = Symbol('busy');
/** What an unknown username is verified against, so it costs the same as a real one. */
const DECOY_PASSWORD = 'cezar-decoy-password';

export type AuthFailure = { ok: false; status: 400 | 401 | 409 | 429; error: string; retryAfterSec?: number };
export type AuthResult<T> = ({ ok: true } & T) | AuthFailure;

export interface RequestMeta {
  /** The client address, for throttling and the audit log. */
  address: string;
  /** A human label for the device list, derived from the user agent. */
  label: string;
}

export interface AuthenticatedSession {
  user: AuthUser;
  sessionId: string;
}

export interface AuthServiceOptions {
  storePath?: string;
  sessionsPath?: string;
  scrypt?: ScryptParams;
  now?: () => number;
}

interface LoginTicket {
  userId: string;
  epoch: number;
  expiresAt: number;
  attempts: number;
}

interface Enrolment {
  codeHash: string;
  name: string;
  password: string;
  secret: string;
  expiresAt: number;
  attempts: number;
}

const fail = (status: AuthFailure['status'], error: string, retryAfterSec?: number): AuthFailure => ({
  ok: false,
  status,
  error,
  ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
});

const tooMany = (waitMs: number): AuthFailure =>
  fail(429, 'too many attempts — try again later', Math.ceil(waitMs / 1000));
const busy = (): AuthFailure => fail(429, 'the cockpit is busy — try again in a moment', 2);
const addressKey = (meta: RequestMeta): string => `ip:${throttleAddress(meta.address)}`;

const publicUser = (user: StoredUser): AuthUser => ({ id: user.id, name: user.name, role: user.role });

/** `ab3de-fgh2k` — 50 bits, in an alphabet with no look-alikes. */
function newRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]!);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

const normalizeRecovery = (code: string): string => code.trim().toLowerCase().replace(/\s+/g, '');

export class AuthService {
  private readonly storePath: string | undefined;
  private readonly sessionsPath: string | undefined;
  private readonly scrypt: ScryptParams;
  private readonly now: () => number;
  private readonly throttle = new LoginThrottle();
  private readonly tickets = new Map<string, LoginTicket>();
  private readonly enrolments = new Map<string, Enrolment>();
  private sessions: Map<string, StoredSession> | undefined;
  private sessionsLoadedFrom: string | undefined;
  private persistedTouch = new Map<string, number>();
  private decoy: Promise<string> | undefined;
  private scryptInFlight = 0;
  private readonly scryptWaiters: Array<() => void> = [];

  constructor(options: AuthServiceOptions = {}) {
    this.storePath = options.storePath;
    this.sessionsPath = options.sessionsPath;
    this.scrypt = options.scrypt ?? DEFAULT_SCRYPT;
    this.now = options.now ?? Date.now;
  }

  // Paths are resolved per call, not captured: `CEZ_HOME` is the test seam for every other file
  // under `~/.cezar`, and a path frozen at construction would outlive the pin.
  private store() {
    return readAuthStore(this.storePath ?? authStorePath());
  }

  private mutate<T>(mutator: Parameters<typeof mutateAuthStore<T>>[0]): T {
    return mutateAuthStore(mutator, this.storePath ?? authStorePath());
  }

  private sessionMap(): Map<string, StoredSession> {
    const path = this.sessionsPath ?? authSessionsPath();
    if (!this.sessions || this.sessionsLoadedFrom !== path) {
      this.sessions = new Map(readSessions(path).map((session) => [session.tokenHash, session]));
      this.sessionsLoadedFrom = path;
      this.persistedTouch = new Map([...this.sessions.values()].map((session) => [session.id, session.lastSeenAt]));
    }
    return this.sessions;
  }

  private persistSessions(): void {
    const sessions = [...this.sessionMap().values()];
    try {
      writeSessions(sessions, this.sessionsPath ?? authSessionsPath());
      this.persistedTouch = new Map(sessions.map((session) => [session.id, session.lastSeenAt]));
    } catch (error) {
      // A read-only home keeps sessions in memory: they work until the restart.
      console.warn(`[cez] could not persist sessions (${(error as Error).message})`);
    }
  }

  /** `BUSY` instead of an unbounded queue; `mustRun` is for a caller already past both factors. */
  private async withScryptSlot<T>(work: () => Promise<T>, mustRun = false): Promise<T | typeof BUSY> {
    if (this.scryptInFlight >= SCRYPT_SLOTS) {
      if (!mustRun && this.scryptWaiters.length >= SCRYPT_WAITERS) return BUSY;
      await new Promise<void>((resolve) => this.scryptWaiters.push(resolve));
    }
    this.scryptInFlight += 1;
    try {
      return await work();
    } finally {
      this.scryptInFlight -= 1;
      this.scryptWaiters.shift()?.();
    }
  }

  private expiresAt(session: StoredSession): number {
    return Math.min(session.lastSeenAt + IDLE_MS, session.createdAt + ABSOLUTE_MS);
  }

  private prune<T extends { expiresAt: number }>(map: Map<string, T>): void {
    const now = this.now();
    for (const [key, value] of map) {
      if (value.expiresAt <= now || map.size > MAX_PENDING) map.delete(key);
    }
  }

  /** True until an account that can sign in exists. Under enforced auth only setup is served. */
  setupRequired(): boolean {
    return !this.store().users.some(hasCredentials);
  }

  // ---- setup ---------------------------------------------------------------

  private validSetup(codeHash: string): { userId?: string } | null {
    const setup = this.store().setup;
    if (!setup || setup.expiresAt <= this.now() || !sameHash(setup.codeHash, codeHash)) return null;
    return { ...(setup.userId ? { userId: setup.userId } : {}) };
  }

  async beginSetup(
    input: { code: string; username: string; password: string },
    meta: RequestMeta,
  ): Promise<AuthResult<{ ticket: string; secret: string; otpauthUri: string }>> {
    // Per address only: a global key would let anyone lock the owner out of their own setup.
    // Its own kind of key: these failures are free to make and must not evict login's (§5.4).
    const keys = [`setup:${throttleAddress(meta.address)}`];
    const wait = this.throttle.retryAfter(keys, this.now());
    if (wait > 0) return tooMany(wait);
    const codeHash = sha256(input.code.trim());
    const setup = this.validSetup(codeHash);
    if (!setup) {
      this.throttle.fail(keys, this.now());
      appendAudit({ event: 'setup-rejected', address: meta.address }, this.now());
      return fail(401, 'this setup link is invalid or has expired — run `cezar auth setup` on the host for a new one');
    }
    const taken = this.store().users.find((user) => user.name === input.username && user.id !== setup.userId);
    if (taken) return fail(409, 'that username is taken');
    const password = await this.withScryptSlot(() => hashPassword(input.password, this.scrypt));
    if (password === BUSY) return busy();
    const secret = generateTotpSecret();
    const ticket = randomToken();
    this.prune(this.enrolments);
    this.enrolments.set(sha256(ticket), {
      codeHash,
      name: input.username,
      password,
      secret,
      expiresAt: this.now() + ENROLMENT_MS,
      attempts: 0,
    });
    return { ok: true, ticket, secret, otpauthUri: otpauthUri(input.username, secret) };
  }

  /** Proves the authenticator works, THEN spends the setup code and writes the account. */
  completeSetup(
    input: { ticket: string; code: string },
    meta: RequestMeta,
  ): AuthResult<{ user: AuthUser; recoveryCodes: string[]; token: string }> {
    const key = sha256(input.ticket);
    const enrolment = this.enrolments.get(key);
    if (!enrolment || enrolment.expiresAt <= this.now()) {
      this.enrolments.delete(key);
      return fail(401, 'setup expired — start again');
    }
    const step = verifyTotp(enrolment.secret, input.code, this.now());
    if (step === null) {
      enrolment.attempts += 1;
      if (enrolment.attempts >= TICKET_ATTEMPTS) this.enrolments.delete(key);
      return fail(401, 'that code is not valid — check the time on your device and try the current code');
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    const now = this.now();
    const written = this.mutate((store): StoredUser | null => {
      // Re-checked under the write: the code may have been spent or replaced since `beginSetup`.
      const setup = store.setup;
      if (!setup || setup.expiresAt <= now || !sameHash(setup.codeHash, enrolment.codeHash)) return null;
      const existing = setup.userId ? store.users.find((user) => user.id === setup.userId) : undefined;
      if (store.users.some((user) => user.name === enrolment.name && user !== existing)) return null;
      const credentials = {
        name: enrolment.name,
        password: enrolment.password,
        totp: { secret: enrolment.secret, lastStep: step },
        recovery: recoveryCodes.map((code) => sha256(code)),
      };
      let user: StoredUser;
      if (existing) {
        Object.assign(existing, credentials);
        user = existing;
      } else {
        user = { id: newUserId(), role: 'owner', epoch: 0, createdAt: new Date(now).toISOString(), ...credentials };
        store.users.push(user);
      }
      store.setup = undefined;
      return user;
    });
    this.enrolments.delete(key);
    if (!written) return fail(401, 'this setup link is no longer valid — run `cezar auth setup` on the host for a new one');
    appendAudit({ event: 'setup', user: written.name, address: meta.address }, now);
    const token = this.createSession(written, meta);
    return { ok: true, user: publicUser(written), recoveryCodes, token };
  }

  // ---- login ---------------------------------------------------------------

  /** Step one: the password. Never says whether the username exists. */
  async login(input: { username: string; password: string }, meta: RequestMeta): Promise<AuthResult<{ ticket: string }>> {
    const name = input.username.trim().toLowerCase();
    const keys = [addressKey(meta), `user:${name}`];
    // Reserved BEFORE the scrypt await, or a parallel burst all passes the check (§5.4).
    const wait = this.throttle.reserve(keys, this.now());
    if (wait > 0) return tooMany(wait);
    let matches: boolean | typeof BUSY = BUSY;
    let user: StoredUser | undefined;
    try {
      user = this.store().users.find((entry) => entry.name === name && hasCredentials(entry));
      const stored = user?.password ?? (await (this.decoy ??= hashPassword(DECOY_PASSWORD, this.scrypt)));
      matches = await this.withScryptSlot(() => verifyPassword(input.password, stored));
    } finally {
      this.throttle.settle(keys, this.now(), matches !== BUSY && !(user && matches));
    }
    if (matches === BUSY) return busy();
    if (!user || !matches) {
      appendAudit({ event: 'login-failed', user: name, address: meta.address, detail: 'password' }, this.now());
      return fail(401, 'wrong username or password');
    }
    const ticket = randomToken();
    this.prune(this.tickets);
    this.tickets.set(sha256(ticket), { userId: user.id, epoch: user.epoch, expiresAt: this.now() + TICKET_MS, attempts: 0 });
    return { ok: true, ticket };
  }

  /** Step two: a TOTP code or a recovery code. Only this issues a session. */
  verifyLogin(input: { ticket: string; code: string }, meta: RequestMeta): AuthResult<{ user: AuthUser; token: string }> {
    const key = sha256(input.ticket);
    const ticket = this.tickets.get(key);
    if (!ticket || ticket.expiresAt <= this.now()) {
      this.tickets.delete(key);
      return fail(401, 'sign-in expired — enter your password again');
    }
    const now = this.now();
    const current = this.store().users.find((user) => user.id === ticket.userId);
    // `2fa:` not `user:` — only someone holding the password can fail here, so it keeps the long cap.
    const keys = [addressKey(meta), `2fa:${ticket.userId}`];
    const wait = this.throttle.retryAfter(keys, now);
    if (wait > 0) return tooMany(wait);
    const candidate = input.code.trim();
    const recoveryHash = sha256(normalizeRecovery(candidate));
    // Consumed under the write, against what is on disk: a code is accepted exactly once even if
    // two requests race, and a reset between the two steps voids the ticket.
    const accepted = this.mutate((store): { user: StoredUser; method: 'totp' | 'recovery' } | null => {
      const user = store.users.find((entry) => entry.id === ticket.userId);
      if (!user || user.epoch !== ticket.epoch || !user.totp || !user.password) return null;
      const step = verifyTotp(user.totp.secret, candidate, now, user.totp.lastStep);
      if (step !== null) {
        user.totp.lastStep = step;
        return { user, method: 'totp' };
      }
      const index = user.recovery.findIndex((hash) => sameHash(hash, recoveryHash));
      if (index === -1) return null;
      user.recovery.splice(index, 1);
      return { user, method: 'recovery' };
    });
    if (!accepted) {
      ticket.attempts += 1;
      if (ticket.attempts >= TICKET_ATTEMPTS) this.tickets.delete(key);
      this.throttle.fail(keys, now);
      appendAudit({ event: 'login-failed', user: current?.name, address: meta.address, detail: 'second-factor' }, now);
      return fail(401, 'that code is not valid');
    }
    this.tickets.delete(key);
    this.throttle.succeed(`user:${accepted.user.name}`);
    this.throttle.succeed(`2fa:${accepted.user.id}`);
    appendAudit({ event: 'login', user: accepted.user.name, address: meta.address, detail: accepted.method }, now);
    return { ok: true, user: publicUser(accepted.user), token: this.createSession(accepted.user, meta) };
  }

  // ---- sessions ------------------------------------------------------------

  private createSession(user: StoredUser, meta: RequestMeta): string {
    const token = randomToken();
    const now = this.now();
    const session: StoredSession = {
      id: randomToken(9),
      tokenHash: sha256(token),
      userId: user.id,
      epoch: user.epoch,
      label: meta.label.slice(0, 200),
      createdAt: now,
      lastSeenAt: now,
    };
    const sessions = this.sessionMap();
    for (const [hash, existing] of sessions) {
      if (this.expiresAt(existing) <= now) sessions.delete(hash);
    }
    sessions.set(session.tokenHash, session);
    this.persistSessions();
    return token;
  }

  /** The session a token names, or null. Slides the idle expiry. */
  authenticate(token: string | undefined): AuthenticatedSession | null {
    if (!token) return null;
    const sessions = this.sessionMap();
    const session = sessions.get(sha256(token));
    if (!session) return null;
    const now = this.now();
    const user = this.store().users.find((entry) => entry.id === session.userId);
    if (this.expiresAt(session) <= now || !user || !hasCredentials(user) || user.epoch !== session.epoch) {
      sessions.delete(session.tokenHash);
      this.persistSessions();
      return null;
    }
    session.lastSeenAt = now;
    if (now - (this.persistedTouch.get(session.id) ?? 0) >= TOUCH_PERSIST_MS) this.persistSessions();
    return { user: publicUser(user), sessionId: session.id };
  }

  /**
   * Whether a session id still stands, for a long-lived stream to re-check (§5.3). Read-only:
   * it neither slides the idle expiry nor writes, so polling cannot keep a session alive.
   */
  sessionAlive(sessionId: string): boolean {
    const session = [...this.sessionMap().values()].find((entry) => entry.id === sessionId);
    if (!session || this.expiresAt(session) <= this.now()) return false;
    const user = this.store().users.find((entry) => entry.id === session.userId);
    return Boolean(user && hasCredentials(user) && user.epoch === session.epoch);
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const sessions = this.sessionMap();
    const session = sessions.get(sha256(token));
    if (!session) return;
    sessions.delete(session.tokenHash);
    this.persistSessions();
    appendAudit({ event: 'logout', session: session.id }, this.now());
  }

  listSessions(userId: string, currentId: string | undefined): AuthDevice[] {
    const now = this.now();
    return [...this.sessionMap().values()]
      .filter((session) => session.userId === userId && this.expiresAt(session) > now)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((session) => ({
        id: session.id,
        label: session.label,
        createdAt: new Date(session.createdAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
        expiresAt: new Date(this.expiresAt(session)).toISOString(),
        current: session.id === currentId,
      }));
  }

  /** Sign every OTHER device out. Answers how many sessions that was. */
  revokeOtherSessions(userId: string, currentId: string): number {
    const sessions = this.sessionMap();
    // The epoch is the one thing a sibling cockpit sharing auth.json sees (§5.5): bumping it kills
    // this user's sessions in EVERY process, the way a reset does; this one is re-stamped.
    let epoch: number | undefined;
    try {
      epoch = this.mutate((store) => {
        const user = store.users.find((entry) => entry.id === userId);
        if (user) user.epoch += 1;
        return user?.epoch;
      });
    } catch (error) {
      console.warn(`[cez] could not sign other cockpits out (${(error as Error).message})`);
    }
    let revoked = 0;
    for (const [hash, session] of sessions) {
      if (session.userId !== userId) continue;
      if (session.id === currentId) {
        if (epoch !== undefined) session.epoch = epoch;
        continue;
      }
      sessions.delete(hash);
      revoked += 1;
    }
    if (epoch !== undefined || revoked > 0) this.persistSessions();
    if (revoked > 0) {
      appendAudit({ event: 'sessions-revoked', session: currentId, detail: String(revoked) }, this.now());
    }
    return revoked;
  }

  /**
   * A fresh authenticator code from a signed-in user (§5.3): what a sensitive change asks for, so
   * an unattended session cannot make it. Consumes the time step like a sign-in does.
   */
  /**
   * A signed-in change is keyed on the user id, never on the `user:<name>` key an anonymous
   * caller can fill: the owner must be able to change a password that is under attack (§5.4).
   */
  private signedInKeys(userId: string, meta: RequestMeta): string[] {
    return [addressKey(meta), `session:${userId}`];
  }

  private confirmSecondFactor(userId: string, code: string, meta: RequestMeta): AuthFailure | null {
    const name = this.store().users.find((user) => user.id === userId)?.name ?? userId;
    const keys = this.signedInKeys(userId, meta);
    const now = this.now();
    const wait = this.throttle.retryAfter(keys, now);
    if (wait > 0) return tooMany(wait);
    const accepted = this.mutate((store) => {
      const user = store.users.find((entry) => entry.id === userId);
      if (!user?.totp) return false;
      const step = verifyTotp(user.totp.secret, code, now, user.totp.lastStep);
      if (step === null) return false;
      user.totp.lastStep = step;
      return true;
    });
    if (accepted) {
      this.throttle.succeed(`session:${userId}`);
      return null;
    }
    this.throttle.fail(keys, now);
    appendAudit({ event: 'confirm-failed', user: name, address: meta.address }, now);
    return fail(401, 'that code is not valid — use the current code from your authenticator, not one you already used');
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    input: { currentPassword: string; code: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<AuthResult<{ revoked: number }>> {
    const user = this.store().users.find((entry) => entry.id === userId);
    if (!user?.password) return fail(401, 'not signed in');
    const keys = this.signedInKeys(userId, meta);
    const wait = this.throttle.reserve(keys, this.now());
    if (wait > 0) return tooMany(wait);
    const stored = user.password;
    let matches: boolean | typeof BUSY = BUSY;
    try {
      matches = await this.withScryptSlot(() => verifyPassword(input.currentPassword, stored));
    } finally {
      this.throttle.settle(keys, this.now(), matches === false);
    }
    if (matches === BUSY) return busy();
    if (!matches) return fail(401, 'your current password is not right');
    const refused = this.confirmSecondFactor(userId, input.code, meta);
    if (refused) return refused;
    // The code is spent by now: this one waits for a slot rather than being shed.
    const password = await this.withScryptSlot(() => hashPassword(input.newPassword, this.scrypt), true);
    if (password === BUSY) return busy();
    this.mutate((store) => {
      const entry = store.users.find((candidate) => candidate.id === userId);
      if (entry) entry.password = password;
    });
    appendAudit({ event: 'password-changed', user: user.name, address: meta.address }, this.now());
    return { ok: true, revoked: this.revokeOtherSessions(userId, currentSessionId) };
  }

  /** Replaces ALL recovery codes: the old set stops working the moment the new one is shown. */
  regenerateRecoveryCodes(userId: string, code: string, meta: RequestMeta): AuthResult<{ recoveryCodes: string[] }> {
    const refused = this.confirmSecondFactor(userId, code, meta);
    if (refused) return refused;
    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    this.mutate((store) => {
      const entry = store.users.find((candidate) => candidate.id === userId);
      if (entry) entry.recovery = recoveryCodes.map((value) => sha256(value));
    });
    appendAudit({ event: 'recovery-regenerated', user: userId, address: meta.address }, this.now());
    return { ok: true, recoveryCodes };
  }

  /** False when the id is not one of this user's sessions — the route answers 404. */
  revokeSession(userId: string, sessionId: string): boolean {
    const sessions = this.sessionMap();
    const session = [...sessions.values()].find((entry) => entry.id === sessionId && entry.userId === userId);
    if (!session) return false;
    sessions.delete(session.tokenHash);
    this.persistSessions();
    appendAudit({ event: 'session-revoked', session: sessionId }, this.now());
    return true;
  }
}
