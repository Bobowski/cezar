import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeContracts } from '@open-mercato/cezar-contract';
import { apiTokenAllows, apiTokenIdOf, isApiToken, mintApiToken, READ_ROUTES, routeFamily } from './api-tokens.ts';
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

  it('read is the allowlisted GETs and no write', () => {
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/p/x/runs')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/workflows')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/runs/1/files')).toBe(true);
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

  it('read is an allowlist: secrets, shells and logs stay out, and a GET nobody listed is refused', () => {
    for (const path of [
      '/api/v1/secrets',
      '/api/v1/workspace/secrets',
      '/api/v1/env-files',
      '/api/v1/config',
      '/api/v1/workspace/config',
      '/api/v1/agent-config',
      '/api/v1/fs/browse',
      '/api/v1/tracker/connection',
      '/api/v1/tracker/connection/sources',
      '/api/v1/services/web/logs',
      '/api/v1/services/web/output',
      '/api/v1/repo/terminal/s1/output',
      '/api/v1/runs/1/terminal/s1/output',
      '/api/v1/worktree-lifecycle/operations/o1/output',
      '/api/v1/workspace/agent-profiles/a1/details',
      '/api/v1/workflows/brand-new-read',
    ]) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
    }
    // A literal route beats the parameter route it would also match.
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/tracker/T-1')).toBe(true);
  });

  it('read carries no transcript: that is runs.transcript, which tasks implies', () => {
    const transcript = [
      '/api/v1/runs/1/events', '/api/v1/p/x/runs/1/history', '/api/v1/runs/1/history-context',
      // The handoff and the todo inbox quote what the agent wrote.
      '/api/v1/runs/1/handoff', '/api/v1/p/x/todos',
    ];
    for (const path of transcript) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
      expect(apiTokenAllows(['runs.transcript'], 'GET', path), path).toBe(true);
      expect(apiTokenAllows(['tasks'], 'GET', path), path).toBe(true);
    }
    // The list and the summary stay read's.
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/runs')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/runs/1')).toBe(true);
    // runs.transcript is the transcript and nothing else.
    expect(apiTokenAllows(['runs.transcript'], 'GET', '/api/v1/runs/1/files')).toBe(false);
    expect(apiTokenAllows(['runs.transcript'], 'POST', '/api/v1/runs/1/history')).toBe(false);
  });

  it('a service’s command and the start command are author’s to read, not read’s', () => {
    for (const path of ['/api/v1/services', '/api/v1/p/x/start-app']) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
      expect(apiTokenAllows(['author'], 'GET', path), path).toBe(true);
    }
    // Reading them is all author gets: pinning and setting stay admin's.
    expect(apiTokenAllows(['author'], 'POST', '/api/v1/services')).toBe(false);
    expect(apiTokenAllows(['author'], 'PUT', '/api/v1/start-app')).toBe(false);
    expect(apiTokenAllows(['author'], 'GET', '/api/v1/services/web/logs')).toBe(false);
  });

  it('automations are author’s to read: their tasks are commands and prompts, their log quotes gh and the tracker', () => {
    for (const path of [
      '/api/v1/automations', '/api/v1/p/x/automations/a1', '/api/v1/automation-log', '/api/v1/automation-checks/c1',
      '/api/v1/workspace/automation-templates',
    ]) {
      expect(apiTokenAllows(['read'], 'GET', path), path).toBe(false);
      expect(apiTokenAllows(['author'], 'GET', path), path).toBe(true);
    }
    // The dashboard's automation activity is counts and states, and stays read's.
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/workspace/dashboard/automations')).toBe(true);
  });

  it('every route the read allowlist names is a real GET route', () => {
    const gets = new Set(Object.keys(routeContracts).filter((key) => key.startsWith('GET ')).map((key) => key.slice(4)));
    expect([...READ_ROUTES].filter((route) => !gets.has(route))).toEqual([]);
  });

  it('tasks writes runs and their kin, and nothing an author or admin owns', () => {
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/p/x/runs')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/runs/1/messages')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/runs/1/history')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/workflows')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'PUT', '/api/v1/config')).toBe(false);
    expect(apiTokenAllows(['tasks'], 'GET', '/api/v1/config')).toBe(false);
  });

  it('a task terminal is admin’s: tasks and author never get a shell on the host', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/runs/1/terminal'],
      ['GET', '/api/v1/runs/1/terminal'],
      ['POST', '/api/v1/p/x/runs/1/terminal/s1/input'],
      ['GET', '/api/v1/runs/1/terminal/s1/output'],
      ['DELETE', '/api/v1/runs/1/terminal/s1'],
    ] as const) {
      expect(apiTokenAllows(['read', 'tasks', 'author'], method, path), `${method} ${path}`).toBe(false);
      expect(apiTokenAllows(['admin'], method, path), `${method} ${path}`).toBe(true);
    }
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/runs/1/terminals-are-not-a-prefix')).toBe(true);
  });

  it('a tracker connection and project link are author’s; tasks keeps tickets and watches', () => {
    for (const [method, path] of [
      ['PUT', '/api/v1/tracker/connection'],
      ['DELETE', '/api/v1/tracker/connection'],
      ['POST', '/api/v1/p/x/tracker/connection/copy'],
      ['GET', '/api/v1/tracker/connection'],
      ['PUT', '/api/v1/tracker/association'],
      ['DELETE', '/api/v1/tracker/association'],
    ] as const) {
      expect(apiTokenAllows(['tasks'], method, path), `${method} ${path}`).toBe(false);
      expect(apiTokenAllows(['author'], method, path), `${method} ${path}`).toBe(true);
      expect(apiTokenAllows(['admin'], method, path), `${method} ${path}`).toBe(true);
    }
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/tracker/T-1/transition')).toBe(true);
    expect(apiTokenAllows(['tasks'], 'POST', '/api/v1/tracker/watch')).toBe(true);
    expect(apiTokenAllows(['read'], 'GET', '/api/v1/tracker/association')).toBe(true);
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

  it('the docs say what a scope cannot stop: tasks and author run code as the cezar user', () => {
    const repo = join(import.meta.dirname, '../../../..');
    const reference = readFileSync(join(repo, 'docs/reference.md'), 'utf8').replace(/\s+/g, ' ');
    const spec = readFileSync(join(repo, '.ai/specs/2026-10-24-cezar-mcp-server.md'), 'utf8').replace(/\s+/g, ' ');
    for (const text of [reference, spec]) {
      expect(text).toContain('bounds the API');
      expect(text).toMatch(/`tasks` and `author`[^.]*owner-equivalent/);
      expect(text).toMatch(/`read` is the only scope that executes nothing/);
    }
    expect(reference).not.toContain('never include shell access');
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

  it('dies with "sign out everywhere else" and with a password change', async () => {
    const mint = (name: string) => {
      const created = service.createApiToken(userId, { name, scopes: ['read'], code: code() }, META);
      if (!created.ok) throw new Error(created.error);
      now += 31_000;
      return created.value;
    };
    const first = mint('a');
    service.revokeOtherSessions(userId, 'this-session');
    expect(service.verifyApiToken(first)).toBeNull();
    const second = mint('b');
    const changed = await service.changePassword(userId, 'this-session', { currentPassword: 'a long enough password', code: code(), newPassword: 'another long password' }, META);
    expect(changed.ok).toBe(true);
    expect(service.verifyApiToken(second)).toBeNull();
    expect(service.listApiTokens(userId)).toEqual([]);
  });

  it('the trusted operator lists and revokes every user\'s tokens', () => {
    const created = service.createApiToken(userId, { name: 'ci', scopes: ['read'], code: code() }, META);
    if (!created.ok) throw new Error(created.error);
    expect(service.listApiTokens(undefined).map((token) => token.id)).toEqual([created.token.id]);
    expect(service.revokeApiToken(undefined, created.token.id)).toBe(true);
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
