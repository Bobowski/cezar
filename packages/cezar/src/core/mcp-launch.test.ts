import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMcpValue } from '@open-mercato/cezar-contract';
import { loadLaunchMcp, mcpReachOf, privateMcpPath, projectMcpPath, resolveMcpSecrets, type PrivateMcpServer } from './private-mcp.ts';

/** Spec 2026-10-24-easy-mcp §3 "Rendering": project then private, private wins, references resolved at launch. */
describe('launch-time MCP: mcp.json + mcp.local.json', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-mcp-launch-'));
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const write = (path: string, servers: Record<string, unknown>) => writeFileSync(path, JSON.stringify({ mcpServers: servers }));
  const noSecrets = async () => ({ values: {}, notes: [] });

  it('merges project then private, the private entry winning per name', async () => {
    write(projectMcpPath(repo), { shared: { command: 'project-cmd' }, context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } });
    write(privateMcpPath(repo), { shared: { command: 'private-cmd' }, mine: { url: 'https://mcp.example.com/mcp' } });
    const launch = await loadLaunchMcp(repo, noSecrets);
    expect(launch.servers.map((s) => [s.name, s.command ?? s.url])).toEqual([
      ['shared', 'private-cmd'],
      ['context7', 'npx'],
      ['mine', 'https://mcp.example.com/mcp'],
    ]);
    expect(Object.fromEntries(launch.scopes)).toEqual({ shared: 'private', context7: 'project', mine: 'private' });
    expect(launch.problems).toEqual([]);
  });

  it('resolves ${{ secrets.X }} in env, args, url and headers — asking only for the names referenced', async () => {
    write(projectMcpPath(repo), {
      stripe: { type: 'http', url: 'https://mcp.stripe.com/${{ secrets.PATH_PART }}', headers: { Authorization: 'Bearer ${{ secrets.STRIPE_SECRET_KEY }}' } },
      pg: { command: 'uvx', args: ['postgres-mcp', '${{ secrets.DATABASE_URI }}', '\\${{ literal }}'], env: { MODE: 'restricted' } },
    });
    const asked: string[][] = [];
    const launch = await loadLaunchMcp(repo, async (names) => {
      asked.push(names);
      return { values: { STRIPE_SECRET_KEY: 'sk_test_123456789', PATH_PART: 'v1', DATABASE_URI: 'postgresql://u:p@h/db' }, notes: [] };
    });
    expect(asked).toEqual([['PATH_PART', 'STRIPE_SECRET_KEY', 'DATABASE_URI']]);
    expect(launch.servers[0]).toMatchObject({ url: 'https://mcp.stripe.com/v1', headers: { Authorization: 'Bearer sk_test_123456789' } });
    expect(launch.servers[1]).toMatchObject({ args: ['postgres-mcp', 'postgresql://u:p@h/db', '${{ literal }}'], env: { MODE: 'restricted' } });
    expect(launch.secretValues.sort()).toEqual(['postgresql://u:p@h/db', 'sk_test_123456789', 'v1'].sort());
  });

  it('a missing secret skips that one server with a note — never a crash, never the raw reference', async () => {
    write(projectMcpPath(repo), { needs: { command: 'x', env: { KEY: '${{ secrets.ABSENT }}' } }, fine: { command: 'y' } });
    const launch = await loadLaunchMcp(repo, async () => ({ values: {}, notes: ['secret ABSENT is not stored for this project or workspace'] }));
    expect(launch.servers.map((s) => s.name)).toEqual(['fine']);
    expect(launch.problems).toEqual([
      { scope: 'project', name: 'needs', message: 'MCP server "needs" skipped: secret ABSENT is not stored for this project or workspace' },
    ]);
  });

  it('a missing secret is reported by its own name, never by another secret\'s note', async () => {
    write(projectMcpPath(repo), { mine: { command: 'x', env: { KEY: '${{ secrets.MINE }}' } }, other: { command: 'y', env: { K: '${{ secrets.OTHER }}' } } });
    const launch = await loadLaunchMcp(repo, async () => ({ values: {}, notes: ['secret OTHER is not available to cezar (audiences: checks)'] }));
    expect(launch.problems.map((p) => p.message)).toEqual([
      'MCP server "mine" skipped: secret MINE is not stored for this project or workspace',
      'MCP server "other" skipped: secret OTHER is not available to cezar (audiences: checks)',
    ]);
  });

  it('a store-level note explains a missing secret only as what it is', async () => {
    write(projectMcpPath(repo), { mine: { command: 'x', env: { KEY: '${{ secrets.MINE }}' } } });
    const launch = await loadLaunchMcp(repo, async () => ({ values: {}, notes: ['project secrets skipped — the key file is unreadable'] }));
    expect(launch.problems[0]?.message).toBe('MCP server "mine" skipped: secret MINE could not be read — project secrets skipped — the key file is unreadable');
  });

  it('a resolver that throws, or withholds secrets, still leaves the servers without references', async () => {
    write(privateMcpPath(repo), { needs: { command: 'x', env: { KEY: '${{ secrets.K }}' } }, plain: { command: 'y', env: { TOKEN: 'literal' } } });
    const launch = await loadLaunchMcp(repo, async () => {
      throw new Error('store down');
    });
    expect(launch.servers.map((s) => s.name)).toEqual(['plain']);
    expect(launch.problems[0]?.message).toMatch(/needs.*skipped/);
  });

  it('keeps the file-level problems of both files, each with its scope', async () => {
    writeFileSync(projectMcpPath(repo), '{nope');
    write(privateMcpPath(repo), { 'bad name': { command: 'x' } });
    const launch = await loadLaunchMcp(repo, noSecrets);
    expect(launch.problems.map((p) => [p.scope, p.message.split(':')[0]])).toEqual([
      ['project', 'mcp.json is not valid JSON'],
      ['private', 'MCP server "bad name" skipped'],
    ]);
  });

  it('an absent pair of files is no servers and no problems', async () => {
    expect(await loadLaunchMcp(repo, noSecrets)).toMatchObject({ servers: [], problems: [], secretValues: [] });
  });

  it('a resolved url must still be an http(s) url', () => {
    const server: PrivateMcpServer = { name: 's', transport: 'http', url: 'https://${{ secrets.HOST }}', args: [], env: {}, headers: {} };
    expect(resolveMcpSecrets(server, { HOST: 'x"y z' })).toMatchObject({ error: expect.stringMatching(/url/) });
    expect(resolveMcpSecrets(server, { HOST: 'mcp.example.com' })).toMatchObject({ url: 'https://mcp.example.com' });
  });

  it('the reference grammar: only secrets.NAME, escapes kept literal', () => {
    expect(parseMcpValue('Bearer ${{ secrets.A_B }}')).toEqual({ pieces: ['Bearer ', { secret: 'A_B' }] });
    expect(parseMcpValue('\\${{ x }}')).toEqual({ pieces: ['${{ x }}'] });
    expect(parseMcpValue('${{ env.HOME }}')).toHaveProperty('error');
    expect(parseMcpValue('${{ secrets.PATH }}')).toHaveProperty('error');
    expect(parseMcpValue('${{ secrets.OPEN')).toHaveProperty('error');
  });

  it('reach: every runner, with Codex refusing sse and the ACP agents depending on their capabilities', () => {
    const reach = (transport: 'stdio' | 'http' | 'sse') => Object.fromEntries(mcpReachOf(transport).map((r) => [r.runner, r.reach]));
    expect(reach('stdio')).toEqual({ claude: 'yes', codex: 'yes', opencode: 'yes', cursor: 'no', pi: 'no', junie: 'yes', copilot: 'yes' });
    expect(reach('sse')).toMatchObject({ codex: 'no', junie: 'maybe', copilot: 'maybe' });
  });
});
