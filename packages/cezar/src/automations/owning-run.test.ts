import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { launchEventCandidate, releaseHeldEvents } from './event-poll-cycle.ts';
import type { GithubCandidate } from './github-poller.ts';
import { deliverAutomationMessage, findOwningRun, forgetGithubSelfLogins, githubSelfLogin } from './owning-run.ts';
import { AutomationStore } from './store.ts';
import { launchAutomationRun } from './task-template.ts';
import type { GithubAutomationDefinition } from './types.ts';

const run = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r', title: 't', workflow: 'quick-task', task: 't', status: 'review', createdAt: '2026-10-01T00:00:00.000Z',
  tokensUsed: 0, steps: [], archived: false, worktreePath: '/wt', ...over,
} as RunRecord);

describe('findOwningRun (spec 2026-10-23-github-events §5)', () => {
  const pr = { repo: 'acme/demo', number: 8 };

  it('picks the newest run that created, references or is about the PR', () => {
    const runs = [
      run({ id: 'old-about', prNumber: 8, createdAt: '2026-10-01T00:00:00.000Z' }),
      run({ id: 'newer-about', prNumber: 8, createdAt: '2026-10-02T00:00:00.000Z' }),
      run({ id: 'unrelated', prNumber: 9, createdAt: '2026-10-03T00:00:00.000Z' }),
    ];
    expect(findOwningRun(runs, pr)?.id).toBe('newer-about');
    expect(findOwningRun([runs[0]!, run({ id: 'ref', prRefs: [{ number: 8, origin: 'marker', at: '2026-10-05T00:00:00.000Z' }], createdAt: '2026-10-05T00:00:00.000Z' })], pr)?.id).toBe('ref');
  });

  it('prefers the run that created the PR over a newer one merely referencing it; a dispatched child never owns', () => {
    const creator = run({ id: 'creator', pullRequestUrl: 'https://github.com/acme/demo/pull/8', createdAt: '2026-10-01T00:00:00.000Z' });
    const refCreator = run({ id: 'ref-creator', prRefs: [{ number: 8, url: 'https://github.com/acme/demo/pull/8', origin: 'created', at: '2026-10-01T00:00:00.000Z' }], createdAt: '2026-10-01T00:00:00.000Z' });
    const reviewer = run({ id: 'reviewer', prNumber: 8, prRefs: [{ number: 8, origin: 'marker', at: '2026-10-04T00:00:00.000Z' }], createdAt: '2026-10-04T00:00:00.000Z' });
    const child = run({ id: 'child', prNumber: 8, createdAt: '2026-10-05T00:00:00.000Z', dispatch: { rootRunId: 'reviewer', parentRunId: 'reviewer' } } as Partial<RunRecord>);
    expect(findOwningRun([creator, reviewer, child], pr)?.id).toBe('creator');
    expect(findOwningRun([refCreator, reviewer], pr)?.id).toBe('ref-creator');
    expect(findOwningRun([reviewer, child], pr)?.id).toBe('reviewer');
    expect(findOwningRun([child], pr)).toBeUndefined();
  });

  it('ignores another repository, pr-head verifiers and runs whose worktree is gone', () => {
    expect(findOwningRun([run({ pullRequestUrl: 'https://github.com/other/demo/pull/8', prNumber: 8 })], pr)).toBeUndefined();
    expect(findOwningRun([run({ prRefs: [{ number: 8, url: 'https://github.com/other/demo/pull/8', origin: 'created', at: '2026-10-01T00:00:00.000Z' }] })], pr)).toBeUndefined();
    expect(findOwningRun([run({ prNumber: 8, prHead: { number: 8, repo: 'acme/demo', headRepo: 'acme/demo', headRef: 'x', headSha: 'a', baseRef: 'main', ref: 'refs/cezar/pr/8' } })], pr)).toBeUndefined();
    expect(findOwningRun([run({ prNumber: 8, worktreePath: undefined })], pr)).toBeUndefined();
    expect(findOwningRun([run({ prNumber: 8, worktreePath: undefined, worktree: false })], pr)?.id).toBe('r');
    expect(findOwningRun([run({ prNumber: 8 })], { repo: 'acme/demo' })).toBeUndefined();
  });
});

describe('deliverAutomationMessage', () => {
  const manager = (over: Partial<Record<keyof RunManager, unknown>>) => ({
    enqueueMessage: () => null,
    hasLiveSession: () => false,
    enqueuePrompt: () => ({ ok: false, error: 'session closed' }),
    deferMessage: () => false,
    continueRun: () => ({ ok: false, error: 'no agent session to resume' }),
    ...over,
  }) as unknown as RunManager;

  it('takes the ladder a person’s message takes', () => {
    expect(deliverAutomationMessage(manager({ enqueueMessage: () => ({ id: 'q' }) }), 'r', 'x')).toEqual({ ok: true, how: 'queued' });
    expect(deliverAutomationMessage(manager({ hasLiveSession: () => true, enqueuePrompt: () => ({ ok: true, delivered: true }) }), 'r', 'x')).toEqual({ ok: true, how: 'live' });
    expect(deliverAutomationMessage(manager({ hasLiveSession: () => true, enqueuePrompt: () => ({ ok: true, delivered: false, message: {} }) }), 'r', 'x')).toEqual({ ok: true, how: 'queued' });
    expect(deliverAutomationMessage(manager({ deferMessage: () => true }), 'r', 'x')).toEqual({ ok: true, how: 'queued' });
    const continueRun = vi.fn(() => ({ ok: true }));
    expect(deliverAutomationMessage(manager({ continueRun }), 'r', 'fix CI')).toEqual({ ok: true, how: 'continued' });
    expect(continueRun).toHaveBeenCalledWith('r', { text: 'fix CI' });
    expect(deliverAutomationMessage(manager({}), 'r', 'x')).toEqual({ ok: false, error: 'no agent session to resume' });
  });
});

describe('deliver: owning-run, end to end through the receipt and the log', () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

  const definition: GithubAutomationDefinition = {
    id: 'ci', revision: 1, name: 'Fix CI', enabled: true, kind: 'github', events: ['check_suite.completed'], intervalSeconds: 300,
    deliver: 'owning-run', filters: { lookbackDays: 7, maxRecords: 25, conclusion: 'failure' },
    task: { prompt: 'CI failed: {{github.check.failedJobs}}', workflow: 'quick-task' },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const candidate: GithubCandidate = {
    eventId: 'acme/demo:check_suite:1:2026-10-02T00:00:00Z', event: 'check_suite.completed', timestamp: '2026-10-02T00:00:00Z',
    tieBreaker: 'suite:1', repo: 'acme/demo', nodeId: 'PR_8', number: 8, title: 'Feature', url: 'https://github.com/acme/demo/pull/8',
    author: 'alice', assignees: [], labels: [], headSha: 'abc',
    check: { id: 1, name: 'GitHub Actions', conclusion: 'failure', url: 'https://ci', failingJobs: ['test'] },
  };

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'cezar-owning-')); dirs.push(root);
    const runs = RunStore.open(join(root, '.ai/cezar'));
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    const started: string[] = [];
    const continued: Array<[string, { text?: string }]> = [];
    const manager = {
      enqueueMessage: () => null, hasLiveSession: () => false, deferMessage: () => false,
      continueRun: (id: string, opts: { text?: string }) => { continued.push([id, opts]); return { ok: true }; },
      startRun: (_workflow: unknown, input: { task: string }) => {
        const created = runs.createRun({ title: 'automation', workflow: 'quick-task', task: input.task, steps: [] });
        started.push(created.id);
        return created;
      },
    } as unknown as RunManager;
    return { root, runs, automations, manager, started, continued };
  }

  it('delivers into the owner and logs delivered-to instead of launched', async () => {
    const { root, runs, automations, manager, started, continued } = await setup();
    const owner = runs.createRun({ title: 'made the PR', workflow: 'quick-task', task: 't', steps: [] });
    runs.updateRun(owner.id, { pullRequestUrl: 'https://github.com/acme/demo/pull/8', worktreePath: join(root, 'wt'), status: 'review' });
    await launchEventCandidate({
      store: automations, definition, receipt: { eventId: candidate.eventId, candidate },
      log: { event: candidate.event, githubNumber: 8 },
      launch: () => launchAutomationRun({ root, manager, store: runs, definition, candidate, receiptId: 'unused' }),
    });
    expect(started).toEqual([]);
    expect(continued).toHaveLength(1);
    expect(continued[0]![0]).toBe(owner.id);
    expect(continued[0]![1].text).toContain('CI failed: test');
    const row = automations.logs({ automationId: 'ci' })[0];
    expect(row).toMatchObject({ result: 'delivered', runId: owner.id, reason: `delivered-to: ${owner.id}` });
    expect(automations.latestReceipts().get(`ci:${candidate.eventId}`)).toMatchObject({ status: 'launched', runId: owner.id, delivered: true });
  });

  it('falls back to a new run when no task owns the PR, and for new-run automations', async () => {
    const { root, runs, automations, manager, started } = await setup();
    await launchEventCandidate({
      store: automations, definition, receipt: { eventId: candidate.eventId, candidate },
      log: { event: candidate.event },
      launch: () => launchAutomationRun({ root, manager, store: runs, definition, candidate, receiptId: 'r' }),
    });
    expect(started).toHaveLength(1);
    expect(automations.logs({ automationId: 'ci' })[0]).toMatchObject({ result: 'launched', runId: started[0] });

    const owner = runs.createRun({ title: 'made the PR', workflow: 'quick-task', task: 't', steps: [] });
    runs.updateRun(owner.id, { prNumber: 8, worktreePath: join(root, 'wt') });
    const plain = await launchAutomationRun({ root, manager, store: runs, definition: { ...definition, deliver: undefined }, candidate, receiptId: 'r2' });
    expect(plain.delivered).toBeUndefined();
    expect(started).toHaveLength(2);
  });

  it('launches a new run, saying why, when the owner cannot take the message', async () => {
    const { root, runs, manager, started } = await setup();
    const owner = runs.createRun({ title: 'made the PR', workflow: 'quick-task', task: 't', steps: [] });
    runs.updateRun(owner.id, { prNumber: 8, worktreePath: join(root, 'wt') });
    (manager as unknown as { continueRun: () => unknown }).continueRun = () => ({ ok: false, error: 'no agent session to resume' });
    const launched = await launchAutomationRun({ root, manager, store: runs, definition, candidate, receiptId: 'r' });
    expect(launched.runId).toBe(started[0]);
    expect(launched.note).toContain('no agent session to resume');
  });
});

describe('owning-run delivery never feeds a run its own reply, nor an unbounded stream (§11)', () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

  const definition: GithubAutomationDefinition = {
    id: 'talk', revision: 1, name: 'Answer reviews', enabled: true, kind: 'github', events: ['pull_request.commented'], intervalSeconds: 300,
    deliver: 'owning-run', filters: { lookbackDays: 7, maxRecords: 2 },
    task: { prompt: 'Answer: {{github.comment.body}}', workflow: 'quick-task' },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const comment = (id: number, author: string, at: Date): GithubCandidate => ({
    eventId: `acme/demo:comment:${id}`, event: 'pull_request.commented', timestamp: at.toISOString(), tieBreaker: `comment:${id}`,
    repo: 'acme/demo', nodeId: 'PR_8', number: 8, title: 'Feature', url: 'https://github.com/acme/demo/pull/8', author: 'alice',
    assignees: [], labels: [], comment: { id, kind: 'issue', author, url: `https://github.com/acme/demo/pull/8#issuecomment-${id}`, body: 'Done — pushed the fix.' },
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'cezar-owning-self-')); dirs.push(root);
    const runs = RunStore.open(join(root, '.ai/cezar'));
    const automations = AutomationStore.open(join(root, '.ai/cezar'));
    const delivered: string[] = [];
    const started: string[] = [];
    const state = { live: false };
    const manager = {
      enqueueMessage: () => null, hasLiveSession: () => false, deferMessage: () => false, isActive: () => state.live,
      continueRun: (_id: string, opts: { text?: string }) => { delivered.push(opts.text ?? ''); return { ok: true }; },
      startRun: () => { const created = runs.createRun({ title: 'stranger', workflow: 'quick-task', task: 't', steps: [] }); started.push(created.id); return created; },
    } as unknown as RunManager;
    const owner = runs.createRun({ title: 'made the PR', workflow: 'quick-task', task: 't', steps: [] });
    runs.updateRun(owner.id, { pullRequestUrl: 'https://github.com/acme/demo/pull/8', worktreePath: join(root, 'wt'), status: 'review', startedAt: new Date().toISOString() });
    const fire = (candidate: GithubCandidate, over: Partial<GithubAutomationDefinition> = {}, selfLogin = async () => 'cezar-bot' as string | undefined) =>
      launchEventCandidate({
        store: automations, definition: { ...definition, ...over }, receipt: { eventId: candidate.eventId, candidate },
        log: { event: candidate.event, githubNumber: 8 },
        launch: (receiptId) => launchAutomationRun({ root, manager, store: runs, definition: { ...definition, ...over }, candidate, receiptId, selfLogin }),
      });
    const lastLog = () => automations.logs({ automationId: definition.id })[0];
    const receiptOf = (id: number) => automations.latestReceipts().get(`${definition.id}:acme/demo:comment:${id}`);
    /** The next poll's pass over the held events, with the traces it would read then. */
    const release = (selfLogin = async () => 'cezar-bot' as string | undefined, own: (candidate: GithubCandidate) => boolean = () => false) =>
      releaseHeldEvents<GithubCandidate>({
        store: automations, definition,
        candidateOf: (receipt) => receipt.candidate as GithubCandidate | undefined,
        log: (candidate) => ({ event: candidate.event, githubNumber: candidate.number }),
        own: async (candidate) => own(candidate),
        launch: (receiptId, candidate, admit) => launchAutomationRun({ root, manager, store: runs, definition, candidate, receiptId, selfLogin, admit }),
      });
    return { runs, automations, owner, delivered, started, state, fire, lastLog, receiptOf, release };
  }

  it('holds a comment by cezar’s own login written during the run’s live turn, and delivers it once the turn ends', async () => {
    const { runs, owner, delivered, started, state, fire, lastLog, receiptOf, release } = await setup();
    // The agent answered through a GitHub MCP tool cezar never parsed: no trace exists.
    state.live = true;
    runs.appendEvent(owner.id, { type: 'turn.started', turnId: 't1' });
    runs.appendEvent(owner.id, { type: 'item.completed', item: { kind: 'tool', id: 'x', name: 'mcp__gh_custom__reply', input: { text: 'Done' }, status: 'completed' } });
    await fire(comment(1, 'Cezar-Bot', new Date()));
    expect(delivered).toEqual([]);
    expect(started).toEqual([]);
    expect(lastLog()).toMatchObject({ result: 'held' });
    expect(lastLog()?.reason).toContain('own-comment');
    expect(receiptOf(1)).toMatchObject({ status: 'held' });
    // An unknown login, during the turn, is held too.
    await fire(comment(2, 'someone', new Date()), {}, async () => undefined);
    expect(lastLog()?.reason).toContain('could not be read');
    // Still working: the next poll leaves both held, and says nothing new.
    const before = lastLog()?.seq;
    await release(async () => undefined);
    expect(delivered).toEqual([]);
    expect(lastLog()?.seq).toBe(before);
    expect(receiptOf(1)).toMatchObject({ status: 'held' });
    // The turn ends with no trace claiming either: a human wrote them after all, and both go in, oldest first.
    runs.appendEvent(owner.id, { type: 'turn.completed', turnId: 't1' });
    await release();
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain('Done — pushed the fix.');
    expect(receiptOf(1)).toMatchObject({ status: 'launched', delivered: true, runId: owner.id });
    expect(lastLog()).toMatchObject({ result: 'delivered', runId: owner.id });
  });

  it('drops a held comment a trace claims meanwhile — the run’s own reply — and never delivers it', async () => {
    const { runs, owner, delivered, state, fire, lastLog, receiptOf, release } = await setup();
    state.live = true;
    runs.appendEvent(owner.id, { type: 'turn.started', turnId: 't1' });
    await fire(comment(3, 'cezar-bot', new Date()));
    expect(receiptOf(3)).toMatchObject({ status: 'held' });
    runs.appendEvent(owner.id, { type: 'turn.completed', turnId: 't1' });
    await release(undefined, (candidate) => candidate.comment?.id === 3);
    expect(delivered).toEqual([]);
    expect(receiptOf(3)).toMatchObject({ status: 'skipped' });
    expect(lastLog()?.reason).toContain('own-trace');
  });

  it('delivers at once a comment by cezar’s login written after the turn ended, though the run is still live', async () => {
    const { runs, owner, delivered, state, fire, lastLog } = await setup();
    state.live = true;
    runs.appendEvent(owner.id, { type: 'turn.started', turnId: 't1' });
    runs.appendEvent(owner.id, { type: 'turn.completed', turnId: 't1' });
    await fire(comment(4, 'cezar-bot', new Date(Date.now() + 5_000)));
    expect(delivered).toHaveLength(1);
    expect(lastLog()).toMatchObject({ result: 'delivered' });
  });

  it('delivers the same login’s comment written well after the run’s last turn, someone else’s at any time, and any with allowSelfComments', async () => {
    const { runs, owner, delivered, fire } = await setup();
    runs.appendEvent(owner.id, { type: 'turn.started', turnId: 't1' });
    runs.appendEvent(owner.id, { type: 'turn.completed', turnId: 't1' });
    await fire(comment(3, 'cezar-bot', new Date(Date.now() + 10 * 60_000)));
    await fire(comment(4, 'dave', new Date()));
    expect(delivered).toHaveLength(2);
  });

  it('decides a collapsed review per comment: one of its comments written in the turn holds the batch', async () => {
    const { runs, owner, delivered, state, fire, lastLog } = await setup();
    state.live = true;
    runs.appendEvent(owner.id, { type: 'turn.started', turnId: 't1' });
    // The batch's own timestamp is an older comment's (edited since); another was written in the turn.
    const earlier = new Date(Date.now() - 60 * 60_000);
    const batch = comment(9, 'cezar-bot', earlier);
    batch.comment!.parts = [{ id: 9, at: earlier.toISOString(), hash: 'b'.repeat(64) }, { id: 10, at: new Date(Date.now() + 1_000).toISOString(), hash: 'a'.repeat(64) }];
    await fire(batch);
    expect(delivered).toEqual([]);
    expect(lastLog()).toMatchObject({ result: 'held' });
  });

  it('allowSelfComments delivers a comment of its own login, during a turn', async () => {
    const { runs, owner, delivered, fire } = await setup();
    runs.appendEvent(owner.id, { type: 'turn.started', turnId: 't1' });
    await fire(comment(5, 'cezar-bot', new Date()), { filters: { ...definition.filters, allowSelfComments: true } });
    expect(delivered).toHaveLength(1);
  });

  it('caps deliveries into one PR’s run at the automation’s maxRecords an hour', async () => {
    const { delivered, started, fire, lastLog } = await setup();
    const later = new Date(Date.now() + 10 * 60_000);
    await fire(comment(6, 'dave', later));
    await fire(comment(7, 'erin', later));
    await fire(comment(8, 'frank', later));
    expect(delivered).toHaveLength(2);
    expect(started).toEqual([]);
    expect(lastLog()).toMatchObject({ result: 'skipped' });
    expect(lastLog()?.reason).toContain('delivery-cap');
  });
});

describe('githubSelfLogin', () => {
  afterEach(() => forgetGithubSelfLogins());

  it('asks again after `gh auth switch` (the gh config changed) and at most ten minutes on', async () => {
    const saved = process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_DRY_RUN;
    try {
      let login = 'alice';
      const calls: string[][] = [];
      const exec = async (command: string, args: string[]) => {
        if (command === 'gh') calls.push(args);
        return command === 'gh' ? { ok: true, stdout: `${login}\n`, stderr: '' } : { ok: false, stdout: '', stderr: '' };
      };
      let stamp = 'mtime-1';
      const now = Date.parse('2026-10-24T10:00:00.000Z');
      expect(await githubSelfLogin('/r', 'acme/demo', exec, now, () => stamp)).toBe('alice');
      expect(await githubSelfLogin('/r', 'acme/demo', exec, now + 60_000, () => stamp)).toBe('alice');
      expect(calls).toHaveLength(1);
      login = 'bob';
      stamp = 'mtime-2';
      expect(await githubSelfLogin('/r', 'acme/demo', exec, now + 2 * 60_000, () => stamp)).toBe('bob');
      expect(calls).toHaveLength(2);
      login = 'carol';
      expect(await githubSelfLogin('/r', 'acme/demo', exec, now + 9 * 60_000, () => stamp)).toBe('bob');
      expect(await githubSelfLogin('/r', 'acme/demo', exec, now + 13 * 60_000, () => stamp)).toBe('carol');
      expect(calls).toHaveLength(3);
    } finally {
      if (saved === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = saved;
    }
  });

  it('asks gh once per host and gh config, never keeps a failure long, and never runs dry', async () => {
    const saved = process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_DRY_RUN;
    try {
      const calls: string[][] = [];
      let answer = { ok: true, stdout: 'cezar-bot\n', stderr: '' };
      const exec = async (command: string, args: string[]) => {
        if (command === 'gh') calls.push(args);
        return command === 'gh' ? answer : { ok: false, stdout: '', stderr: '' };
      };
      const now = Date.parse('2026-10-24T10:00:00.000Z');
      const stamp = () => 'same';
      expect(await githubSelfLogin('/r', 'acme/demo', exec, now, stamp)).toBe('cezar-bot');
      expect(await githubSelfLogin('/r', 'acme/demo', exec, now + 5 * 60_000, stamp)).toBe('cezar-bot');
      expect(calls).toEqual([['api', 'user', '--jq', '.login']]);
      answer = { ok: false, stdout: '', stderr: 'HTTP 401' };
      expect(await githubSelfLogin('/r', 'acme/other', exec, now + 11 * 60_000, stamp)).toBeUndefined();
      answer = { ok: true, stdout: 'ops-user\n', stderr: '' };
      expect(await githubSelfLogin('/r', 'acme/other', exec, now + 12 * 60_000 + 1_000, stamp)).toBe('ops-user');
      process.env.CEZ_DRY_RUN = '1';
      expect(await githubSelfLogin('/r', 'acme/third', exec, now, stamp)).toBeUndefined();
      expect(calls).toHaveLength(3);
    } finally {
      if (saved === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = saved;
    }
  });
});
