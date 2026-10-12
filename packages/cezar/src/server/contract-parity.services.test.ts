import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type {
  ServiceLogs, ServiceLogsQuery, ServicePatch, ServicePin, ServicePinInput, ServicesErrorResponse, ServicesState,
  TerminalInput, TerminalOutput,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const unscoped = client.api.v1.services;
const scoped = client.api.v1.p[':projectId'].services;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the routes send and accept.
type Checks = [
  Assert<Mutual<ServicesState, InferResponseType<typeof unscoped.$get, 200>>>,
  Assert<Mutual<ServicesState, InferResponseType<typeof scoped.$get, 200>>>,
  Assert<Mutual<ServicesState, InferResponseType<typeof scoped['start-all']['$post'], 200>>>,
  Assert<Mutual<ServicesState, InferResponseType<typeof scoped.resume.$post, 200>>>,
  Assert<Mutual<ServicesState, InferResponseType<typeof scoped['stop-all']['$post'], 200>>>,
  Assert<Mutual<ServicePin, InferResponseType<typeof scoped.$post, 201>>>,
  Assert<Mutual<ServicePin, InferResponseType<typeof scoped[':id']['$patch'], 200>>>,
  Assert<Mutual<ServicePinInput, InferRequestType<typeof scoped.$post>['json']>>,
  Assert<Mutual<ServicePatch, InferRequestType<typeof scoped[':id']['$patch']>['json']>>,
  Assert<Mutual<TerminalOutput, InferResponseType<typeof scoped[':id']['output']['$get'], 200>>>,
  Assert<Mutual<TerminalInput, InferRequestType<typeof scoped[':id']['input']['$post']>['json']>>,
  Assert<Mutual<ServiceLogs, InferResponseType<typeof unscoped[':id']['logs']['$get'], 200>>>,
  Assert<Mutual<ServiceLogsQuery, { tail?: number }>>,
  Assert<Mutual<ServicesErrorResponse, InferResponseType<typeof unscoped[':id']['start']['$post'], 409>>>,
  Assert<Mutual<ServicesErrorResponse, InferResponseType<typeof unscoped[':id']['$delete'], 404>>>,
];
it('pins the services route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});
