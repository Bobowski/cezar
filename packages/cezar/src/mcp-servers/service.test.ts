import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpServersListSchema } from '@open-mercato/cezar-contract';
import { privateMcpPath, projectMcpPath } from '../core/private-mcp.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { deleteMcpServer, putMcpServer } from './files.ts';
import { listMcpServers } from './service.ts';
import { recordMcpLaunch } from './status.ts';

describe('Settings → MCP servers files and listing (spec 2026-10-24-easy-mcp)', () => {
  let repo: string;
  let home: string;
  let secrets: SecretStore;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-mcp-servers-'));
    home = mkdtempSync(join(tmpdir(), 'cez-mcp-servers-home-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    secrets = new SecretStore({ CEZ_HOME: home }, { keychain: async () => null });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('writes one entry and keeps every other key of the file', async () => {
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(projectMcpPath(repo), JSON.stringify({ note: 'mine', mcpServers: { keep: { command: 'keep-mcp' } } }));
    expect(await putMcpServer(repo, 'project', 'docs', { type: 'http', url: 'https://mcp.example.com/mcp' })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(projectMcpPath(repo), 'utf8'))).toEqual({
      note: 'mine',
      mcpServers: { keep: { command: 'keep-mcp' }, docs: { type: 'http', url: 'https://mcp.example.com/mcp' } },
    });
    expect(await deleteMcpServer(repo, 'project', 'keep')).toEqual({ ok: true });
    expect(await deleteMcpServer(repo, 'project', 'keep')).toMatchObject({ ok: false, status: 404 });
    expect(Object.keys(JSON.parse(readFileSync(projectMcpPath(repo), 'utf8')).mcpServers)).toEqual(['docs']);
  });

  it('refuses to overwrite a file that is not JSON', async () => {
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(privateMcpPath(repo), '{broken');
    expect(await putMcpServer(repo, 'private', 'x', { command: 'x' })).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(privateMcpPath(repo), 'utf8')).toBe('{broken');
  });

  it('mcp.json is committable and mcp.local.json is git-ignored (0600) from their first write', async () => {
    await putMcpServer(repo, 'project', 'context7', { command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
    await putMcpServer(repo, 'private', 'stripe', { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer ${{ secrets.STRIPE_SECRET_KEY }}' } });
    expect(() => execFileSync('git', ['check-ignore', '-q', projectMcpPath(repo)], { cwd: repo })).toThrow();
    execFileSync('git', ['check-ignore', '-q', privateMcpPath(repo)], { cwd: repo }); // throws when not ignored
    if (process.platform !== 'win32') expect(statSync(privateMcpPath(repo)).mode & 0o777).toBe(0o600);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('.ai/cezar/mcp.json');
    expect(status).toContain('.ai/cezar/.gitignore');
    expect(status).not.toContain('mcp.local.json');
    expect(status).not.toContain('cez-tmp');
  });

  it('lists both files: literal values hidden, references shown, missing secrets, shadowing, reach, status', async () => {
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(
      projectMcpPath(repo),
      JSON.stringify({
        mcpServers: {
          shared: { command: 'npx', args: ['-y', 'shared-mcp'], env: { API_KEY: '${{ secrets.SHARED_KEY }}', MODE: 'fast' } },
          legacy: { type: 'sse', url: 'https://sse.example.com/sse' },
          'bad name': { command: 'x' },
        },
      }),
    );
    writeFileSync(privateMcpPath(repo), JSON.stringify({ mcpServers: { shared: { command: 'mine', env: { TOKEN: 'pasted-literal-token' } } } }));
    await secrets.set({ kind: 'project', projectId: 'demo', root: repo }, 'SHARED_KEY', 'checks-only-value', ['checks']);
    await recordMcpLaunch(repo, { runId: 'run-1', runner: 'claude' }, [{ scope: 'private', name: 'shared', state: 'injected' }]);

    const list = await listMcpServers(repo, { secrets, project: { projectId: 'demo', root: repo }, editable: true });
    expect(mcpServersListSchema.safeParse(list).success).toBe(true);
    expect(JSON.stringify(list)).not.toContain('pasted-literal-token');
    const shared = list.project.find((server) => server.name === 'shared')!;
    expect(shared.env).toEqual([
      { key: 'API_KEY', value: '${{ secrets.SHARED_KEY }}' },
      { key: 'MODE', value: null },
    ]);
    // Stored, but for check steps only: cezar cannot read it, so the launch would skip the server.
    expect(shared.missingSecrets).toEqual(['SHARED_KEY']);
    expect(shared.shadowed).toBe(true);
    expect(list.private[0]).toMatchObject({ name: 'shared', shadowed: false, env: [{ key: 'TOKEN', value: null }], status: { state: 'injected', runId: 'run-1' } });
    const legacy = list.project.find((server) => server.name === 'legacy')!;
    expect(legacy.reach.find((reach) => reach.runner === 'codex')).toMatchObject({ reach: 'no' });
    expect(legacy.reach.find((reach) => reach.runner === 'claude')).toMatchObject({ reach: 'yes' });
    expect(legacy.reach.find((reach) => reach.runner === 'cursor')).toMatchObject({ reach: 'no' });
    expect(list.problems.project).toHaveLength(1);
    expect(list.catalog.length).toBeGreaterThan(10);

    await secrets.set({ kind: 'project', projectId: 'demo', root: repo }, 'SHARED_KEY', 'now-for-cezar-too', ['checks', 'cezar']);
    const again = await listMcpServers(repo, { secrets, project: { projectId: 'demo', root: repo }, editable: false });
    expect(again.project.find((server) => server.name === 'shared')!.missingSecrets).toEqual([]);
    expect(again.editable).toBe(false);
  });

  it('redacts credential-shaped args and url parts unless the caller may see them raw', async () => {
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(
      privateMcpPath(repo),
      JSON.stringify({
        mcpServers: {
          cli: { command: 'db-mcp', args: ['--api-key', 'literal-api-key-value', '--token=literal-token-value', 'postgresql://u:literal-db-password@db/x', '--read-only', '--key', '${{ secrets.DB_KEY }}'] },
          remote: { type: 'http', url: 'https://user:literal-userinfo@mcp.example.com/mcp?api_key=literal-query-key&region=eu' },
        },
      }),
    );
    const literals = ['literal-api-key-value', 'literal-token-value', 'literal-db-password', 'literal-userinfo', 'literal-query-key'];
    const redacted = await listMcpServers(repo, { secrets, editable: true });
    const text = JSON.stringify(redacted);
    for (const literal of literals) expect(text, literal).not.toContain(literal);
    const cli = redacted.private.find((server) => server.name === 'cli')!;
    expect(cli.args).toEqual(['--api-key', '[REDACTED]', '--token=[REDACTED]', 'postgresql://***@db/x', '--read-only', '--key', '${{ secrets.DB_KEY }}']);
    expect(redacted.private.find((server) => server.name === 'remote')!.url).toBe('https://***@mcp.example.com/mcp?api_key=[REDACTED]&region=eu');

    const raw = await listMcpServers(repo, { secrets, editable: true, raw: true });
    for (const literal of literals) expect(JSON.stringify(raw), literal).toContain(literal);
  });
});
