import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  BackupError,
  BackupJob,
  BackupSchedule,
  BackupStatus,
  BackupTargetTestResponse,
  CreateBackupBody,
  SetBackupRecipientBody,
  SetBackupTargetBody,
  SetupRestoreResponse,
} from '@open-mercato/cezar-contract';
import type { backupRestoreUploadSchema, setupRestoreUploadSchema } from '../backup/routes.ts';
import type { AppType } from './app-type.ts';

const client = hc<AppType>('http://127.0.0.1');
const backup = client.api.v1.workspace.backup;
const setupRestore = client.api.v1.auth.setup.restore;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
// Compile-time parity (spec 2026-10-23-backup-restore §5): the contract describes exactly what the
// routes send and accept, in both directions.
type Checks = [
  Assert<Mutual<BackupStatus, InferResponseType<typeof backup.$get, 200>>>,
  Assert<Mutual<BackupStatus, InferResponseType<typeof backup.$post, 200>>>,
  Assert<Mutual<Partial<CreateBackupBody>, InferRequestType<typeof backup.$post>['json']>>,
  Assert<Mutual<BackupStatus, InferResponseType<typeof backup.recipient.$put, 200>>>,
  Assert<Mutual<SetBackupRecipientBody, InferRequestType<typeof backup.recipient.$put>['json']>>,
  Assert<Mutual<BackupStatus, InferResponseType<typeof backup.target.$put, 200>>>,
  Assert<Mutual<SetBackupTargetBody, InferRequestType<typeof backup.target.$put>['json']>>,
  Assert<Mutual<BackupTargetTestResponse, InferResponseType<typeof backup.target.test.$post, 200>>>,
  Assert<Mutual<BackupStatus, InferResponseType<typeof backup.schedule.$put, 200>>>,
  Assert<Mutual<BackupSchedule, InferRequestType<typeof backup.schedule.$put>['json']>>,
  Assert<Mutual<BackupError, InferResponseType<typeof backup.$get, 409>>>,
  Assert<Mutual<BackupError, InferResponseType<typeof backup.archives[':name']['$get'], 404>>>,
  Assert<Mutual<BackupStatus, InferResponseType<typeof backup.restore.$post, 200>>>,
  Assert<Mutual<z.input<typeof backupRestoreUploadSchema>, InferRequestType<typeof backup.restore.$post>['form']>>,
  Assert<Mutual<SetupRestoreResponse, InferResponseType<typeof setupRestore.$post, 200>>>,
  Assert<Mutual<z.input<typeof setupRestoreUploadSchema>, InferRequestType<typeof setupRestore.$post>['form']>>,
  Assert<Mutual<BackupJob, InferResponseType<typeof setupRestore.$get, 200>>>,
  Assert<Mutual<{ job: string }, InferRequestType<typeof setupRestore.$get>['query']>>,
];
it('pins the backup route types to the contract', () => {
  const checks: Checks | undefined = undefined;
  expect(checks).toBeUndefined();
});
