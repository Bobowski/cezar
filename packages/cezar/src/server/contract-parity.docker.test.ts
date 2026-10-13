import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { DockerErrorResponse, DockerState } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const unscoped = client.api.v1.docker;
const scoped = client.api.v1.p[':projectId'].docker;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the routes send.
type Checks = [
  Assert<Mutual<DockerState, InferResponseType<typeof unscoped.$get, 200>>>,
  Assert<Mutual<DockerState, InferResponseType<typeof scoped.$get, 200>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.stacks[':name']['stop']['$post'], 409>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.stacks[':name']['start']['$post'], 404>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.containers[':id']['stop']['$post'], 409>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof unscoped.containers[':id']['start']['$post'], 404>>>,
];
it('pins the docker route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});
