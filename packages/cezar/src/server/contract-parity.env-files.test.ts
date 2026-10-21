import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { EnvFileContent, EnvFileQuery, EnvFileRender, EnvFilesRerender, RerenderEnvFilesInput, EnvFilesErrorResponse, EnvFilesList, RenderEnvFileInput, SetEnvFileInput } from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const unscoped = client.api.v1['env-files'];
const scoped = client.api.v1.p[':projectId']['env-files'];
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the routes send and accept.
type Checks = [
  Assert<Mutual<EnvFilesList, InferResponseType<typeof unscoped.$get, 200>>>,
  Assert<Mutual<EnvFilesList, InferResponseType<typeof scoped.$get, 200>>>,
  Assert<Mutual<EnvFileContent, InferResponseType<typeof unscoped.content.$get, 200>>>,
  Assert<Mutual<EnvFileContent, InferResponseType<typeof scoped.$put, 200>>>,
  Assert<Mutual<EnvFileQuery, InferRequestType<typeof unscoped.content.$get>['query']>>,
  Assert<Mutual<EnvFileQuery, InferRequestType<typeof unscoped.$delete>['query']>>,
  Assert<Mutual<SetEnvFileInput, InferRequestType<typeof scoped.$put>['json']>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.$put, 409>>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.content.$get, 404>>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.$delete, 404>>>,
  Assert<Mutual<EnvFileRender, InferResponseType<typeof unscoped.render.$post, 200>>>,
  Assert<Mutual<EnvFileRender, InferResponseType<typeof scoped.render.$post, 200>>>,
  Assert<Mutual<RenderEnvFileInput, InferRequestType<typeof scoped.render.$post>['json']>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.render.$post, 400>>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.render.$post, 404>>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.render.$post, 409>>>,
  Assert<Mutual<EnvFilesRerender, InferResponseType<typeof scoped.rerender.$post, 200>>>,
  Assert<Mutual<RerenderEnvFilesInput, InferRequestType<typeof scoped.rerender.$post>['json']>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.rerender.$post, 400>>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.rerender.$post, 404>>>,
  Assert<Mutual<EnvFilesErrorResponse, InferResponseType<typeof unscoped.rerender.$post, 409>>>,
];
it('pins the env-files route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});
