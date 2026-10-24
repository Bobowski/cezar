import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { selectTools, type Catalog } from './catalog.ts';
import { forwardedHeaders, type Dispatch } from './execute.ts';
import { createCezarMcpServer } from './server.ts';

/**
 * `/api/v1/mcp` — the catalog over Streamable HTTP (spec 2026-10-24-cezar-mcp-server §3), for a
 * hosted cockpit and for anything that speaks HTTP MCP to a local one. Stateless: each request
 * gets a fresh server over the same catalog, and each tool call goes back through the app with
 * the caller's own credential, so the guard — not this file — decides what it may do.
 *
 * The body is JSON-RPC, validated by the SDK, so there is no zod validator here: the route is a
 * transport, and the contract's route table lists it as one.
 */
export interface McpRoutesDeps {
  /** Built on first use, after every route is registered. */
  catalog: () => Catalog;
  dispatch: Dispatch;
  version: string;
}

export function mcpRoutes(deps: McpRoutesDeps) {
  const handler = createMcpHandler(
    (ctx) => {
      const request = ctx.requestInfo;
      const url = new URL(request?.url ?? 'http://127.0.0.1/');
      const catalog = deps.catalog();
      const selected = selectTools(catalog, url.searchParams.get('tools') ?? undefined);
      return createCezarMcpServer({
        catalog,
        tools: 'tools' in selected ? selected.tools : [],
        context: { dispatch: deps.dispatch, origin: url.origin, headers: forwardedHeaders(request?.headers ?? new Headers()) },
        version: deps.version,
      });
    },
  );

  const serve = async (c: Context) => {
    const selected = selectTools(deps.catalog(), c.req.query('tools'));
    if ('error' in selected) return c.json({ error: selected.error }, 400);
    return handler.fetch(c.req.raw);
  };

  return new Hono().post('/mcp', serve).get('/mcp', serve).delete('/mcp', serve);
}
