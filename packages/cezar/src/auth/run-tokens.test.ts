import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableRunTokens, enableRunTokens, mintRunToken, runTokenAllows, verifyRunToken } from './run-tokens.ts';

describe('run tokens', () => {
  beforeEach(disableRunTokens);
  afterEach(disableRunTokens);

  it('mints nothing until auth is enforced, so an agent environment is unchanged', () => {
    expect(mintRunToken('run-1', 'proj')).toBeUndefined();
    expect(verifyRunToken('cezrun_x.y')).toBeNull();
  });

  it('round-trips its claims and rejects a forged or foreign token', () => {
    enableRunTokens();
    const token = mintRunToken('run-1', 'proj')!;
    expect(verifyRunToken(token)).toEqual({ runId: 'run-1', projectId: 'proj' });
    expect(verifyRunToken(mintRunToken('run-2')!)).toEqual({ runId: 'run-2' });
    const [payload] = token.slice('cezrun_'.length).split('.');
    const other = Buffer.from(JSON.stringify(['run-9', 'proj'])).toString('base64url');
    expect(verifyRunToken(token.replace(payload!, other))).toBeNull();
    expect(verifyRunToken(`${token}x`)).toBeNull();
    disableRunTokens();
    enableRunTokens(); // a restart: new key
    expect(verifyRunToken(token)).toBeNull();
  });

  const claims = { runId: 'run-1', projectId: 'proj' };

  it.each([
    ['GET', '/api/v1/p/proj/runs'],
    ['POST', '/api/v1/p/proj/runs/run-1/dispatch'],
    ['POST', '/api/v1/p/proj/runs/run-1/report'],
    ['GET', '/api/v1/p/proj/runs/run-1/tracker-issue'],
    ['POST', '/api/v1/p/proj/automations'],
    ['PUT', '/api/v1/p/proj/automations/a1'],
    ['POST', '/api/v1/p/proj/automations/a1/check'],
    ['GET', '/api/v1/p/proj/tracker/automation-options'],
    ['GET', '/api/v1/automation-checks/c1'],
  ])('allows what the agent CLIs call: %s %s', (method, path) => {
    expect(runTokenAllows(claims, method, path)).toBe(true);
  });

  it.each([
    ['POST', '/api/v1/p/proj/runs', 'starting a task outside dispatch'],
    ['POST', '/api/v1/p/proj/runs/run-2/dispatch', 'another run'],
    ['GET', '/api/v1/p/other/runs', 'another project'],
    ['GET', '/api/v1/runs', 'the boot alias, which may be another project'],
    ['GET', '/api/v1/p/proj/runs/run-1/files', 'a route no CLI uses'],
    ['POST', '/api/v1/p/proj/terminal', 'the terminal'],
    ['PUT', '/api/v1/agent-config/claude', 'agent config'],
    ['GET', '/api/v1/health', 'health'],
    ['GET', '/api/v1/p/proj/automations/a1/extra/deep', 'a deeper path'],
    ['GET', '/api/v1/p/%E0%A4%A/runs', 'a malformed project id'],
  ])('refuses %s %s (%s)', (method, path) => {
    expect(runTokenAllows(claims, method, path)).toBe(false);
  });

  it('a run with no project id may use the unscoped alias, and only that', () => {
    expect(runTokenAllows({ runId: 'run-1' }, 'GET', '/api/v1/runs')).toBe(true);
    expect(runTokenAllows({ runId: 'run-1' }, 'GET', '/api/v1/p/proj/runs')).toBe(false);
  });
});
