import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commentFingerprint, commentIdsIn, githubTracesOf, isOwnTrace, isPushCommand, mergeTraces, POSTED_BODIES_CAP, POSTED_COMMENTS_CAP, postingCommentBody, pushedRefsIn, PUSHED_SHAS_CAP, settlePush, toolTraces } from './github-traces.ts';
import { RunStore } from './store.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

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
    // A failed push left nothing behind.
    expect(toolTraces({ input: { command: 'git push' }, status: 'failed' }).pushed).toBe(false);
  });

  it('reads the body a comment-posting command is about to send, before it runs', async () => {
    const run = (command: string, cwd?: string) => postingCommentBody({ command }, cwd);
    expect(run('gh pr comment 8 --body "Fixed the \\"typo\\"." && git push')).toBe('Fixed the "typo".');
    expect(run("gh issue comment 3 -b 'single quoted'")).toBe('single quoted');
    expect(run('gh pr comment 8 --body=plain')).toBe('plain');
    expect(run("gh pr comment 8 --body \"$(cat <<'EOF'\nLine one.\n\nLine \"two\".\nEOF\n)\" && git push")).toBe('Line one.\n\nLine "two".');
    expect(run("gh pr comment 8 --body-file - <<'EOF'\nfrom stdin\nEOF")).toBe('from stdin');
    expect(run("gh api -X POST repos/a/b/issues/8/comments -f body='api body'")).toBe('api body');
    expect(run('gh api --method POST repos/a/b/pulls/8/comments --raw-field body="review note" -f path=x')).toBe('review note');
    const dir = await mkdtemp(join(tmpdir(), 'cezar-body-')); dirs.push(dir);
    await writeFile(join(dir, 'note.md'), 'from a file\n');
    expect(run('gh pr comment 8 -F note.md', dir)).toBe('from a file\n');
    expect(run('gh api -X POST repos/a/b/issues/8/comments -F body=@note.md', dir)).toBe('from a file\n');
    // Reading comments posts nothing.
    expect(run('gh api repos/a/b/issues/8/comments')).toBeUndefined();
    expect(run('gh pr view 8 --comments')).toBeUndefined();
    expect(run('git push')).toBeUndefined();
  });

  it('keeps the comment of a call that failed after posting it (gh comment && git push)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    const input = { command: 'gh pr comment 8 --body "Pushed the fix." && git push' };
    // Fingerprinted as the call STARTS, so a poll running meanwhile already knows it.
    store.notePostingComment(run.id, postingCommentBody(input)!);
    const failed = { input, status: 'failed', output: 'https://github.com/a/b/pull/8#issuecomment-9\nerror: failed to push some refs' };
    expect(toolTraces(failed)).toEqual({ pushed: false, comments: [9] });
    store.recordGithubTraces(run.id, { comments: toolTraces(failed).comments });
    const traces = store.githubTraces();
    expect(isOwnTrace({ event: 'pull_request.commented', comment: { id: 9, body: 'Pushed the fix.' } }, traces)).toBe(true);
    // Matched by body alone too: the id never printed (or the output was lost).
    expect(isOwnTrace({ event: 'pull_request.commented', comment: { id: 10, body: 'Pushed the fix.\r\n' } }, traces)).toBe(true);
  });

  it('reads what a push really pushed off its output', () => {
    const out = [
      'To github.com:acme/demo.git',
      '   1a2b3c4..5d6e7f8  main -> main',
      ' + 0a0b0c0...9f9e9d9 cez/abc -> cez/abc (forced update)',
      ' * [new branch]      cez/new -> cez/new',
      ' * [new tag]         v1 -> v1',
      ' ! [rejected]        other -> other (non-fast-forward)',
    ].join('\n');
    expect(pushedRefsIn(out)).toEqual({ refs: ['5d6e7f8', '9f9e9d9', 'cez/new'], upToDate: false });
    expect(pushedRefsIn('Everything up-to-date\n')).toEqual({ refs: [], upToDate: true });
    expect(pushedRefsIn('')).toEqual({ refs: [], upToDate: false });
  });

  it('settles a push: the shas it pushed, the start-time HEAD dropped when it was not one of them', async () => {
    const resolve = async (refs: readonly string[]) => refs.map((ref) => (ref === '5d6e7f8' ? sha(2) : sha(3)));
    const head = async () => sha(4);
    const committedThenPushed = { input: { command: 'git commit -am x && git push' }, status: 'completed', output: '   1a2b3c4..5d6e7f8  main -> main' };
    // HEAD at the call's start was the commit BEFORE `git commit`: not what was pushed.
    expect(await settlePush({ provisional: sha(1), item: committedThenPushed, resolve, head })).toEqual({ add: [sha(2)], drop: sha(1) });
    expect(await settlePush({ provisional: sha(2), item: committedThenPushed, resolve, head })).toEqual({ add: [sha(2)] });
    // A failed push, or one that pushed nothing, leaves no trace.
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, status: 'failed', output: 'error: failed to push some refs' }, resolve, head })).toEqual({ add: [], drop: sha(1) });
    // A push that worked inside a call that failed later (`git push && false`) still counts.
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, status: 'failed' }, resolve, head })).toEqual({ add: [sha(2)], drop: sha(1) });
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, output: 'Everything up-to-date' }, resolve, head })).toEqual({ add: [], drop: sha(1) });
    // An output that names nothing (a backend that drops stderr): HEAD as the call left it.
    expect(await settlePush({ provisional: sha(1), item: { ...committedThenPushed, output: '' }, resolve, head })).toEqual({ add: [sha(4)], drop: sha(1) });
    expect(await settlePush({ item: { ...committedThenPushed, output: undefined }, resolve, head })).toEqual({ add: [sha(4)] });
  });

  it('drops a pushed sha from the record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.recordGithubTraces(run.id, { shas: [sha(1), sha(2)] });
    store.dropPushedSha(run.id, sha(1).toUpperCase());
    expect(store.getRun(run.id)?.pushedShas).toEqual([sha(2)]);
  });

  it('knows a push as it starts, and its own events by sha, id or the body being posted', () => {
    expect(isPushCommand({ command: 'git commit -am x && git push origin HEAD' })).toBe(true);
    expect(isPushCommand({ command: 'git status' })).toBe(false);
    expect(commentFingerprint('Done.\r\n\nSee  above ')).toBe(commentFingerprint('Done. See above'));
    // The poller keeps a body with these stripped; its fingerprint must still match the posted one.
    expect(commentFingerprint('Do​ne.‮ ﻿See')).toBe(commentFingerprint('Done. See'));
    const traces = { shas: new Set([sha(1)]), comments: new Set([5]), bodies: new Set([commentFingerprint('posting now')]) };
    expect(isOwnTrace({ event: 'push', headSha: sha(1).toUpperCase() }, traces)).toBe(true);
    expect(isOwnTrace({ event: 'check_suite.completed', headSha: sha(1) }, traces)).toBe(true);
    expect(isOwnTrace({ event: 'check_suite.completed', headSha: sha(1) }, traces, true)).toBe(false);
    expect(isOwnTrace({ event: 'pull_request.commented', headSha: sha(1), comment: { id: 6, body: 'a human' } }, traces)).toBe(false);
    expect(isOwnTrace({ event: 'pull_request.commented', comment: { id: 5 } }, traces)).toBe(true);
    expect(isOwnTrace({ event: 'issue.commented', comment: { id: 7, body: 'posting  now' } }, traces)).toBe(true);
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

  it('keeps the body of a comment being posted on the record for 24 hours, across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-traces-')); dirs.push(dir);
    const store = RunStore.open(dir);
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    store.notePostingComment(run.id, 'Fixed in the latest push.', now);
    store.flush({ throwOnError: true });
    const reopened = RunStore.open(dir);
    const own = { event: 'pull_request.commented', comment: { id: 9, body: 'Fixed in  the latest push.\r\n' } };
    expect(isOwnTrace(own, reopened.githubTraces(now + 60 * 60_000))).toBe(true);
    expect(isOwnTrace(own, reopened.githubTraces(now + 23 * 60 * 60_000))).toBe(true);
    // Past the day, the same words are a human's.
    expect(isOwnTrace(own, reopened.githubTraces(now + 25 * 60 * 60_000))).toBe(false);
  });

  it('bounds the kept bodies and drops expired ones when it adds', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    const old = { hash: 'a'.repeat(64), at: new Date(now - 25 * 60 * 60_000).toISOString() };
    const patch = mergeTraces({ postedCommentBodies: [old] }, { bodies: ['b'.repeat(64)] }, now);
    expect(patch?.postedCommentBodies).toEqual([{ hash: 'b'.repeat(64), at: new Date(now).toISOString() }]);
    const many = mergeTraces({}, { bodies: Array.from({ length: POSTED_BODIES_CAP + 3 }, (_, n) => n.toString(16).padStart(64, '0')) }, now);
    expect(many?.postedCommentBodies).toHaveLength(POSTED_BODIES_CAP);
  });
});
