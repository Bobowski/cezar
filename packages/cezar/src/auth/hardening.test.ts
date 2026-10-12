import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHostKey, readHostKey } from './host-key.ts';
import { AuthService } from './service.ts';
import { appendAudit, issueSetupCode, mutateAuthStore, readAuthStore } from './store.ts';
import { LoginThrottle } from './throttle.ts';
import { base32Decode, hotp, totpStep } from './totp.ts';

/** Regression tests for the 2026-10-12 security review of the auth service (spec §5.3–§5.5). */

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const OWNER_META = { address: '198.51.100.1', label: 'Chrome on macOS' };
const PASSWORD = 'a long enough password';
const from = (address: string) => ({ address, label: 'curl' });

describe('auth hardening', () => {
  let dir: string;
  let storePath: string;
  let now: number;
  let service: AuthService;

  const codeFor = (secret: string) => hotp(base32Decode(secret)!, totpStep(now));
  const instance = (sessions = 'auth-sessions.json') =>
    new AuthService({ storePath, sessionsPath: join(dir, sessions), scrypt: FAST, now: () => now });

  async function createOwner(on: AuthService = service) {
    const issued = issueSetupCode({ path: storePath, now });
    if (!issued.ok) throw new Error('setup code refused');
    const begun = await on.beginSetup({ code: issued.setup.code, username: 'mateusz', password: PASSWORD }, OWNER_META);
    if (!begun.ok) throw new Error(begun.error);
    const done = on.completeSetup({ ticket: begun.ticket, code: codeFor(begun.secret) }, OWNER_META);
    if (!done.ok) throw new Error(done.error);
    return { secret: begun.secret, ...done, sessionId: on.authenticate(done.token)!.sessionId };
  }

  async function signIn(on: AuthService, secret: string) {
    now += 60_000;
    const first = await on.login({ username: 'mateusz', password: PASSWORD }, OWNER_META);
    if (!first.ok) throw new Error(first.error);
    const result = on.verifyLogin({ ticket: first.ticket, code: codeFor(secret) }, OWNER_META);
    if (!result.ok) throw new Error(result.error);
    return result.token;
  }

  /** Wrong passwords for the owner's name, each from a new address, honouring Retry-After. */
  async function lockAccount(failures: number) {
    let counted = 0;
    for (let i = 0; counted < failures; i += 1) {
      const result = await service.login({ username: 'mateusz', password: 'wrong wrong wrong' }, from(`203.0.113.${i % 250}`));
      if (result.ok) throw new Error('unexpected sign-in');
      if (result.status === 401) counted += 1;
      else now += (result.retryAfterSec ?? 1) * 1000;
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-auth-hard-'));
    storePath = join(dir, 'auth.json');
    process.env.CEZ_HOME = dir;
    now = Date.UTC(2026, 9, 12, 12, 0, 0);
    service = instance();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('sessionAlive', () => {
    it('is true for a live session and false for an unknown, revoked or reset one', async () => {
      const owner = await createOwner();
      expect(service.sessionAlive(owner.sessionId)).toBe(true);
      expect(service.sessionAlive('nope')).toBe(false);
      const other = service.authenticate(await signIn(service, owner.secret))!.sessionId;
      service.revokeSession(owner.user.id, other);
      expect(service.sessionAlive(other)).toBe(false);
      issueSetupCode({ path: storePath, now, resetUser: 'mateusz' });
      expect(service.sessionAlive(owner.sessionId)).toBe(false);
    });

    it('does not slide the idle expiry, and reports idle and absolute expiry', async () => {
      const owner = await createOwner();
      const sessionsPath = join(dir, 'auth-sessions.json');
      const before = readFileSync(sessionsPath, 'utf8');
      for (let day = 0; day < 6; day += 1) {
        now += 24 * 60 * 60_000;
        expect(service.sessionAlive(owner.sessionId)).toBe(true);
      }
      expect(readFileSync(sessionsPath, 'utf8')).toBe(before);
      now += 24 * 60 * 60_000 + 1; // seven idle days: polling did not keep it alive
      expect(service.sessionAlive(owner.sessionId)).toBe(false);

      const token = await signIn(service, owner.secret);
      const again = service.authenticate(token)!.sessionId;
      for (let day = 0; day < 29; day += 1) {
        now += 24 * 60 * 60_000;
        expect(service.authenticate(token)).not.toBeNull(); // used daily: only the absolute limit ends it
        expect(service.sessionAlive(again)).toBe(true);
      }
      now += 24 * 60 * 60_000 + 1;
      expect(service.sessionAlive(again)).toBe(false);
    });
  });

  describe('fix 1 — parallel guesses count like sequential ones', () => {
    it('evaluates at most five of a parallel burst from one address', async () => {
      await createOwner();
      now += 60_000;
      const guesses = Array.from({ length: 20 }, () =>
        service.login({ username: 'mateusz', password: 'wrong wrong wrong' }, from('203.0.113.9')));
      const right = service.login({ username: 'mateusz', password: PASSWORD }, from('203.0.113.9'));
      const results = await Promise.all(guesses);
      expect(results.filter((result) => !result.ok && result.status === 401).length).toBeLessThanOrEqual(5);
      expect(await right).toMatchObject({ ok: false, status: 429 });
    });

    it('holds for the account key when every guess comes from another address', async () => {
      await createOwner();
      now += 60_000;
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        service.login({ username: 'mateusz', password: 'wrong wrong wrong' }, from(`203.0.113.${i}`))));
      expect(results.filter((result) => !result.ok && result.status === 401).length).toBeLessThanOrEqual(5);
    });

    it('releases the reservation on success: five parallel correct sign-ins all pass', async () => {
      await createOwner();
      now += 60_000;
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META)));
      expect(results.every((result) => result.ok)).toBe(true);
      expect((await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META)).ok).toBe(true);
    });
  });

  describe('fix 2 — the scrypt queue is bounded', () => {
    it('refuses with a retry-after instead of queueing past the cap', async () => {
      await createOwner();
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
        service.login({ username: `nobody${i}`, password: 'wrong wrong wrong' }, from(`192.0.2.${i}`))));
      const evaluated = results.filter((result) => !result.ok && result.status === 401);
      const shed = results.filter((result) => !result.ok && result.status === 429);
      expect(evaluated.length).toBeLessThanOrEqual(10); // 2 running + 8 waiting
      expect(evaluated.length).toBeGreaterThan(0);
      expect(shed.length).toBe(40 - evaluated.length);
      for (const result of shed) expect(!result.ok && result.retryAfterSec).toBeGreaterThan(0);
      // A shed request was never a guess: it must not have fed the backoff.
      expect((await service.login({ username: 'nobody39', password: 'wrong wrong wrong' }, from('192.0.2.39'))))
        .toMatchObject({ ok: false, status: 401 });
    });
  });

  describe('fix 3 — the account key cannot lock the owner out', () => {
    it('caps the account-keyed delay at 60 s', async () => {
      await createOwner();
      await lockAccount(20);
      const blocked = await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META);
      expect(blocked).toMatchObject({ ok: false, status: 429 });
      if (!blocked.ok) expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
      now += 61_000;
      expect((await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META)).ok).toBe(true);
    });

    it('keeps the address-keyed delay at 15 minutes', async () => {
      await createOwner();
      let wait = 0;
      for (let i = 0; i < 40 && wait < 900; i += 1) {
        const result = await service.login({ username: `nobody${i}`, password: 'wrong wrong wrong' }, from('203.0.113.9'));
        if (!result.ok && result.status === 429) {
          wait = result.retryAfterSec ?? 0;
          now += wait * 1000;
        }
      }
      expect(wait).toBe(900);
    });

    it('keeps the second-factor delay at 15 minutes — those failures need the password', async () => {
      const owner = await createOwner();
      void owner;
      let wait = 0;
      for (let i = 0; i < 60 && wait < 900; i += 1) {
        const first = await service.login({ username: 'mateusz', password: PASSWORD }, from(`203.0.113.${i}`));
        if (!first.ok) throw new Error(first.error);
        const result = service.verifyLogin({ ticket: first.ticket, code: '000000' }, from(`203.0.113.${i}`));
        if (!result.ok && result.status === 429) {
          wait = result.retryAfterSec ?? 0;
          now += wait * 1000;
        }
      }
      expect(wait).toBe(900);
    });

    it('lets a signed-in owner change the password and regenerate codes while the login key is blocked', async () => {
      const owner = await createOwner();
      now += 60_000;
      await lockAccount(20);
      expect(await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META)).toMatchObject({ status: 429 });
      expect(service.regenerateRecoveryCodes(owner.user.id, codeFor(owner.secret), OWNER_META)).toMatchObject({ ok: true });
      now += 30_000; // a fresh TOTP step
      expect(await service.changePassword(
        owner.user.id, owner.sessionId,
        { currentPassword: PASSWORD, code: codeFor(owner.secret), newPassword: 'an entirely new password' }, OWNER_META,
      )).toMatchObject({ ok: true });
    });

    it('does not let signed-in failures feed the anonymous login key', async () => {
      const owner = await createOwner();
      now += 60_000;
      for (let i = 0; i < 12; i += 1) service.regenerateRecoveryCodes(owner.user.id, '000000', from(`203.0.113.${i}`));
      expect((await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META)).ok).toBe(true);
      // …but they do back themselves off, per user id
      expect(service.regenerateRecoveryCodes(owner.user.id, codeFor(owner.secret), OWNER_META)).toMatchObject({ status: 429 });
    });
  });

  describe('fix 4 — cheap failures cannot evict account keys', () => {
    it('keeps a blocked account blocked after 10,001 rejected setup codes', async () => {
      await createOwner();
      for (let i = 0; i < 5; i += 1) {
        await service.login({ username: 'mateusz', password: 'wrong wrong wrong' }, from(`203.0.113.${i}`));
      }
      expect(await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META)).toMatchObject({ status: 429 });
      for (let i = 0; i < 10_001; i += 1) {
        await service.beginSetup({ code: 'x', username: 'a', password: PASSWORD }, from(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`));
      }
      expect(await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META)).toMatchObject({ status: 429 });
    }, 60_000);

    it('keeps address keys from evicting account keys inside one throttle', () => {
      const throttle = new LoginThrottle();
      for (let i = 0; i < 6; i += 1) throttle.fail(['user:owner'], 1_000);
      for (let i = 0; i < 10_001; i += 1) throttle.fail([`ip:10.0.${i >> 8}.${i & 255}`], 1_000);
      expect(throttle.retryAfter(['user:owner'], 1_000)).toBeGreaterThan(0);
    });
  });

  describe('fix 5 — an IPv6 /64 is one address', () => {
    it('maps addresses to their throttle key', async () => {
      const { throttleAddress } = (await import('./throttle.ts')) as unknown as { throttleAddress: (address: string) => string };
      expect(throttleAddress('203.0.113.7')).toBe('203.0.113.7');
      expect(throttleAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
      expect(throttleAddress('::ffff:cb00:7107')).toBe('203.0.113.7');
      expect(throttleAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(throttleAddress('2001:db8:1:2::1'));
      expect(throttleAddress('2001:db8:1:2::1')).not.toBe(throttleAddress('2001:db8:1:3::1'));
      expect(throttleAddress('2001:DB8::1%eth0')).toBe(throttleAddress('2001:db8:0:0:ffff::'));
      expect(throttleAddress('::1')).toBe(throttleAddress('::2'));
      expect(throttleAddress('unknown')).toBe('unknown');
    });

    it('backs off a client that rotates through its own /64', async () => {
      const results = [];
      for (let i = 0; i < 6; i += 1) {
        results.push(await service.beginSetup({ code: 'x', username: 'a', password: PASSWORD }, from(`2001:db8:1:2::${i + 1}`)));
      }
      expect(results[5]).toMatchObject({ ok: false, status: 429 });
      expect(await service.beginSetup({ code: 'x', username: 'a', password: PASSWORD }, from('2001:db8:1:3::1')))
        .toMatchObject({ ok: false, status: 401 });
    });
  });

  describe('fix 6 — a sibling instance sharing auth.json', () => {
    it('loses its sessions when the password changes on the other instance; the current session survives', async () => {
      const a = instance('auth-sessions.json');
      const b = instance('auth-sessions-second.json');
      const owner = await createOwner(a);
      const onB = await signIn(b, owner.secret);
      expect(b.authenticate(onB)).not.toBeNull();
      now += 60_000;
      const changed = await a.changePassword(
        owner.user.id, owner.sessionId,
        { currentPassword: PASSWORD, code: codeFor(owner.secret), newPassword: 'an entirely new password' }, OWNER_META,
      );
      expect(changed).toMatchObject({ ok: true });
      expect(b.authenticate(onB)).toBeNull();
      expect(a.authenticate(owner.token)).not.toBeNull();
      expect(instance('auth-sessions.json').authenticate(owner.token)).not.toBeNull(); // and across a restart
    });

    it('loses its sessions on "sign out other devices" too', async () => {
      const a = instance('auth-sessions.json');
      const b = instance('auth-sessions-second.json');
      const owner = await createOwner(a);
      const onB = await signIn(b, owner.secret);
      const sessionOnB = b.authenticate(onB)!.sessionId;
      expect(a.revokeOtherSessions(owner.user.id, owner.sessionId)).toBe(0); // none of A's own
      expect(b.sessionAlive(sessionOnB)).toBe(false);
      expect(b.authenticate(onB)).toBeNull();
      expect(a.authenticate(owner.token)).not.toBeNull();
      expect(instance('auth-sessions.json').authenticate(owner.token)).not.toBeNull();
    });

    it('voids a sign-in that was between its two steps', async () => {
      const owner = await createOwner();
      now += 60_000;
      const first = await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META);
      if (!first.ok) throw new Error(first.error);
      service.revokeOtherSessions(owner.user.id, owner.sessionId);
      expect(service.verifyLogin({ ticket: first.ticket, code: codeFor(owner.secret) }, OWNER_META)).toMatchObject({ ok: false });
    });
  });

  describe('fix 7 — an invalid host key file is replaced', () => {
    it('replaces an empty or truncated key, 0600', () => {
      const path = join(dir, 'auth-host.key');
      for (const junk of ['', 'cezhost_abc\n']) {
        writeFileSync(path, junk, { mode: 0o644 });
        ensureHostKey(path);
        expect(readHostKey(path)).toBeDefined();
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('replaces a key it cannot read', () => {
      const path = join(dir, 'auth-host.key');
      writeFileSync(path, 'cezhost_abc\n');
      chmodSync(path, 0o000);
      ensureHostKey(path);
      expect(readHostKey(path)).toBeDefined();
    });

    it('never replaces a valid key', () => {
      const path = join(dir, 'auth-host.key');
      ensureHostKey(path);
      const key = readHostKey(path);
      expect(key).toBeDefined();
      ensureHostKey(path);
      expect(readHostKey(path)).toBe(key);
    });
  });

  describe('fix 8 — the audit log is bounded', () => {
    it('rotates to a single .1 once it passes the cap', () => {
      const path = join(dir, 'auth-audit.ndjson');
      writeFileSync(path, `${'x'.repeat(99)}\n`.repeat(50_000)); // 5 MB
      appendAudit({ event: 'setup-rejected', address: '203.0.113.9' }, now, path);
      expect(existsSync(`${path}.1`)).toBe(true);
      expect(statSync(path).size).toBeLessThan(1_000);
      expect(readFileSync(path, 'utf8')).toContain('setup-rejected');
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
      }
      // a second rotation replaces .1 rather than adding .2
      writeFileSync(path, `${'y'.repeat(99)}\n`.repeat(50_000));
      appendAudit({ event: 'setup-rejected' }, now, path);
      expect(readFileSync(`${path}.1`, 'utf8').startsWith('y')).toBe(true);
      expect(existsSync(`${path}.2`)).toBe(false);
    });

    it('leaves a small log alone', () => {
      const path = join(dir, 'auth-audit.ndjson');
      appendAudit({ event: 'login' }, now, path);
      appendAudit({ event: 'logout' }, now, path);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
      expect(existsSync(`${path}.1`)).toBe(false);
    });
  });

  describe('fix 9 — the store is not rewritten for nothing', () => {
    it('leaves auth.json untouched when the mutator changed nothing', async () => {
      const owner = await createOwner();
      now += 60_000;
      const before = statSync(storePath).ino;
      const first = await service.login({ username: 'mateusz', password: PASSWORD }, OWNER_META);
      if (!first.ok) throw new Error(first.error);
      expect(service.verifyLogin({ ticket: first.ticket, code: '000000' }, OWNER_META)).toMatchObject({ status: 401 });
      expect(mutateAuthStore(() => 'nothing', storePath)).toBe('nothing');
      expect(statSync(storePath).ino).toBe(before);
      // a real change still lands
      expect(service.verifyLogin({ ticket: first.ticket, code: codeFor(owner.secret) }, OWNER_META).ok).toBe(true);
      expect(statSync(storePath).ino).not.toBe(before);
    });

    it('keeps a copy of the file before a rewrite drops a row it could not parse', async () => {
      await createOwner();
      const raw = JSON.parse(readFileSync(storePath, 'utf8'));
      raw.users.push({ id: 'future', name: 'Not A Valid Name!', totp: { secret: 'S'.repeat(32) } });
      const original = JSON.stringify(raw);
      writeFileSync(storePath, original);
      mutateAuthStore((store) => { store.users[0]!.recovery = []; }, storePath);
      expect(readAuthStore(storePath).users).toHaveLength(1);
      expect(readFileSync(`${storePath}.corrupt`, 'utf8')).toBe(original);
    });
  });
});
