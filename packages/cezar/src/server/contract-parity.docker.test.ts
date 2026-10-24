import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type {
  DockerDisk, DockerErrorResponse, DockerImages, DockerLogs, DockerOk, DockerReclaimPlan, DockerReclaimResult, DockerState, DockerVolumes,
} from '@open-mercato/cezar-contract';
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
  // Spec 2026-10-23-docker-management §4.
  Assert<Mutual<DockerImages, InferResponseType<typeof scoped.images.$get, 200>>>,
  Assert<Mutual<DockerImages, InferResponseType<typeof unscoped.images.$get, 200>>>,
  Assert<Mutual<DockerOk, InferResponseType<typeof scoped.images[':id']['$delete'], 200>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.images[':id']['$delete'], 404 | 409>>>,
  Assert<Mutual<DockerVolumes, InferResponseType<typeof scoped.volumes.$get, 200>>>,
  Assert<Mutual<DockerOk, InferResponseType<typeof scoped.volumes[':name']['$delete'], 200>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof unscoped.volumes[':name']['$delete'], 404 | 409>>>,
  Assert<Mutual<DockerOk, InferResponseType<typeof scoped.stacks[':name']['down']['$post'], 200>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.stacks[':name']['down']['$post'], 404 | 409>>>,
  Assert<Mutual<DockerOk, InferResponseType<typeof scoped.containers[':id']['$delete'], 200>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.containers[':id']['$delete'], 404 | 409>>>,
  Assert<Mutual<DockerLogs, InferResponseType<typeof scoped.containers[':id']['logs']['$get'], 200>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.containers[':id']['logs']['$get'], 404 | 409>>>,
  Assert<Mutual<DockerDisk, InferResponseType<typeof scoped.disk.$get, 200>>>,
  Assert<Mutual<DockerDisk, InferResponseType<typeof unscoped.disk.$get, 200>>>,
  Assert<Mutual<DockerReclaimPlan, InferResponseType<typeof scoped.reclaim.plan.$post, 200>>>,
  Assert<Mutual<DockerReclaimResult, InferResponseType<typeof scoped.reclaim.$post, 200>>>,
  Assert<Mutual<DockerErrorResponse, InferResponseType<typeof scoped.reclaim.$post, 409>>>,
];
it('pins the docker route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});
