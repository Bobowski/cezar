import type { Readable, Writable } from 'node:stream';
import { PROTOCOL_VERSION_META_KEY, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * `cezar mcp` — the catalog over stdio for a client that launches a command (spec
 * 2026-10-24-cezar-mcp-server §3). It is a transport bridge, not a second server: every JSON-RPC
 * message goes to the cockpit's own `/api/v1/mcp` and every answer comes back, so stdio and HTTP
 * serve one catalog and one guard. The endpoint is stateless, which is what lets a bridge this
 * small carry both protocol eras without understanding either.
 */

export interface BridgeTarget {
  /** The MCP endpoint, `?tools=` included. */
  endpoint: string;
  /** Sent as `Bearer`: a token from `--token`/`CEZ_TOKEN`, or this host's key toward a local cockpit. */
  credential?: string;
}

export interface BridgeIo {
  stdin: Readable;
  stdout: Writable;
  fetch: typeof fetch;
  /** Diagnostics go to stderr: stdout is the protocol. */
  error: (line: string) => void;
}

type Message = JSONRPCMessage & { id?: string | number; method?: string; params?: { _meta?: Record<string, unknown> }; result?: { protocolVersion?: unknown } };

/** `data:` lines of an SSE body, each one JSON-RPC message. */
export function sseMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (data.trim() === '') continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // a keepalive or a frame that is not ours
    }
  }
  return messages;
}

function errorFor(message: Message, text: string): JSONRPCMessage | null {
  if (message.id === undefined || message.method === undefined) return null;
  return { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } } as JSONRPCMessage;
}

export async function runMcpBridge(target: BridgeTarget, io: BridgeIo): Promise<void> {
  const transport = new StdioServerTransport(io.stdin, io.stdout);
  /** The revision a 2025-era handshake settled on, for the header every later request carries. */
  let negotiated: string | undefined;

  const forward = async (message: Message): Promise<void> => {
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
    if (target.credential) headers.set('authorization', `Bearer ${target.credential}`);
    const version = message.params?._meta?.[PROTOCOL_VERSION_META_KEY];
    if (typeof version === 'string') headers.set('mcp-protocol-version', version);
    else if (negotiated && message.method !== 'initialize') headers.set('mcp-protocol-version', negotiated);
    let response: Response;
    try {
      response = await io.fetch(target.endpoint, { method: 'POST', headers, body: JSON.stringify(message) });
    } catch (error) {
      const reply = errorFor(message, `no cezar cockpit answered at ${target.endpoint} (${(error as Error).message}) — start it with \`cezar\`, or point --server at one`);
      if (reply) await transport.send(reply);
      return;
    }
    const type = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let replies: unknown[] = [];
    if (type.includes('text/event-stream')) replies = sseMessages(text);
    else if (text.trim() !== '') {
      try {
        const parsed = JSON.parse(text) as unknown;
        replies = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        replies = [];
      }
    }
    const rpc = replies.filter((reply): reply is Message => typeof reply === 'object' && reply !== null && (reply as { jsonrpc?: unknown }).jsonrpc === '2.0');
    if (rpc.length === 0 && !response.ok) {
      // Not JSON-RPC: the guard or a proxy answered (401, 403, 502…). Say so to the waiting request.
      const reason = (() => {
        try {
          return (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          return text;
        }
      })();
      const reply = errorFor(message, `cezar answered ${response.status}: ${reason.slice(0, 500)}`);
      if (reply) await transport.send(reply);
      return;
    }
    for (const reply of rpc) {
      if (message.method === 'initialize' && typeof reply.result?.protocolVersion === 'string') negotiated = reply.result.protocolVersion;
      await transport.send(reply as JSONRPCMessage);
    }
  };

  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  transport.onerror = (error) => io.error(`cezar mcp: ${error.message}`);
  transport.onmessage = (message) => {
    void forward(message as Message).catch((error: unknown) => io.error(`cezar mcp: ${(error as Error).message}`));
  };
  await transport.start();
  await closed;
}
