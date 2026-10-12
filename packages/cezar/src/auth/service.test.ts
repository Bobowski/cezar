import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './service.ts';
import { issueSetupCode, readAuthStore } from './store.ts';
import { base32Decode, hotp, totpStep } from './totp.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const META = { address: '203.0.113.7', label: 'Chrome on macOS' };
const PASSWORD = 'a long enough password';

describe('AuthService', () => {
  let dir: string;
  let storePath: string;
  let sessionsPath: string;
  let now: number;
  let service: AuthService;

  const codeFor = (secret: string, at = now) => hotp(base32Decode(secret)!, totpStep(at));
  const fresh = () => new AuthService({ storePath, sessionsPath, scrypt: FAST, now: () => now });

  /** The whole setup flow; answers what a real owner would be holding afterwards. */
  async function createOwner(name = 'mateusz') {
    const issued = issueSetupCode({ path: storePath, now });
    if (!issued.ok) throw new Error('setup code refused');
    const begun = await service.beginSetup({ code: issued.setup.code, username: name, password: PASSWORD }, META);
    if (!begun.ok) throw new Error(begun.error);
    const done = service.completeSetup({ ticket: begun.ticket, code: codeFor(begun.secret) }, META);
    if (!done.ok) throw new Error(done.error);
    return { secret: begun.secret, ...done };
  }

  async function signIn(secret: string, name = 'mateusz') {
    const first = await service.login({ username: name, password: PASSWORD }, META);
    if (!first.ok) throw new Error(first.error);
    return service.verifyLogin({ ticket: first.ticket, code: codeFor(secret) }, META);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-auth-'));
    storePath = join(dir, 'auth.json');
    sessionsPath = join(dir, 'auth-sessions.json');
    process.env.CEZ_HOME = dir; // the audit log follows the home
    now = Date.UTC(2026, 9, 12, 12, 0, 0);
    service = fresh();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('needs setup until an owner exists, and setup needs the code minted on the host', async () => {
    expect(service.setupRequired()).toBe(true);
    const bogus = await service.beginSetup({ code: 'guessed', username: 'eve', password: PASSWORD }, META);
    expect(bogus).toMatchObject({ ok: false, status: 401 });
    const owner = await createOwner();
    expect(owner.user).toMatchObject({ name: 'mateusz', role: 'owner' });
    expect(owner.recoveryCodes).toHaveLength(10);
    expect(service.setupRequired()).toBe(false);
    expect(service.authenticate(owner.token)?.user.name).toBe('mateusz');
  });

  it('stores nothing reversible but the TOTP seed, in a 0600 file', async () => {
    const owner = await createOwner();
    const raw = readFileSync(storePath, 'utf8');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(owner.token);
    for (const code of owner.recoveryCodes) expect(raw).not.toContain(code);
    expect(readFileSync(sessionsPath, 'utf8')).not.toContain(owner.token);
    if (process.platform !== 'win32') {
      expect(statSync(storePath).mode & 0o777).toBe(0o600);
      expect(statSync(sessionsPath).mode & 0o777).toBe(0o600);
    }
  });

  it('spends the setup code: the same link cannot create a second account', async () => {
    const issued = issueSetupCode({ path: storePath, now });
    if (!issued.ok) throw new Error('refused');
    const a = await service.beginSetup({ code: issued.setup.code, username: 'first', password: PASSWORD }, META);
    const b = await service.beginSetup({ code: issued.setup.code, username: 'second', password: PASSWORD }, META);
    if (!a.ok || !b.ok) throw new Error('begin refused');
    expect(service.completeSetup({ ticket: a.ticket, code: codeFor(a.secret) }, META).ok).toBe(true);
    expect(service.completeSetup({ ticket: b.ticket, code: codeFor(b.secret) }, META)).toMatchObject({ ok: false, status: 401 });
    expect(readAuthStore(storePath).users.map((user) => user.name)).toEqual(['first']);
    expect(issueSetupCode({ path: storePath, now })).toEqual({ ok: false, reason: 'owner-exists' });
  });

  it('does not write the account when the authenticator code is wrong', async () => {
    const issued = issueSetupCode({ path: storePath, now });
    if (!issued.ok) throw new Error('refused');
    const begun = await service.beginSetup({ code: issued.setup.code, username: 'mateusz', password: PASSWORD }, META);
    if (!begun.ok) throw new Error(begun.error);
    expect(service.completeSetup({ ticket: begun.ticket, code: '000000' }, META)).toMatchObject({ ok: false, status: 401 });
    expect(service.setupRequired()).toBe(true);
  });

  it('expires a setup code after fifteen minutes', async () => {
    const issued = issueSetupCode({ path: storePath, now });
    if (!issued.ok) throw new Error('refused');
    now += 15 * 60_000 + 1;
    expect(await service.beginSetup({ code: issued.setup.code, username: 'late', password: PASSWORD }, META))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('signs in with password then TOTP, and a password alone issues nothing', async () => {
    const owner = await createOwner();
    now += 60_000;
    const first = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    expect(first).toMatchObject({ ok: true });
    expect(first).not.toHaveProperty('token');
    const result = await signIn(owner.secret);
    expect(result).toMatchObject({ ok: true, user: { name: 'mateusz' } });
    if (result.ok) expect(service.authenticate(result.token)).not.toBeNull();
  });

  it('answers one message for a wrong password and an unknown user', async () => {
    await createOwner();
    const wrong = await service.login({ username: 'mateusz', password: 'not the password' }, META);
    const unknown = await service.login({ username: 'nobody', password: PASSWORD }, META);
    expect(wrong).toMatchObject({ ok: false, status: 401 });
    expect(unknown).toEqual(wrong);
  });

  it('refuses a TOTP code that was already used', async () => {
    const owner = await createOwner();
    now += 60_000;
    const code = codeFor(owner.secret);
    const one = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    const two = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    if (!one.ok || !two.ok) throw new Error('login refused');
    expect(service.verifyLogin({ ticket: one.ticket, code }, META).ok).toBe(true);
    expect(service.verifyLogin({ ticket: two.ticket, code }, META)).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts a recovery code exactly once', async () => {
    const owner = await createOwner();
    const recovery = owner.recoveryCodes[0]!;
    const one = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    if (!one.ok) throw new Error(one.error);
    expect(service.verifyLogin({ ticket: one.ticket, code: recovery.toUpperCase() }, META).ok).toBe(true);
    const two = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    if (!two.ok) throw new Error(two.error);
    expect(service.verifyLogin({ ticket: two.ticket, code: recovery }, META)).toMatchObject({ ok: false });
    expect(readAuthStore(storePath).users[0]!.recovery).toHaveLength(9);
  });

  it('burns a login ticket after five wrong codes', async () => {
    const owner = await createOwner();
    now += 60_000;
    const first = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    if (!first.ok) throw new Error(first.error);
    for (let i = 0; i < 5; i += 1) {
      now += 20 * 60_000; // step past the backoff, so it is the TICKET that refuses
      service.verifyLogin({ ticket: first.ticket, code: '000000' }, META);
    }
    now += 20 * 60_000;
    const late = service.verifyLogin({ ticket: first.ticket, code: codeFor(owner.secret) }, META);
    expect(late).toMatchObject({ ok: false, status: 401, error: expect.stringContaining('expired') });
  });

  it('backs off after repeated failures and says how long, without locking the account', async () => {
    const owner = await createOwner();
    for (let i = 0; i < 4; i += 1) await service.login({ username: 'mateusz', password: 'wrong wrong wrong' }, META);
    expect((await service.login({ username: 'mateusz', password: PASSWORD }, META)).ok).toBe(true);
    for (let i = 0; i < 4; i += 1) await service.login({ username: 'mateusz', password: 'wrong wrong wrong' }, META);
    const blocked = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    expect(blocked).toMatchObject({ ok: false, status: 429 });
    if (!blocked.ok) expect(blocked.retryAfterSec).toBeGreaterThan(0);
    now += 16 * 60_000;
    expect((await signIn(owner.secret)).ok).toBe(true);
  });

  it('expires a session after seven idle days and thirty days in all', async () => {
    const owner = await createOwner();
    now += 6 * 24 * 60 * 60_000;
    expect(service.authenticate(owner.token)).not.toBeNull(); // slides
    now += 6 * 24 * 60 * 60_000;
    expect(service.authenticate(owner.token)).not.toBeNull();
    now += 7 * 24 * 60 * 60_000 + 1;
    expect(service.authenticate(owner.token)).toBeNull();

    const again = await signIn(owner.secret);
    if (!again.ok) throw new Error(again.error);
    for (let day = 0; day < 30; day += 1) {
      now += 24 * 60 * 60_000;
      if (day < 29) expect(service.authenticate(again.token)).not.toBeNull();
    }
    expect(service.authenticate(again.token)).toBeNull();
  });

  it('keeps sessions across a restart', async () => {
    const owner = await createOwner();
    service = fresh();
    expect(service.authenticate(owner.token)?.user.name).toBe('mateusz');
  });

  it('lists a user’s devices and revokes one without touching the other', async () => {
    const owner = await createOwner();
    now += 60_000;
    const second = await signIn(owner.secret);
    if (!second.ok) throw new Error(second.error);
    const current = service.authenticate(second.token)!;
    const devices = service.listSessions(owner.user.id, current.sessionId);
    expect(devices).toHaveLength(2);
    expect(devices.filter((device) => device.current)).toHaveLength(1);
    const other = devices.find((device) => !device.current)!;
    expect(service.revokeSession('someone-else', other.id)).toBe(false);
    expect(service.revokeSession(owner.user.id, other.id)).toBe(true);
    expect(service.authenticate(owner.token)).toBeNull();
    expect(service.authenticate(second.token)).not.toBeNull();
    service.logout(second.token);
    expect(service.authenticate(second.token)).toBeNull();
  });

  it('a reset from the host kills every session and the old credentials, with no server call', async () => {
    const owner = await createOwner();
    expect(issueSetupCode({ path: storePath, now, resetUser: 'nobody' })).toEqual({ ok: false, reason: 'unknown-user' });
    const reset = issueSetupCode({ path: storePath, now, resetUser: 'mateusz' });
    if (!reset.ok) throw new Error('reset refused');
    expect(service.authenticate(owner.token)).toBeNull();
    expect(service.setupRequired()).toBe(true);
    expect(await service.login({ username: 'mateusz', password: PASSWORD }, META)).toMatchObject({ ok: false, status: 401 });

    const begun = await service.beginSetup({ code: reset.setup.code, username: 'mateusz', password: 'a brand new password' }, META);
    if (!begun.ok) throw new Error(begun.error);
    const done = service.completeSetup({ ticket: begun.ticket, code: codeFor(begun.secret) }, META);
    expect(done).toMatchObject({ ok: true, user: { id: owner.user.id } }); // same account, new credentials
  });

  it('a reset between the two login steps voids the pending sign-in', async () => {
    const owner = await createOwner();
    now += 60_000;
    const first = await service.login({ username: 'mateusz', password: PASSWORD }, META);
    if (!first.ok) throw new Error(first.error);
    issueSetupCode({ path: storePath, now, resetUser: 'mateusz' });
    expect(service.verifyLogin({ ticket: first.ticket, code: codeFor(owner.secret) }, META)).toMatchObject({ ok: false });
  });

  it('fails closed on a corrupt store: setup required, the file kept for inspection', async () => {
    const owner = await createOwner();
    writeFileSync(storePath, '{ not json');
    expect(service.setupRequired()).toBe(true);
    expect(service.authenticate(owner.token)).toBeNull();
    expect(issueSetupCode({ path: storePath, now }).ok).toBe(true);
    expect(readFileSync(`${storePath}.corrupt`, 'utf8')).toBe('{ not json');
  });

  it('salvages the good rows of a hand-edited store', async () => {
    await createOwner();
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    raw.users.push({ id: 'broken', name: 'Not A Valid Name!' }, 'garbage');
    raw.futureKey = { kept: true };
    writeFileSync(storePath, JSON.stringify(raw));
    expect(readAuthStore(storePath).users.map((user) => user.name)).toEqual(['mateusz']);
    expect((readAuthStore(storePath) as Record<string, unknown>).futureKey).toEqual({ kept: true });
  });
});
