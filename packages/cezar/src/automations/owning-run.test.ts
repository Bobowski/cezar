import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { launchEventCandidate } from './event-poll-cycle.ts';
import type { GithubCandidate } from './github-poller.ts';
import { deliverAutomationMessage, findOwningRun } from './owning-run.ts';
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
      run({ id: 'old-creator', pullRequestUrl: 'https://github.com/acme/demo/pull/8', createdAt: '2026-10-01T00:00:00.000Z' }),
      run({ id: 'newer-about', prNumber: 8, createdAt: '2026-10-02T00:00:00.000Z' }),
      run({ id: 'unrelated', prNumber: 9, createdAt: '2026-10-03T00:00:00.000Z' }),
    ];
    expect(findOwningRun(runs, pr)?.id).toBe('newer-about');
    expect(findOwningRun([runs[0]!, run({ id: 'ref', prRefs: [{ number: 8, origin: 'marker', at: '2026-10-05T00:00:00.000Z' }], createdAt: '2026-10-05T00:00:00.000Z' })], pr)?.id).toBe('ref');
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
