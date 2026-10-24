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
import { registerProject } from '../workspace/projects.ts';
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

  // Not token-shaped: the store's own scrubber (CEZ_REDACT_SECRETS) must not be what hides it.
  const SECRET = 'MARKER-the-agent-printed-this';

  /** A run carrying agent-authored text in every field the projection strips. */
  function seedRun() {
    const run = store.createRun({ title: 'fix the build', workflow: 'quick-task', task: 'fix the build', steps: [] });
    store.updateRun(run.id, {
      titleSummary: `Title quoting ${SECRET}`,
      branch: 'cez/abc',
      prNumber: 12,
      tokensUsed: 345,
      graphState: { loops: { review: 1 }, taken: ['a.done->b'], cursor: 'b', outputs: { a: { summary: `printed ${SECRET}`, verdict: 'pass', costUsd: 0.1 } } },
      dispatch: {
        rootRunId: run.id,
        budgetUsd: 2,
        report: { status: 'done', result: `done, key ${SECRET}`, evidence: [], side_effects: [], errors: [], suggestions: [] },
        pendingReports: [{ fromRunId: 'c1', title: 'child', at: '2026-10-24T00:00:00Z', report: { status: 'done', result: SECRET, evidence: [], side_effects: [], errors: [], suggestions: [] } }],
        pendingAsk: { questions: [`may I use ${SECRET}?`], askedAt: '2026-10-24T00:00:00Z' },
      },
    });
    return run.id;
  }

  function expectProjected(body: Record<string, unknown>, label: string) {
    expect(JSON.stringify(body), label).not.toContain(SECRET);
    expect(body.projected, label).toBe(true);
    expect(body.titleSummary, label).toBeUndefined();
    expect(body.graphState, label).toEqual({ loops: { review: 1 }, taken: ['a.done->b'], cursor: 'b' });
    expect(body.dispatch, label).toEqual({ rootRunId: body.id, budgetUsd: 2 });
    // Status, timing, counters, branch and PR stay.
    expect(body, label).toMatchObject({ status: 'queued', branch: 'cez/abc', prNumber: 12, tokensUsed: 345, title: 'fix the build' });
    expect(body.createdAt, label).toBeTypeOf('string');
  }

  function expectFull(body: Record<string, unknown>, label: string) {
    expect(body.projected, label).toBeUndefined();
    expect(body.titleSummary, label).toBe(`Title quoting ${SECRET}`);
    expect(JSON.stringify(body.graphState), label).toContain(SECRET);
    expect(JSON.stringify(body.dispatch), label).toContain(SECRET);
  }

  it('GET /runs/:id and GET /runs answer a read token the projected record', async () => {
    const id = seedRun();
    const read = seedToken(['read']);
    const one = await request(`/api/v1/runs/${id}`, read);
    expect(one.status).toBe(200);
    expectProjected((await one.json()) as Record<string, unknown>, 'GET /runs/:id');
    const list = await request('/api/v1/p/boot/runs', read);
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expectProjected(rows[0]!, 'GET /runs');
  });

  // Guard: passes with and without the fix — whoever sees transcripts keeps the whole record.
  it('answers the full record to the owner and to a token that sees transcripts', async () => {
    const id = seedRun();
    for (const [label, headers] of [
      ['runs.transcript', seedToken(['read', 'runs.transcript'])],
      ['tasks', seedToken(['tasks'])],
      ['admin', seedToken(['admin'])],
    ] as const) {
      const response = await request(`/api/v1/runs/${id}`, headers);
      expect(response.status, label).toBe(200);
      expectFull((await response.json()) as Record<string, unknown>, label);
    }
  });

  it('reduces every failure a read token sees to a one-line kind, without the output', async () => {
    const run = store.createRun({ title: 'land it', workflow: 'quick-task', task: 'land it', steps: [] });
    // What a failed required check leaves on the record: the command's whole output (landing.ts).
    const printed = `npm test printed the token ${SECRET}`;
    store.updateRun(run.id, {
      status: 'failed',
      error: `step "check" failed: ${printed}`,
      steps: [
        { id: 'task', name: 'Task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0, error: `agent said ${printed}` },
        { id: 'check', name: 'Check', kind: 'check', status: 'failed', iterations: 1, tokensUsed: 0, error: `exit 1\n${printed}` },
        { id: 'next', name: 'Next', kind: 'agent', status: 'pending', iterations: 0, tokensUsed: 0 },
      ],
      landing: { status: 'failed', at: '2026-10-24T00:00:00Z', stage: 'checks', error: `required check \`npm test\` failed:\n${printed}` },
    });
    const read = seedToken(['read']);
    const one = (await (await request(`/api/v1/runs/${run.id}`, read)).json()) as Record<string, unknown>;
    const [row] = (await (await request('/api/v1/runs', read)).json()) as Array<Record<string, unknown>>;
    for (const [label, body] of [['GET /runs/:id', one], ['GET /runs', row!]] as const) {
      expect(JSON.stringify(body), label).not.toContain(SECRET);
      expect(body.error, label).toBe('failed');
      expect(body.landing, label).toEqual({ status: 'failed', at: '2026-10-24T00:00:00Z', stage: 'checks', error: 'required check failed' });
      expect((body.steps as Array<Record<string, unknown>>).map((step) => step.error), label).toEqual(['failed', 'check failed', undefined]);
    }
    // Guard: whoever sees transcripts keeps the output.
    const full = (await (await request(`/api/v1/runs/${run.id}`, seedToken(['read', 'runs.transcript']))).json()) as Record<string, unknown>;
    expect(JSON.stringify(full.landing)).toContain(SECRET);
    expect(full.error).toContain(SECRET);
  });

  it('GET /groups/:groupId leaves the agent-written handoff excerpt to a token that sees transcripts', async () => {
    const run = store.createRun({ title: 'variant', workflow: 'quick-task', task: 'variant', steps: [], groupId: 'g1', variant: 'A' });
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(join(dataDir, 'runs', `${run.id}.handoff.md`), `# Handoff\n\n## Progress log\n- wrote ${SECRET}\n`, 'utf8');
    const projected = (await (await request('/api/v1/groups/g1', seedToken(['read']))).json()) as { runs: Array<Record<string, unknown>> };
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    expect(projected.runs[0]).not.toHaveProperty('handoffExcerpt');
    expect(projected.runs[0]).toMatchObject({ id: run.id, variant: 'A', status: 'queued' });
    // Guard: the owner's comparison view keeps it.
    const full = (await (await request('/api/v1/groups/g1', seedToken(['read', 'runs.transcript']))).json()) as { runs: Array<Record<string, unknown>> };
    expect(full.runs[0]!.handoffExcerpt).toBe(`- wrote ${SECRET}`);
  });

  it('the workspace runs index and the dashboard carry no agent-written title or failure output for a read token', async () => {
    await registerProject(repoRoot);
    const now = new Date().toISOString();
    const review = store.createRun({ title: 'review me', workflow: 'quick-task', task: 'review me', steps: [] });
    store.updateRun(review.id, { status: 'review', titleSummary: `Summary quoting ${SECRET}`, startedAt: now, finishedAt: now });
    const failed = store.createRun({ title: 'broke', workflow: 'quick-task', task: 'broke', steps: [] });
    store.updateRun(failed.id, {
      status: 'failed', titleSummary: `Summary ${SECRET}`, startedAt: now, finishedAt: now,
      error: `step "check" failed: printed ${SECRET}`,
      steps: [{ id: 'check', name: 'Check', kind: 'check', status: 'failed', iterations: 1, tokensUsed: 0, error: `exit 1: ${SECRET}` }],
    });
    store.flush();
    const read = seedToken(['read']);
    const get = async (path: string, headers: Record<string, string>) => {
      const response = await request(path, headers);
      expect(response.status, path).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    const snapshot = await get('/api/v1/workspace/dashboard', read);
    for (const path of [
      '/api/v1/workspace/runs-index',
      '/api/v1/workspace/dashboard',
      `/api/v1/workspace/dashboard/tasks?snapshotId=${snapshot.snapshotId as string}&group=reviews`,
      '/api/v1/workspace/dashboard/overview?group=failed',
      '/api/v1/workspace/dashboard/overview?group=needs-you',
      '/api/v1/workspace/dashboard/feed',
      '/api/v1/workspace/dashboard/insights',
    ]) {
      const body = JSON.stringify(await get(path, read));
      expect(body, path).not.toContain(SECRET);
    }
    expect(JSON.stringify(snapshot)).toContain('review me');
    const index = await get('/api/v1/workspace/runs-index', read);
    expect((index.runs as Array<Record<string, unknown>>).map((row) => row.title).sort()).toEqual(['broke', 'review me']);
    const insights = await get('/api/v1/workspace/dashboard/insights', read);
    expect(JSON.stringify(insights)).toContain('broke');
    // Guard: the owner's views keep the summary and the failure text.
    const full = seedToken(['read', 'runs.transcript']);
    expect(JSON.stringify(await get('/api/v1/workspace/runs-index', full))).toContain(SECRET);
    expect(JSON.stringify(await get('/api/v1/workspace/dashboard', full))).toContain(SECRET);
    expect(JSON.stringify(await get('/api/v1/workspace/dashboard/insights', full))).toContain(SECRET);
  });

  it('a dispatched child’s title and task — the parent agent’s words — are projected everywhere', async () => {
    await registerProject(repoRoot);
    const now = new Date().toISOString();
    const root = store.createRun({ title: 'the user’s own task', workflow: 'quick-task', task: 'the user’s own task', steps: [] });
    const children = ['review', 'failed'].map((status) => {
      const child = store.createRun({
        title: `child ${SECRET}`,
        workflow: '(planned)',
        task: `objective naming ${SECRET}`,
        steps: [],
      });
      store.updateRun(child.id, {
        status: status as 'review' | 'failed', startedAt: now, finishedAt: now, costUsd: 0.5,
        steps: [{ id: 'task', name: `child ${SECRET}`, kind: 'agent', status: status === 'failed' ? 'failed' : 'done', iterations: 1, tokensUsed: 0 }],
        workflowDef: { name: '(planned)', source: 'built-in', steps: [{ id: 'task', name: `child ${SECRET}`, prompt: '{{task}}' }] },
        dispatch: { rootRunId: root.id, parentRunId: root.id },
        promptQueue: [{ id: 'q1', text: `parent says ${SECRET}`, createdAt: now }],
      });
      return child.id;
    });
    store.updateRun(root.id, { dispatch: { rootRunId: root.id } });
    store.flush();
    const read = seedToken(['read']);
    const get = async (path: string) => {
      const response = await request(path, read);
      expect(response.status, path).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    const one = await get(`/api/v1/runs/${children[0]!}`);
    expect(one).toMatchObject({ title: `dispatched task ${children[0]!}`, task: `dispatched task ${children[0]!}`, projected: true });
    expect((await get(`/api/v1/runs/${root.id}`)).task).toBe('the user’s own task');
    const index = await get('/api/v1/workspace/runs-index');
    expect((index.runs as Array<Record<string, unknown>>).map((row) => row.title).sort()).toEqual(
      ['the user’s own task', ...children.map((id) => `dispatched task ${id}`)].sort(),
    );
    for (const path of [
      '/api/v1/runs',
      '/api/v1/workspace/runs-index',
      '/api/v1/workspace/dashboard',
      '/api/v1/workspace/dashboard/overview?group=needs-you',
      '/api/v1/workspace/dashboard/overview?group=failed',
      '/api/v1/workspace/dashboard/insights',
      '/api/v1/workspace/dashboard/costs',
      '/api/v1/workspace/dashboard/feed',
    ]) {
      expect(JSON.stringify(await get(path)), path).not.toContain(SECRET);
    }
    expect(JSON.stringify(await get('/api/v1/workspace/dashboard/insights'))).toContain(`dispatched task ${children[1]!}`);
    // Guard: the owner sees what the parent wrote.
    const full = await request(`/api/v1/runs/${children[0]!}`, seedToken(['read', 'runs.transcript']));
    expect(((await full.json()) as Record<string, unknown>).title).toBe(`child ${SECRET}`);
  });

  it('projects the run events of both live streams for a read token', async () => {
    const id = seedRun();
    for (const path of ['/api/v1/events', '/api/v1/workspace/events']) {
      const read = await openStream(path, seedToken(['read']));
      const full = await openStream(path, seedToken(['read', 'runs.transcript']));
      expect(await read.first('ping')).toBeDefined();
      expect(await full.first('ping')).toBeDefined();
      store.updateRun(id, { tokensUsed: 345 });
      const projected = await read.first('run');
      const whole = await full.first('run');
      await read.cancel();
      await full.cancel();
      expect(projected, path).toBeDefined();
      expectProjected(JSON.parse(projected!) as Record<string, unknown>, path);
      expectFull(JSON.parse(whole!) as Record<string, unknown>, path);
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
