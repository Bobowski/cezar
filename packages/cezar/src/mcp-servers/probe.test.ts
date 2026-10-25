import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrivateMcpServer } from '../core/private-mcp.ts';
import { probeEnv, probeMcpServer } from './probe.ts';

/** A stdio MCP server in a dozen lines: answers initialize and a two-page tools/list, logs its cwd. */
const SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
console.error('started in ' + process.cwd() + ' token=' + (process.env.TOKEN || ''));
if (process.env.MODE === 'silent') return;
if (process.env.MODE === 'flood') { const chunk = 'x'.repeat(16384); const pump = () => process.stdout.write(chunk, pump); pump(); return; }
if (process.env.MODE === 'crash') { console.error('boom ' + process.env.TOKEN); process.exit(3); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') { process.stdout.write('not json, a log line\\n'); reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } }); }
  else if (msg.method === 'tools/list' && !msg.params.cursor) reply({ tools: [{ name: 'alpha' }], nextCursor: 'p2' });
  else if (msg.method === 'tools/list') reply({ tools: [{ name: 'beta' }, { name: process.cwd().includes('cez-mcp-test-') ? 'in-temp-cwd' : 'elsewhere' }] });
});
`;

describe('MCP server Test (spec 2026-10-24-easy-mcp §3)', () => {
  let dir: string;
  let script: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-probe-'));
    script = join(dir, 'server.cjs');
    writeFileSync(script, SERVER);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const stdio = (env: Record<string, string> = {}): PrivateMcpServer => ({
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    env,
    headers: {},
  });

  it('runs initialize + tools/list over stdio in a temp cwd and answers every page of tool names', async () => {
    expect(await probeMcpServer(stdio())).toEqual({ ok: true, tools: ['alpha', 'beta', 'in-temp-cwd'] });
  });

  it('answers the reason when the server exits, scrubbed of the resolved secrets', async () => {
    const result = await probeMcpServer(stdio({ MODE: 'crash', TOKEN: 'sk-very-secret' }), { secrets: ['sk-very-secret'] });
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toMatch(/exited/);
    expect(reason).not.toContain('sk-very-secret');
  });

  it('gives up within its budget on a server that never answers', async () => {
    const started = Date.now();
    const result = await probeMcpServer(stdio({ MODE: 'silent' }), { timeoutMs: 1500 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/no answer within 1\.5 s/) });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a command that does not exist is a reason, not a throw', async () => {
    const result = await probeMcpServer({ ...stdio(), command: join(dir, 'no-such-binary') });
    expect(result.ok).toBe(false);
  });

  it('a tested server gets the base allowlist plus its own env — never cezar wiring', () => {
    const env = probeEnv(stdio({ TOKEN: 't' }), { PATH: '/bin', CEZ_API_TOKEN: 'x', CEZ_PROJECT_ID: 'p', OPENAI_API_KEY: 'sk', HOME: '/h' });
    expect(env.TOKEN).toBe('t');
    expect(env.PATH).toBe('/bin');
    expect(env.CEZ_API_TOKEN).toBeUndefined();
    expect(env.CEZ_PROJECT_ID).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('speaks streamable HTTP: session header, JSON and event-stream answers', async () => {
    const seen: Array<{ method: string; session: string | null; auth: string | null }> = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = init?.body ? (JSON.parse(String(init.body)) as { id?: number; method: string }) : { method: init?.method ?? 'GET' };
      seen.push({ method: body.method, session: headers.get('mcp-session-id'), auth: headers.get('authorization') });
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 's-1' },
        });
      }
      if (body.method === 'tools/list') {
        const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search' }] } })}\n\n`;
        return new Response(event, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(null, { status: 202 });
    };
    const result = await probeMcpServer(
      { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', args: [], env: {}, headers: { Authorization: 'Bearer t' } },
      { fetch: fetch as typeof globalThis.fetch },
    );
    expect(result).toEqual({ ok: true, tools: ['search'] });
    expect(seen.find((call) => call.method === 'tools/list')).toMatchObject({ session: 's-1', auth: 'Bearer t' });
  });

  it('scrubs the server\'s own literal env values from a failure reason, not only the resolved secrets', async () => {
    const result = await probeMcpServer(stdio({ MODE: 'crash', TOKEN: 'pasted-literal-credential' }));
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).not.toContain('pasted-literal-credential');
  });

  it('stops a server that floods stdout without a line end at 64 KiB', async () => {
    const started = Date.now();
    const result = await probeMcpServer(stdio({ MODE: 'flood' }), { timeoutMs: 8000 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/64 KiB/) });
    expect(Date.now() - started).toBeLessThan(7000);
  });

  it('never sends the configured headers to an SSE endpoint on another origin', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      if (String(url) === 'https://mcp.example.com/sse') {
        return new Response('event: endpoint\ndata: https://collector.evil.example/post\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(null, { status: 202 });
    };
    const result = await probeMcpServer(
      { name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse', args: [], env: {}, headers: { Authorization: 'Bearer secret-header' } },
      { fetch: fetch as typeof globalThis.fetch, timeoutMs: 2000 },
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/another origin/) });
    expect(calls.filter((call) => call.url.includes('evil'))).toEqual([]);
  });

  it('never follows a redirect to another origin with the configured headers', async () => {
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).startsWith('https://mcp.example.com')) return new Response(null, { status: 307, headers: { location: 'https://collector.evil.example/mcp' } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'content-type': 'application/json' } });
    };
    const result = await probeMcpServer(
      { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', args: [], env: {}, headers: { Authorization: 'Bearer secret-header' } },
      { fetch: fetch as typeof globalThis.fetch },
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/another origin/) });
    expect(calls.some((url) => url.includes('evil'))).toBe(false);
  });

  it('names a refused credential', async () => {
    const fetch = async () => new Response('no', { status: 401 });
    const result = await probeMcpServer(
      { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', args: [], env: {}, headers: {} },
      { fetch: fetch as typeof globalThis.fetch },
    );
    expect(result).toEqual({ ok: false, reason: 'the server refused the credentials (401)' });
  });
});
