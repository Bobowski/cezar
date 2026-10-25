import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableRunTokens, enableRunTokens, mintChatRunToken, mintRunToken, runTokenAllows, verifyRunToken } from './run-tokens.ts';

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

/** Spec 2026-10-24-cockpit-chat §5: the chat's MCP token is `author` on its own project, never `admin`. */
describe('chat run tokens', () => {
  beforeEach(disableRunTokens);
  afterEach(disableRunTokens);

  it('is minted with sign-in off, carries its scope, and does not switch task tokens on', () => {
    const token = mintChatRunToken('chat-1', 'proj');
    expect(verifyRunToken(token)).toEqual({ runId: 'chat-1', projectId: 'proj', scope: 'author' });
    // A task's environment stays byte-for-byte what it was while auth is off.
    expect(mintRunToken('run-1', 'proj')).toBeUndefined();
    const [payload] = token.slice('cezrun_'.length).split('.');
    const forged = Buffer.from(JSON.stringify(['chat-1', 'proj', 'admin'])).toString('base64url');
    expect(verifyRunToken(token.replace(payload!, forged))).toBeNull();
  });

  const chat = { runId: 'chat-1', projectId: 'proj', scope: 'author' as const };

  it.each([
    ['POST', '/api/v1/mcp'],
    ['GET', '/api/v1/mcp'],
    ['GET', '/api/v1/projects'],
    ['GET', '/api/v1/p/proj/runs'],
    ['POST', '/api/v1/p/proj/runs'],
    ['GET', '/api/v1/p/proj/runs/r9/history'],
    ['POST', '/api/v1/p/proj/runs/r9/messages'],
    ['POST', '/api/v1/p/proj/workflows'],
    ['DELETE', '/api/v1/p/proj/workflows/w1'],
    ['POST', '/api/v1/p/proj/automations'],
    ['GET', '/api/v1/p/proj/repo/changes'],
    ['GET', '/api/v1/p/proj/runs/r9/files'],
    ['GET', '/api/v1/automation-checks/c1'],
    // Paths and variable NAMES only.
    ['GET', '/api/v1/p/proj/env-files'],
  ])('allows %s %s', (method, path) => {
    expect(runTokenAllows(chat, method, path)).toBe(true);
  });

  it.each([
    ['GET', '/api/v1/p/other/runs', 'another project'],
    ['POST', '/api/v1/runs', 'the boot alias'],
    ['POST', '/api/v1/p/proj/repo/push', 'pushing the checkout (admin)'],
    ['POST', '/api/v1/p/proj/repo/commit', 'committing the checkout (admin)'],
    ['POST', '/api/v1/p/proj/runs/r9/git/push', 'pushing a task'],
    ['POST', '/api/v1/p/proj/runs/r9/pr', 'opening a PR'],
    ['POST', '/api/v1/p/proj/runs/r9/pr/adopt', 'adopting a PR'],
    ['POST', '/api/v1/p/proj/runs/r9/land', 'landing'],
    ['POST', '/api/v1/p/proj/runs/r9/finish', 'Finish, which can land'],
    ['PUT', '/api/v1/p/proj/runs/r9/files', 'writing a task\'s files'],
    ['POST', '/api/v1/p/proj/runs/r9/terminal', 'a terminal'],
    ['PUT', '/api/v1/p/proj/config', 'project config (admin)'],
    ['PUT', '/api/v1/agent-config/claude', 'agent config'],
    ['GET', '/api/v1/workspace/dashboard', 'the workspace, which spans projects'],
    ['GET', '/api/v1/auth/tokens', 'sign-in and tokens'],
    ['GET', '/api/v1/p/proj/env-files/content', 'an env file\'s values'],
    ['POST', '/api/v1/p/proj/env-files/render', 'a rendered env file'],
    ['POST', '/api/v1/p/proj/env-files/rerender', 'rewriting env files'],
    ['PUT', '/api/v1/p/proj/env-files', 'writing an env file'],
    ['DELETE', '/api/v1/p/proj/env-files', 'deleting an env file'],
    ['GET', '/api/v1/p/proj/secrets', 'the secret store'],
    ['PUT', '/api/v1/p/proj/secrets/X', 'a secret'],
    ['GET', '/api/v1/p/proj/tracker/connection', 'the tracker credentials'],
    ['PUT', '/api/v1/p/proj/tracker/connection', 'the tracker credentials'],
  ])('refuses %s %s (%s)', (method, path) => {
    expect(runTokenAllows(chat, method, path)).toBe(false);
  });
});
