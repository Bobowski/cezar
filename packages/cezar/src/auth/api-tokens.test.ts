import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTokenAllows, apiTokenIdOf, isApiToken, mintApiToken, routeFamily } from './api-tokens.ts';
import { AuthService } from './service.ts';
import { issueSetupCode, readAuthStore } from './store.ts';
import { base32Decode, hotp, totpStep } from './totp.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const META = { address: '203.0.113.7', label: 'Chrome on macOS' };

describe('API token values', () => {
  it('are ceztok_<hex id>_<secret>, and only those parse', () => {
    const { id, value } = mintApiToken();
    expect(value.startsWith(`ceztok_${id}_`)).toBe(true);
    expect(isApiToken(value)).toBe(true);
    expect(apiTokenIdOf(value)).toBe(id);
    expect(apiTokenIdOf('ceztok_nothex000000_aaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(apiTokenIdOf(`ceztok_${id}_short`)).toBeNull();
    expect(apiTokenIdOf(`cezrun_${id}_aaaaaaaaaaaaaaaaaaaaaaaa`)).toBeNull();
  });
});

describe('API token scopes, per route family', () => {
  it('reads the family off a scoped or unscoped path, and the workspace sub-family', () => {
    expect(routeFamily('/api/v1/runs/1/messages')).toBe('runs');
    expect(routeFamily('/api/v1/p/proj/runs')).toBe('runs');
    expect(routeFamily('/api/v1/workspace/dashboard/costs')).toBe('workspace/dashboard');
    expect(routeFamily('/elsewhere')).toBeNull();
  });

  it('read is every GET and no write', () => {
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/p/x/runs')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/workflows')).toBe(true);
    expect(apiTokenAllows(['read'], 'POST', '/api/v1/runs')).toBe(false);
    expect(apiTokenAllows(['read'], 'DELETE', '/api/v1/runs/1')).toBe(false);
  });

  it('read never covers a read that hands out a credential or raw config', () => {
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/launch-key')).toBe(false);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/agent-config/claude-settings')).toBe(false);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/env-files/content')).toBe(false);
    expect(apiTokenAllows(['author'], 'GET', '/api/v1/env-files/content')).toBe(true);
    expect(apiTokenAllows(['admin'], 'GET', '/api/v1/launch-key')).toBe(true);
  });

  it('tasks writes runs and their kin, and nothing an author or admin owns', () => {
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/p/x/runs')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/runs/1/messages')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/runs/1/history')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/workflows')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'PUT', '/api/v1/config')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/config')).toBe(false);
  });

  it('author writes workflows, skills, automations and env files', () => {
    for (const path of ['/api/v1/workflows', '/api/v1/skills/refresh', '/api/v1/automations', '/api/v1/env-files/render']) {
      expect(apiTokenAllows(['author'], 'POST', path), path).toBe(true);
    }
    expect(apiTokenAllows(['author'], 'POST', '/api/v1/runs')).toBe(false);
    expect(apiTokenAllows(['author'], 'POST', '/api/v1/workspace/self-update/apply')).toBe(false);
  });

  it('admin is everything but sign-in; every token may discover projects and reach the MCP transport', () => {
    expect(apiTokenAllows(['admin'], 'POST', '/api/v1/workspace/self-update/apply')).toBe(true);
    expect(apiTokenAllows(['admin'], 'GET', '/api/v1/auth/tokens')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/projects')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/projects')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/mcp')).toBe(true);
    expect(apiTokenAllows([], 'POST', '/api/v1/mcp')).toBe(false);
  });

  it('fails closed on a family nobody mapped', () => {
    expect(apiTokenAllows(['read', 'tasks', 'author'], 'POST', '/api/v1/brand-new-family')).toBe(false);
    expect(apiTokenAllows(['admin'], 'POST', '/api/v1/brand-new-family')).toBe(true);
  });
});

describe('API tokens in the auth store', () => {
  let dir: string;
  let storePath: string;
  let now: number;
  let service: AuthService;
  let secret: string;
  let userId: string;

  const code = (at = now) => hotp(base32Decode(secret)!, totpStep(at));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cez-tokens-'));
    storePath = join(dir, 'auth.json');
    process.env.CEZ_HOME = dir;
    now = Date.UTC(2026, 9, 24, 12, 0, 0);
    service = new AuthService({ storePath, sessionsPath: join(dir, 'auth-sessions.json'), scrypt: FAST, now: () => now });
    const issued = issueSetupCode({ path: storePath, now });
    if (!issued.ok) throw new Error('setup refused');
    const begun = await service.beginSetup({ code: issued.setup.code, username: 'mateusz', password: 'a long enough password' }, META);
    if (!begun.ok) throw new Error(begun.error);
    secret = begun.secret;
    const done = service.completeSetup({ ticket: begun.ticket, code: code() }, META);
    if (!done.ok) throw new Error(done.error);
    userId = done.user.id;
    now += 31_000; // the next time step: setup spent this one
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mints with a fresh authenticator code, stores only the hash, and verifies the value', () => {
    expect(service.createApiToken(userId, { name: 'laptop', scopes: ['tasks'], code: '000000' }, META)).toMatchObject({ ok: false, status: 401 });
    const created = service.createApiToken(userId, { name: 'laptop', scopes: ['tasks', 'tasks'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(created.token).toMatchObject({ name: 'laptop', scopes: ['tasks'] });
    expect(readFileSync(storePath, 'utf8')).not.toContain(created.value);
    expect(service.verifyApiToken(created.value)).toMatchObject({ tokenId: created.token.id, scopes: ['tasks'], user: { name: 'mateusz' } });
    expect(service.verifyApiToken(`${created.value}x`)).toBeNull();
    expect(service.verifyApiToken(created.value.replace(/_[^_]+$/, '_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'))).toBeNull();
  });

  it('lists with last use, revokes, and a revoked token opens nothing', () => {
    const created = service.createApiToken(userId, { name: 'ci', scopes: ['read'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(service.listApiTokens(userId)[0]?.lastUsedAt).toBeUndefined();
    service.verifyApiToken(created.value, { touch: true });
    expect(service.listApiTokens(userId)[0]?.lastUsedAt).toBe(new Date(now).toISOString());
    expect(service.revokeApiToken('someone-else', created.token.id)).toBe(false);
    expect(service.revokeApiToken(userId, created.token.id)).toBe(true);
    expect(service.verifyApiToken(created.value)).toBeNull();
    expect(service.listApiTokens(userId)).toEqual([]);
  });

  it('expires, and refuses an expiry in the past', () => {
    expect(service.createApiToken(userId, { name: 'old', scopes: ['read'], code: code(), expiresAt: new Date(now - 1).toISOString() }, META))
      .toMatchObject({ ok: false, status: 400 });
    const created = service.createApiToken(userId, { name: 'day', scopes: ['read'], code: code(), expiresAt: new Date(now + 86_400_000).toISOString() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(service.verifyApiToken(created.value)).not.toBeNull();
    now += 86_400_000;
    expect(service.verifyApiToken(created.value)).toBeNull();
  });

  it('dies with an account reset, and one bad row on disk never revokes the rest', () => {
    const created = service.createApiToken(userId, { name: 'ci', scopes: ['read'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { tokens: unknown[] };
    expect(readAuthStore(storePath).tokens).toHaveLength(1);
    raw.tokens.push({ id: 'not-an-id' });
    writeFileSync(storePath, JSON.stringify(raw));
    expect(readAuthStore(storePath).tokens).toHaveLength(1);
    expect(service.verifyApiToken(created.value)).not.toBeNull();
    expect(issueSetupCode({ path: storePath, now, resetUser: 'mateusz' }).ok).toBe(true);
    expect(service.verifyApiToken(created.value)).toBeNull();
    expect(readAuthStore(storePath).tokens).toEqual([]);
  });
});
