import { describe, expect, it } from 'vitest';
import { runTrackerCommand } from './tracker-cli.ts';
import { TRACKER_PROMPT } from './workflows/run.ts';

const env = { CEZ_API_URL: 'http://127.0.0.1:4321/', CEZ_PROJECT_ID: 'my project', CEZ_TASK_ID: 'run-1' };
const item = {
  kind: 'issue', id: 'OPS-42', title: 'Repair the deployment', author: 'Ada', createdAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-19T10:00:00.000Z', labels: [], body: 'DESCRIPTION_NOW', bodyTruncated: false, unsupportedContent: false,
  url: 'https://example.atlassian.net/browse/OPS-42', status: 'In Review', statusId: '4', statusCategory: 'started',
};
const comments = { available: true, truncated: false, items: [
  { id: 'c1', author: 'Grace', createdAt: '2026-09-20T10:00:00.000Z', body: 'COMMENT_NOW', bodyTruncated: false, unsupportedContent: false },
] };
const success = { available: true, item, comments, sinceStart: 'changed', statusAtStart: 'To Do' };

function harness(answer: (url: string) => Response | Promise<Response>) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const io = { fetch: (async (input: string | URL | Request) => { urls.push(String(input)); return answer(String(input)); }) as typeof fetch, log: (line: string) => out.push(line), error: (line: string) => err.push(line) };
  return { out, err, urls, io };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('cez tracker issue', () => {
  it('asks the cockpit for the run\'s own ticket and prints it as the untrusted block', async () => {
    const { out, err, urls, io } = harness(() => json(success));
    expect(await runTrackerCommand(['issue', '--current'], env, io)).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:4321/api/v1/p/my%20project/runs/run-1/tracker-issue']);
    const text = out.join('\n');
    expect(text).toContain('title or description CHANGED');
    expect(text).toContain('"To Do" then and is "In Review" now');
    expect(text).toContain('<tracker-ticket>');
    expect(text).toContain('DESCRIPTION_NOW');
    expect(text).toContain('COMMENT_NOW');
    expect(err).toEqual([]);
  });

  it('defaults to the current ticket, reads another by key and can print JSON', async () => {
    const bare = harness(() => json({ ...success, sinceStart: 'unchanged' }));
    expect(await runTrackerCommand(['issue'], env, bare.io)).toBe(0);
    expect(bare.urls[0]!.endsWith('/tracker-issue')).toBe(true);
    expect(bare.out.join('\n')).toContain('are unchanged');

    const other = harness(() => json({ available: true, item: { ...item, id: 'OPS-7' }, comments, sinceStart: 'unknown' }));
    expect(await runTrackerCommand(['issue', 'OPS-7', '--json'], env, other.io)).toBe(0);
    expect(other.urls[0]!.endsWith('/tracker-issue?item=OPS-7')).toBe(true);
    expect(JSON.parse(other.out.join('\n'))).toMatchObject({ item: { id: 'OPS-7' }, sinceStart: 'unknown' });
  });

  it('works without a project id (the boot project)', async () => {
    const { urls, io } = harness(() => json(success));
    await runTrackerCommand(['issue'], { CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_TASK_ID: 'run-1' }, io);
    expect(urls).toEqual(['http://127.0.0.1:4321/api/v1/runs/run-1/tracker-issue']);
  });

  it('exits 2, without calling anything, when it is not inside a cockpit task or is misused', async () => {
    for (const [args, vars] of [
      [['issue'], {}],
      [['issue'], { CEZ_API_URL: 'http://127.0.0.1:4321' }],
      [['issue', 'A-1', 'B-2'], env],
      [['issue', '--current', 'A-1'], env],
      [['issue', '--nope'], env],
      [['comment'], env],
      [[], env],
    ] as const) {
      const { urls, io } = harness(() => json(success));
      expect(await runTrackerCommand([...args], vars, io)).toBe(2);
      expect(urls).toEqual([]);
    }
  });

  it('exits 1 with the cockpit\'s own reason on a refusal, a failed read, a dead cockpit and a foreign answer', async () => {
    const refused = harness(() => json({ error: 'This task is not linked to a tracker ticket.' }, 404));
    expect(await runTrackerCommand(['issue'], env, refused.io)).toBe(1);
    expect(refused.err.join('\n')).toContain('not linked to a tracker ticket');

    const failed = harness(() => json({ available: false, code: 'rate_limited', reason: 'Jira asked us to slow down.' }));
    expect(await runTrackerCommand(['issue'], env, failed.io)).toBe(1);
    expect(failed.err.join('\n')).toContain('Jira asked us to slow down.');
    expect(failed.out).toEqual([]);

    const dead = harness(() => { throw new Error('ECONNREFUSED'); });
    expect(await runTrackerCommand(['issue'], env, dead.io)).toBe(1);

    const foreign = harness(() => json({ hello: 'world' }));
    expect(await runTrackerCommand(['issue'], env, foreign.io)).toBe(1);
    expect(foreign.out).toEqual([]);
  });
});

describe('TRACKER_PROMPT', () => {
  it('names the command through the cockpit\'s own binary and frames the answer as untrusted and read-only', () => {
    expect(TRACKER_PROMPT).toContain('node "$CEZ_BIN" tracker issue --current');
    expect(TRACKER_PROMPT).toContain('untrusted reference data');
    expect(TRACKER_PROMPT).toContain('read-only');
    expect(TRACKER_PROMPT).not.toMatch(/JIRA_API_TOKEN|LINEAR_API_KEY/);
  });
});
