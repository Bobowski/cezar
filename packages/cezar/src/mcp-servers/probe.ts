import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { McpServerTestResponse } from '@open-mercato/cezar-contract';
import { buildChildEnv } from '../core/agent-env.ts';
import type { PrivateMcpServer } from '../core/private-mcp.ts';
import { redactSecrets } from '../core/secret-redaction.ts';
import { spawnableCommand } from '../core/windows-shim.ts';

/**
 * Settings → MCP servers → Test (spec `2026-10-24-easy-mcp` §3, §5): run the server once —
 * `initialize`, then `tools/list` — within one budget, and answer its tool names. The one place
 * cezar talks to an MCP server itself. stdio servers run as the cezar user in a fresh temp cwd,
 * with a least-privilege env plus their own resolved `env`; http and sse servers get one
 * short-lived session. Never throws: every failure is `{ ok: false, reason }`, redacted of the
 * resolved secret values.
 */

export const MCP_TEST_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = '2025-06-18';
const MAX_PAGES = 5;
const STDERR_TAIL = 2000;

export interface ProbeOptions {
  timeoutMs?: number;
  /** The host env the least-privilege base is drawn from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Values to scrub from a failure reason (the resolved secrets). */
  secrets?: readonly string[];
}

type JsonRpcMessage = { jsonrpc?: string; id?: number | string; result?: unknown; error?: { message?: string } };

const initializeRequest = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cezar', version: '1' } },
});

function toolNames(result: unknown): { names: string[]; cursor?: string } {
  const r = result as { tools?: Array<{ name?: unknown }>; nextCursor?: unknown } | null;
  const names = (r?.tools ?? []).map((tool) => tool?.name).filter((name): name is string => typeof name === 'string');
  return typeof r?.nextCursor === 'string' && r.nextCursor ? { names, cursor: r.nextCursor } : { names };
}

function rpcFailure(message: JsonRpcMessage, method: string): string | null {
  return message.error ? `${method} failed: ${message.error.message ?? 'error'}` : null;
}

/** Run the handshake against `server`. */
export async function probeMcpServer(server: PrivateMcpServer, options: ProbeOptions = {}): Promise<McpServerTestResponse> {
  const timeoutMs = options.timeoutMs ?? MCP_TEST_TIMEOUT_MS;
  const secrets = (options.secrets ?? []).filter((value) => value.length >= 4);
  const scrub = (text: string) => redactSecrets(text, secrets);
  try {
    const result =
      server.transport === 'stdio'
        ? await probeStdio(server, timeoutMs, options.env ?? process.env)
        : server.transport === 'http'
          ? await probeHttp(server, timeoutMs, options.fetch ?? fetch)
          : await probeSse(server, timeoutMs, options.fetch ?? fetch);
    return result.ok ? result : { ok: false, reason: scrub(result.reason) };
  } catch (error) {
    return { ok: false, reason: scrub((error as Error).message || 'the test failed') };
  }
}

// ---- stdio -------------------------------------------------------------------------------

/** A bare Windows command (`npx`) as the file PATH resolves it to, so a `.cmd` shim can be unwrapped. */
function resolveCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32' || isAbsolute(command) || extname(command) || command.includes('/') || command.includes('\\')) return command;
  const extensions = (env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, command + extension.toLowerCase());
      try {
        accessSync(candidate, constants.F_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return command;
}

/** The env a tested stdio server starts with: the agents' base allowlist, no cezar wiring, plus its own. */
export function probeEnv(server: PrivateMcpServer, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = buildChildEnv({ backend: 'junie', source });
  for (const name of Object.keys(base)) {
    const upper = name.toUpperCase();
    if (upper.startsWith('CEZ_') || upper.startsWith('JUNIE_')) delete base[name];
  }
  return { ...base, ...server.env };
}

/** Kill the server and what it spawned (`npx` → node → the server); resolves once that was asked. */
function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((done) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => done()));
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return Promise.resolve();
}

async function probeStdio(server: PrivateMcpServer, timeoutMs: number, source: NodeJS.ProcessEnv): Promise<McpServerTestResponse> {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-mcp-test-'));
  const env = probeEnv(server, source);
  const [file, argv] = spawnableCommand(resolveCommand(server.command!, env), server.args);
  let killed: Promise<void> = Promise.resolve();
  try {
    return await new Promise<McpServerTestResponse>((resolve) => {
      let settled = false;
      let stderr = '';
      let buffer = '';
      const pending = new Map<number, (message: JsonRpcMessage) => void>();
      const child = spawn(file, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      const finish = (result: McpServerTestResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killed = killTree(child.pid);
        resolve(result);
      };
      const tail = () => (stderr.trim() ? `: ${stderr.trim().slice(-STDERR_TAIL)}` : '');
      const timer = setTimeout(() => finish({ ok: false, reason: `no answer within ${timeoutMs / 1000} s${tail()}` }), timeoutMs);
      child.on('error', (error) => finish({ ok: false, reason: `could not start ${server.command}: ${error.message}` }));
      // `close`, not `exit`: stdout is drained by then, so a last answer is never lost to the race.
      child.on('close', (code, signal) => finish({ ok: false, reason: `the server exited (${signal ?? `code ${code}`}) before answering${tail()}` }));
      child.stdin.on('error', () => {});
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL * 2);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: JsonRpcMessage;
          try {
            message = JSON.parse(line) as JsonRpcMessage;
          } catch {
            continue; // a server's own log line on stdout
          }
          if (typeof message.id === 'number') pending.get(message.id)?.(message);
        }
      });
      const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`);
      const request = (id: number, payload: unknown) =>
        new Promise<JsonRpcMessage>((answer) => {
          pending.set(id, answer);
          send(payload);
        });
      void (async () => {
        const init = await request(1, initializeRequest(1));
        const initFailed = rpcFailure(init, 'initialize');
        if (initFailed) return finish({ ok: false, reason: initFailed });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const tools: string[] = [];
        let cursor: string | undefined;
        for (let page = 0, id = 2; page < MAX_PAGES; page += 1, id += 1) {
          const listed = await request(id, { jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} });
          const listFailed = rpcFailure(listed, 'tools/list');
          if (listFailed) return finish({ ok: false, reason: listFailed });
          const next = toolNames(listed.result);
          tools.push(...next.names);
          if (!next.cursor) break;
          cursor = next.cursor;
        }
        finish({ ok: true, tools });
      })();
    });
  } finally {
    await killed;
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

// ---- http and sse ------------------------------------------------------------------------

/** Server-sent events from a response body, one `{ event, data }` per blank-line-terminated block. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readRpcResponse(res: Response, id: number): Promise<JsonRpcMessage> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream') && res.body) {
    for await (const { data } of sseEvents(res.body)) {
      try {
        const message = JSON.parse(data) as JsonRpcMessage;
        if (message.id === id) return message;
      } catch {
        // not JSON-RPC
      }
    }
    throw new Error('the stream ended before the answer');
  }
  return (await res.json()) as JsonRpcMessage;
}

async function probeHttp(server: PrivateMcpServer, timeoutMs: number, fetchImpl: typeof fetch): Promise<McpServerTestResponse> {
  const signal = AbortSignal.timeout(timeoutMs);
  let session: string | null = null;
  let version = PROTOCOL_VERSION;
  const post = async (payload: unknown) => {
    const res = await fetchImpl(server.url!, {
      method: 'POST',
      signal,
      headers: {
        ...server.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
        'mcp-protocol-version': version,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 202) {
      await res.body?.cancel().catch(() => {});
      throw new Error(res.status === 401 || res.status === 403 ? `the server refused the credentials (${res.status})` : `the server answered ${res.status}`);
    }
    return res;
  };
  try {
    const initRes = await post(initializeRequest(1));
    session = initRes.headers.get('mcp-session-id');
    const init = await readRpcResponse(initRes, 1);
    const initFailed = rpcFailure(init, 'initialize');
    if (initFailed) return { ok: false, reason: initFailed };
    const negotiated = (init.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (typeof negotiated === 'string') version = negotiated;
    const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await ack.body?.cancel().catch(() => {});
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0, id = 2; page < MAX_PAGES; page += 1, id += 1) {
      const listed = await readRpcResponse(await post({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} }), id);
      const listFailed = rpcFailure(listed, 'tools/list');
      if (listFailed) return { ok: false, reason: listFailed };
      const next = toolNames(listed.result);
      tools.push(...next.names);
      if (!next.cursor) break;
      cursor = next.cursor;
    }
    return { ok: true, tools };
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: `no answer within ${timeoutMs / 1000} s` };
    return { ok: false, reason: (error as Error).message };
  } finally {
    if (session) {
      void fetchImpl(server.url!, { method: 'DELETE', headers: { ...server.headers, 'mcp-session-id': session } }).then(
        (res) => res.body?.cancel(),
        () => {},
      );
    }
  }
}

/** The legacy HTTP+SSE transport: a GET stream that names a POST endpoint, answers on the stream. */
async function probeSse(server: PrivateMcpServer, timeoutMs: number, fetchImpl: typeof fetch): Promise<McpServerTestResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(server.url!, { headers: { ...server.headers, accept: 'text/event-stream' }, signal: controller.signal });
    if (!res.ok || !res.body) return { ok: false, reason: `the server answered ${res.status}` };
    const events = sseEvents(res.body);
    const next = async () => {
      const item = await events.next();
      if (item.done) throw new Error('the stream ended before the answer');
      return item.value;
    };
    let endpoint: string | null = null;
    while (!endpoint) {
      const event = await next();
      if (event.event === 'endpoint') endpoint = new URL(event.data.trim(), server.url).toString();
    }
    const post = async (payload: unknown) => {
      const sent = await fetchImpl(endpoint!, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...server.headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await sent.body?.cancel().catch(() => {});
      if (!sent.ok) throw new Error(`the server answered ${sent.status}`);
    };
    const answer = async (id: number) => {
      for (;;) {
        const event = await next();
        if (event.event !== 'message') continue;
        try {
          const message = JSON.parse(event.data) as JsonRpcMessage;
          if (message.id === id) return message;
        } catch {
          // not JSON-RPC
        }
      }
    };
    await post(initializeRequest(1));
    const init = await answer(1);
    const initFailed = rpcFailure(init, 'initialize');
    if (initFailed) return { ok: false, reason: initFailed };
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0, id = 2; page < MAX_PAGES; page += 1, id += 1) {
      await post({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} });
      const listed = await answer(id);
      const listFailed = rpcFailure(listed, 'tools/list');
      if (listFailed) return { ok: false, reason: listFailed };
      const page_ = toolNames(listed.result);
      tools.push(...page_.names);
      if (!page_.cursor) break;
      cursor = page_.cursor;
    }
    return { ok: true, tools };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: `no answer within ${timeoutMs / 1000} s` };
    return { ok: false, reason: (error as Error).message };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
