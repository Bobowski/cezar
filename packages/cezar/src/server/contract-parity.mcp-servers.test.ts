import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type {
  McpPrivateOverride,
  McpProjectApprove,
  McpRegistryQuery,
  McpRegistryResponse,
  McpServerParams,
  McpServerPut,
  McpServersErrorResponse,
  McpServersList,
  McpServerTestResponse,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const unscoped = client.api.v1['mcp-servers'];
const scoped = client.api.v1.p[':projectId']['mcp-servers'];
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity (spec 2026-10-24-easy-mcp §4): the contract is exactly what the routes send and accept.
type Checks = [
  Assert<Mutual<McpServersList, InferResponseType<typeof unscoped.$get, 200>>>,
  Assert<Mutual<McpServersList, InferResponseType<typeof scoped.$get, 200>>>,
  Assert<Mutual<McpRegistryResponse, InferResponseType<typeof unscoped.registry.$get, 200>>>,
  Assert<Mutual<McpRegistryQuery, InferRequestType<typeof unscoped.registry.$get>['query']>>,
  Assert<Mutual<McpServerPut, InferRequestType<typeof unscoped[':scope'][':name']['$put']>['json']>>,
  Assert<Mutual<McpServerParams & { projectId: string }, InferRequestType<typeof scoped[':scope'][':name']['$put']>['param']>>,
  Assert<Mutual<McpServersList, InferResponseType<typeof unscoped[':scope'][':name']['$put'], 200>>>,
  Assert<Mutual<McpServersList, InferResponseType<typeof unscoped[':scope'][':name']['$delete'], 200>>>,
  Assert<Mutual<McpServersErrorResponse, InferResponseType<typeof unscoped[':scope'][':name']['$delete'], 404>>>,
  Assert<Mutual<McpServersErrorResponse, InferResponseType<typeof unscoped[':scope'][':name']['$put'], 409>>>,
  Assert<Mutual<McpServerTestResponse, InferResponseType<typeof unscoped[':scope'][':name']['test']['$post'], 200>>>,
  Assert<Mutual<McpServersErrorResponse, InferResponseType<typeof unscoped[':scope'][':name']['test']['$post'], 404>>>,
  Assert<Mutual<McpProjectApprove, InferRequestType<typeof unscoped.approval.$post>['json']>>,
  Assert<Mutual<McpServersList, InferResponseType<typeof scoped.approval.$post, 200>>>,
  Assert<Mutual<McpServersErrorResponse, InferResponseType<typeof unscoped.approval.$post, 409>>>,
  Assert<Mutual<McpPrivateOverride, InferRequestType<typeof unscoped.override.$post>['json']>>,
  Assert<Mutual<McpServersList, InferResponseType<typeof scoped.override.$post, 200>>>,
  Assert<Mutual<McpServersErrorResponse, InferResponseType<typeof unscoped.override.$post, 409>>>,
  Assert<Mutual<McpServersErrorResponse, InferResponseType<typeof unscoped.override.$post, 404>>>,
];
it('pins the MCP servers route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});
