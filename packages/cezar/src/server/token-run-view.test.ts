import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authSetupBeginResponseSchema, type ApiTokenScope } from '@open-mercato/cezar-contract';
import { mintApiToken } from '../auth/api-tokens.ts';
import { AuthService } from '../auth/service.ts';
import { issueSetupCode, mutateAuthStore, sha256 } from '../auth/store.ts';
import { base32Decode, hotp, totpStep } from '../auth/totp.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { todosWatchActive } from '../todos.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';

/**
 * What a token without `runs.transcript` sees of a task (spec 2026-10-24-cezar-mcp-server §4):
 * status, not what the agent wrote — on the routes and on both live streams.
 */

const HOST = 'agents.example.dev';
const HOSTED = { host: HOST, 'x-forwarded-proto': 'https' };
const TICK_MS = 20;

describe('a token’s view of a task', () => {
  let home: string;
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  const saved = {
    home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH, followups: process.env.CEZ_FOLLOWUPS,
  };

  const request = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { ...HOSTED, ...headers } });

  async function createOwner(): Promise<void> {
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { ...HOSTED, 'content-type': 'application/json' } });
    const issued = issueSetupCode();
    if (!issued.ok) throw new Error('setup code refused');
    const begin = await post('/api/v1/auth/setup/begin', { code: issued.setup.code, username: 'mateusz', password: 'a long enough password' });
    const begun = authSetupBeginResponseSchema.parse(await begin.json());
    const complete = await post('/api/v1/auth/setup/complete', { ticket: begun.ticket, code: hotp(base32Decode(begun.secret)!, totpStep(Date.now())) });
    expect(complete.status).toBe(200);
  }

  /** A token row written straight into the store (minting through the route needs a TOTP step). */
  function seedToken(scopes: ApiTokenScope[]): Record<string, string> {
    const minted = mintApiToken();
    mutateAuthStore((stored) => {
      stored.tokens.push({ id: minted.id, userId: stored.users[0]!.id, name: scopes.join('+'), hash: sha256(minted.value), scopes, createdAt: Date.now() });
    });
    return { authorization: `Bearer ${minted.value}` };
  }

  /** Opens an SSE stream; `next(event)` resolves with the data of the next frame of that event. */
  async function openStream(path: string, headers: Record<string, string>) {
    const response = await request(path, headers);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames: Array<{ event: string; data: string }> = [];
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
          const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join('\n');
          frames.push({ event, data });
        }
      }
    })().catch(() => undefined);
    const first = async (event: string, withinMs = 1_500): Promise<string | undefined> => {
      const until = Date.now() + withinMs;
      while (Date.now() < until) {
        const found = frames.find((frame) => frame.event === event);
        if (found) return found.data;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return undefined;
    };
    return { first, cancel: async () => { await reader.cancel().catch(() => undefined); await pump; } };
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-runview-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-runview-repo-'));
    dataDir = join(repoRoot, '.ai/cezar');
    process.env.CEZ_HOME = home;
    process.env.CEZ_REMOTE = '1';
    delete process.env.CEZ_AUTH;
    delete process.env.CEZ_FOLLOWUPS;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    store = RunStore.open(dataDir, { keepLive: true });
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: 'boot',
      auth: new AuthService({ scrypt: { N: 2 ** 10, r: 8, p: 1 } }),
      ssePingMs: TICK_MS,
    } as Parameters<typeof createApp>[0]) as unknown as Hono;
    await createOwner();
  });

  afterEach(async () => {
    store.flush();
    await removeTempDir(home, repoRoot);
    for (const [key, value] of [
      ['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth], ['CEZ_FOLLOWUPS', saved.followups],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('streams the todo inbox only to a token that sees transcripts', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    for (const path of ['/api/v1/events', '/api/v1/workspace/events']) {
      const reader = await openStream(path, seedToken(['read']));
      expect(await reader.first('ping'), path).toBeDefined();
      expect(todosWatchActive(dataDir), `${path}: read`).toBe(false);
      await reader.cancel();

      const transcript = await openStream(path, seedToken(['read', 'runs.transcript']));
      expect(await transcript.first('ping'), path).toBeDefined();
      expect(todosWatchActive(dataDir), `${path}: runs.transcript`).toBe(true);
      await transcript.cancel();
    }
  });

  it('refuses the handoff and the todo inbox to a read token', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    process.env.CEZ_FOLLOWUPS = '1';
    expect((await request(`/api/v1/runs/${run.id}/handoff`, seedToken(['read']))).status).toBe(403);
    expect((await request('/api/v1/todos', seedToken(['read']))).status).toBe(403);
    expect((await request(`/api/v1/runs/${run.id}/handoff`, seedToken(['runs.transcript']))).status).toBe(200);
    expect((await request('/api/v1/todos', seedToken(['runs.transcript']))).status).toBe(200);
  });
});
