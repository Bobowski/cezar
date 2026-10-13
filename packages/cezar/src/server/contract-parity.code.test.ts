import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type {
  CodeSearchQuery, CodeSearchResult, CodeWatch, RepoFilePathQuery, RepoPullResponse, RepoSync, RepoSyncQuery, RepoTree, RunFileCreate, RunFileDeleteResponse, RunFileRename,
  RunFileWrite, RunFileWriteResponse, TerminalCreateInput, TerminalOutput, TerminalSession, TerminalState,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const repo = client.api.v1.p[':projectId'].repo;
const unscoped = client.api.v1.repo;
const run = client.api.v1.p[':projectId'].runs[':id'];
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity: the contract describes exactly what the routes send and accept.
type Checks = [
  Assert<Mutual<RunFileWriteResponse, InferResponseType<typeof repo.files.$put, 200>>>,
  Assert<Mutual<RunFileWriteResponse, InferResponseType<typeof unscoped.files.$post, 201>>>,
  Assert<Mutual<RunFileDeleteResponse, InferResponseType<typeof repo.files.$delete, 200>>>,
  Assert<Mutual<RunFileRename, InferResponseType<typeof repo.files.rename.$post, 200>>>,
  Assert<Mutual<RunFileWrite, InferRequestType<typeof repo.files.$put>['json']>>,
  Assert<Mutual<RunFileCreate, InferRequestType<typeof repo.files.$post>['json']>>,
  Assert<Mutual<RunFileRename, InferRequestType<typeof repo.files.rename.$post>['json']>>,
  Assert<Mutual<RepoFilePathQuery, InferRequestType<typeof unscoped.files.$delete>['query']>>,
  Assert<Mutual<CodeSearchResult, InferResponseType<typeof repo.search.$get, 200>>>,
  Assert<Mutual<CodeSearchResult, InferResponseType<typeof run.search.$get, 200>>>,
  Assert<Mutual<CodeSearchQuery, InferRequestType<typeof unscoped.search.$get>['query']>>,
  Assert<Mutual<RepoTree, InferResponseType<typeof run.tree.$get, 200>>>,
  Assert<Mutual<CodeWatch, InferResponseType<typeof repo.watch.$get, 200>>>,
  Assert<Mutual<RepoSync, InferResponseType<typeof repo.sync.$get, 200>>>,
  Assert<Mutual<RepoSyncQuery, InferRequestType<typeof unscoped.sync.$get>['query']>>,
  Assert<Mutual<RepoPullResponse, InferResponseType<typeof repo.pull.$post, 200>>>,
  Assert<Mutual<TerminalState, InferResponseType<typeof repo.terminal.$get, 200>>>,
  Assert<Mutual<TerminalSession, InferResponseType<typeof repo.terminal.$post, 201>>>,
  Assert<Mutual<TerminalCreateInput, InferRequestType<typeof repo.terminal.$post>['json']>>,
  Assert<Mutual<TerminalOutput, InferResponseType<typeof repo.terminal[':sessionId']['output']['$get'], 200>>>,
];
it('pins the Code page route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});
