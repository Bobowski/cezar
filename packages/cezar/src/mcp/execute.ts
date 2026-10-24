import type { CatalogTool } from './catalog.ts';

/**
 * A tool call is a request to its route (spec 2026-10-24-cezar-mcp-server §5: "a tool is a
 * route"). It goes back through the whole app — origin guard, auth guard, the route's own
 * validators — with the caller's credential, so a scope is enforced by the server, never by
 * which tools the client was shown.
 */

/** Sends one request into the cockpit and answers its response. */
export type Dispatch = (request: Request) => Promise<Response>;

export interface CallContext {
  dispatch: Dispatch;
  /** Scheme and authority the internal request is addressed to (the MCP request's own). */
  origin: string;
  /** The caller's credential and provenance, copied onto every internal request. */
  headers: Headers;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  [key: string]: unknown;
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A tool answer stays readable in a client's context: past this, the text is cut and says so. */
const TEXT_LIMIT = 200_000;

const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function clip(text: string): string {
  return text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT)}\n… [${text.length - TEXT_LIMIT} more characters cut — narrow the request]`;
}

function queryValue(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(queryValue);
  return [typeof value === 'object' ? JSON.stringify(value) : String(value)];
}

/**
 * A path parameter that stays one segment of THIS route: `..` survives `encodeURIComponent` and
 * URL normalisation would resolve it into another route; a slash or control character never
 * belongs in an id.
 */
function isSafeSegment(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value !== '.' && !value.includes('..') && !/[/\\\u0000-\u001f\u007f]/.test(value);
}

/** `/api/v1[/p/<id>]/runs/<id>?…` and the body, from one flat argument object. */
export function requestFor(tool: CatalogTool, args: Record<string, unknown>, origin: string): { url: string; body?: string } | { error: string } {
  let path = tool.path;
  for (const name of tool.params) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return { error: `missing ${name}` };
    if (!isSafeSegment(String(value))) return { error: `invalid ${name}: ${JSON.stringify(String(value))}` };
    path = path.replace(`:${name}`, encodeURIComponent(String(value)));
  }
  const projectId = tool.scoped && typeof args.projectId === 'string' && args.projectId !== '' ? args.projectId : undefined;
  if (projectId !== undefined && !isSafeSegment(projectId)) return { error: `invalid projectId: ${JSON.stringify(projectId)}` };
  const url = new URL(`/api/v1${projectId ? `/p/${encodeURIComponent(projectId)}` : ''}${path}`, origin);
  for (const name of tool.query) {
    for (const value of queryValue(args[name])) url.searchParams.append(name, value);
  }
  if (tool.body === 'none') return { url: url.toString() };
  if (tool.body === 'nested') {
    return args.body === undefined ? { url: url.toString() } : { url: url.toString(), body: JSON.stringify(args.body) };
  }
  const body: Record<string, unknown> = {};
  for (const name of tool.bodyKeys) if (args[name] !== undefined) body[name] = args[name];
  return { url: url.toString(), body: JSON.stringify(body) };
}

export async function callTool(tool: CatalogTool, args: Record<string, unknown>, context: CallContext): Promise<ToolResult> {
  const built = requestFor(tool, args, context.origin);
  if ('error' in built) return errorResult(`${tool.name}: ${built.error}`);
  const headers = new Headers(context.headers);
  headers.set('accept', 'application/json');
  if (built.body !== undefined) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await context.dispatch(new Request(built.url, { method: tool.method, headers, body: built.body }));
  } catch (error) {
    return errorResult(`${tool.name}: the cockpit could not be reached (${(error as Error).message})`);
  }
  const type = response.headers.get('content-type') ?? '';
  if (/^image\//.test(type)) {
    const data = Buffer.from(await response.arrayBuffer()).toString('base64');
    return { content: [{ type: 'image', data, mimeType: type.split(';')[0]!.trim() }], ...(response.ok ? {} : { isError: true }) };
  }
  const text = await response.text();
  if (!response.ok) return errorResult(`${response.status} ${clip(text)}`);
  if (/json/.test(type)) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { content: [{ type: 'text', text: clip(text) }] };
    }
    const result: ToolResult = { content: [{ type: 'text', text: clip(JSON.stringify(value, null, 2)) }] };
    // Structured only when the tool promised a shape, and as the shape it promised.
    if (tool.outputSchema) {
      if (tool.outputWrapped) result.structuredContent = { result: value };
      else if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value as Record<string, unknown>;
    }
    return result;
  }
  if (/^text\//.test(type) || text.length > 0) return { content: [{ type: 'text', text: clip(text) }] };
  return { content: [{ type: 'text', text: `${response.status} (no content)` }] };
}

/** The request headers a tool call carries into the cockpit: who is calling, and from where. */
const FORWARDED = ['authorization', 'cookie', 'host', 'origin', 'sec-fetch-site', 'user-agent', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'];

export function forwardedHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = from.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
