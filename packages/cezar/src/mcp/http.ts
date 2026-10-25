import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { apiTokenAllows } from '../auth/api-tokens.ts';
import { runTokenAllows } from '../auth/run-tokens.ts';
import { principalOf, type Principal } from '../auth/guard.ts';
import { selectTools, type Catalog, type CatalogTool } from './catalog.ts';
import { forwardedHeaders } from './execute.ts';
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
  /** `env` is the outer request's (its socket): the guard reads where a call came from off it. */
  dispatch: (request: Request, env: unknown) => Promise<Response>;
  version: string;
}

/** A token — an API token or a chat's — lists the tools it reaches; every other caller the whole selection. */
export function toolsAllowedFor(principal: Principal | undefined): ((tool: CatalogTool) => boolean) | undefined {
  // A template's `:params` stand in as one segment each; the scope check reads the route, not the value.
  const pathOf = (tool: CatalogTool) => tool.path.replace(/:[^/]+/g, '_');
  if (principal?.kind === 'run' && principal.scope) {
    const claims = { runId: principal.runId, scope: principal.scope, ...(principal.projectId ? { projectId: principal.projectId } : {}) };
    const prefix = principal.projectId ? `/api/v1/p/${encodeURIComponent(principal.projectId)}` : '/api/v1';
    return (tool) => runTokenAllows(claims, tool.method, `${tool.scoped ? prefix : '/api/v1'}${pathOf(tool)}`);
  }
  if (principal?.kind !== 'token') return undefined;
  const { scopes } = principal;
  return (tool) => apiTokenAllows(scopes, tool.method, `/api/v1${pathOf(tool)}`);
}

/** The project a caller's scoped tools address by default: a chat's own, else the boot project. */
export function defaultProjectFor(principal: Principal | undefined): string | undefined {
  return principal?.kind === 'run' ? principal.projectId : undefined;
}

export function mcpRoutes(deps: McpRoutesDeps) {
  const caller = new AsyncLocalStorage<{ env: unknown; principal: Principal | undefined }>();
  const handler = createMcpHandler(
    (ctx) => {
      const request = ctx.requestInfo;
      const url = new URL(request?.url ?? 'http://127.0.0.1/');
      const { env, principal } = caller.getStore() ?? { env: undefined, principal: undefined };
      const catalog = deps.catalog();
      const selected = selectTools(catalog, url.searchParams.get('tools') ?? undefined);
      const allows = toolsAllowedFor(principal);
      const projectId = defaultProjectFor(principal);
      return createCezarMcpServer({
        catalog,
        tools: 'tools' in selected ? selected.tools : [],
        context: {
          dispatch: (inner) => deps.dispatch(inner, env),
          origin: url.origin,
          headers: forwardedHeaders(request?.headers ?? new Headers()),
          ...(projectId ? { projectId } : {}),
        },
        version: deps.version,
        ...(allows ? { allows } : {}),
      });
    },
  );

  const serve = async (c: Context) => {
    const selected = selectTools(deps.catalog(), c.req.query('tools'));
    if ('error' in selected) return c.json({ error: selected.error }, 400);
    return caller.run({ env: c.env, principal: principalOf(c) }, () => handler.fetch(c.req.raw));
  };

  return new Hono().post('/mcp', serve).get('/mcp', serve).delete('/mcp', serve);
}
