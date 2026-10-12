import { describe, expect, it, vi } from 'vitest';
import { runTokenAllows } from '../auth/run-tokens.ts';
import { runServiceCommand } from './cli.ts';

const io = (answer: { status?: number; body: unknown }) => {
  const out: string[] = [];
  const err: string[] = [];
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 }));
  return { out, err, fetchMock, io: { fetch: fetchMock as unknown as typeof fetch, log: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
};
const ENV = { CEZ_API_URL: 'http://127.0.0.1:4321/', CEZ_PROJECT_ID: 'shop' };
const service = { id: 'api-1', name: 'api', command: 'yarn run dev', cwd: 'app', status: 'running', exitCode: null, reason: null, startedAt: 'x', urls: [{ url: 'http://localhost:9000', lastSeenAt: 'x', running: true }], topic: null };

describe('cez service (spec 2026-10-11-project-services §4)', () => {
  it('lists services with their state and says whose code they run', async () => {
    const t = io({ body: { available: true, reason: null, services: [service, { ...service, id: 'w', name: 'web', status: 'exited', exitCode: 1, urls: [] }], candidates: [], lastRunning: [], topic: 't' } });
    expect(await runServiceCommand(['list'], ENV, t.io)).toBe(0);
    expect(String(t.fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4321/api/v1/p/shop/services');
    expect(t.out[0]).toBe('api\trunning\tyarn run dev  (in app)\thttp://localhost:9000');
    expect(t.out[1]).toContain('web\texited (code 1)');
    expect(t.out.at(-1)).toContain('main checkout');
  });

  it('reads a tail of one service\'s logs, marked untrusted', async () => {
    const t = io({ body: { name: 'api', status: 'running', exitCode: null, logs: 'ready\n' } });
    expect(await runServiceCommand(['logs', 'api', '--tail', '50'], ENV, t.io)).toBe(0);
    expect(String(t.fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4321/api/v1/p/shop/services/api/logs?tail=50');
    expect(t.out).toEqual(['[api: running — untrusted output follows]', 'ready\n']);
  });

  it('has no write subcommand, and reports the cockpit\'s refusal', async () => {
    const t = io({ status: 409, body: { error: 'services are disabled on this cockpit' } });
    expect(await runServiceCommand(['start', 'api'], ENV, t.io)).toBe(2);
    expect(t.fetchMock).not.toHaveBeenCalled();
    expect(await runServiceCommand(['list'], ENV, t.io)).toBe(1);
    expect(t.err.at(-1)).toBe('cez service: services are disabled on this cockpit');
    expect(await runServiceCommand(['logs'], ENV, t.io)).toBe(2);
    expect(await runServiceCommand(['list'], {}, t.io)).toBe(2);
  });

  it('a task\'s credential is admitted to the two reads and to no lifecycle route', () => {
    const claims = { runId: 'r1', projectId: 'shop' } as Parameters<typeof runTokenAllows>[0];
    expect(runTokenAllows(claims, 'GET', '/api/v1/p/shop/services')).toBe(true);
    expect(runTokenAllows(claims, 'GET', '/api/v1/p/shop/services/api/logs')).toBe(true);
    for (const [method, path] of [['POST', '/services'], ['POST', '/services/api/start'], ['POST', '/services/api/stop'], ['POST', '/services/start-all'], ['GET', '/services/api/output'], ['POST', '/services/api/input'], ['DELETE', '/services/api']] as const) {
      expect(runTokenAllows(claims, method, `/api/v1/p/shop${path}`), `${method} ${path}`).toBe(false);
    }
  });
});
