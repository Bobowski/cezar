import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commentIdsIn, githubTracesOf, mergeTraces, POSTED_COMMENTS_CAP, PUSHED_SHAS_CAP, toolTraces } from './github-traces.ts';
import { RunStore } from './store.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');

describe('github traces (spec 2026-10-23-github-events §6)', () => {
  it('reads conversation and review comment ids out of URLs', () => {
    expect(commentIdsIn('https://github.com/a/b/pull/8#issuecomment-123\nhttps://github.com/a/b/pull/8#discussion_r456')).toEqual([123, 456]);
    expect(commentIdsIn('https://github.com/a/b/pull/8')).toEqual([]);
  });

  it('mines only commands that POST a comment, and spots a git push', () => {
    const output = 'https://github.com/a/b/pull/8#issuecomment-9';
    expect(toolTraces({ input: { command: 'gh pr comment 8 --body "done"' }, output, status: 'completed' })).toEqual({ pushed: false, comments: [9] });
    expect(toolTraces({ input: { command: 'gh api -X POST repos/a/b/pulls/8/comments -f body=x' }, output: '{"html_url":"https://github.com/a/b/pull/8#discussion_r11"}' }).comments).toEqual([11]);
    // Reading comments posts nothing: the URLs it prints are other people's.
    expect(toolTraces({ input: { command: 'gh api repos/a/b/issues/8/comments' }, output }).comments).toEqual([]);
    expect(toolTraces({ input: { command: 'gh pr view 8 --comments' }, output }).comments).toEqual([]);
    expect(toolTraces({ input: { command: 'git add -A && git commit -m x && git push' } }).pushed).toBe(true);
    expect(toolTraces({ input: { command: ['git', '-C', 'dir', 'push', 'origin', 'HEAD'] } }).pushed).toBe(true);
    expect(toolTraces({ input: { command: 'echo git-push-helper' } }).pushed).toBe(false);
    // A failed call left nothing behind.
    expect(toolTraces({ input: { command: 'git push' }, status: 'failed' }).pushed).toBe(false);
  });

  it('deduplicates and caps, newest last', () => {
    const shas = Array.from({ length: PUSHED_SHAS_CAP + 5 }, (_, n) => sha(n + 1));
    const merged = mergeTraces({}, { shas: [...shas, shas[0]!], comments: [1, 1, 2] });
    expect(merged?.pushedShas).toHaveLength(PUSHED_SHAS_CAP);
    expect(merged?.pushedShas?.at(-1)).toBe(shas.at(-1));
    expect(merged?.postedComments).toEqual([1, 2]);
    expect(mergeTraces({ pushedShas: [sha(1)], postedComments: [1] }, { shas: [sha(1).toUpperCase()], comments: [1] })).toBeUndefined();
    expect(mergeTraces({}, { shas: ['not-a-sha'] })).toBeUndefined();
    const many = mergeTraces({}, { comments: Array.from({ length: POSTED_COMMENTS_CAP + 1 }, (_, n) => n + 1) });
    expect(many?.postedComments?.[0]).toBe(2);
  });

  it('collects every run of a project into one set', () => {
    const traces = githubTracesOf([{ pushedShas: [sha(1)] }, { postedComments: [5] }, {}]);
    expect([...traces.shas]).toEqual([sha(1)]);
    expect([...traces.comments]).toEqual([5]);
  });
});

describe('RunStore.recordGithubTraces', () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

  it('persists the traces on the record, and a record without them still parses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    expect(store.getRun(run.id)?.pushedShas).toBeUndefined();
    store.recordGithubTraces(run.id, { shas: [sha(7)], comments: [42] });
    store.flush({ throwOnError: true });
    const reopened = RunStore.open(dir);
    expect(reopened.getRun(run.id)).toMatchObject({ pushedShas: [sha(7)], postedComments: [42] });
  });
});
