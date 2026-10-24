import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { EMPTY_SHA256, S3Client, signV4, type S3Target } from './s3.ts';
import { fakeS3 } from './s3-fake.testkit.ts';

describe('SigV4', () => {
  // AWS's own worked example ("Example: GET Object", Signature Version 4 for Amazon S3).
  it('signs the documented GET Object example exactly', () => {
    const headers = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('S3Client against an in-memory S3', () => {
  const fake = fakeS3('backups');
  let target: S3Target;
  let dir: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    const { port } = fake.server.address() as AddressInfo;
    target = { endpoint: `http://127.0.0.1:${port}/`, bucket: 'backups', prefix: '/cezar/', region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret' };
    dir = mkdtempSync(join(tmpdir(), 'cez-s3-'));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await removeTempDir(dir);
  });

  it('tests, uploads, lists and deletes', async () => {
    const client = new S3Client(target);
    await client.headBucket();
    await expect(new S3Client({ ...target, bucket: 'other' }).headBucket()).rejects.toThrow(/does not exist/);
    await expect(new S3Client({ ...target, accessKeyId: 'nope' }).headBucket()).rejects.toThrow(/access denied/);

    const file = join(dir, 'a.age');
    const bytes = randomBytes(300_000);
    writeFileSync(file, bytes);
    const names = ['cezar-backup-vps-20261021T0300Z.tar.zst.age', 'cezar-backup-vps-20261022T0300Z.tar.zst.age', 'cezar-backup-vps-20261023T0300Z.tar.zst.age'];
    for (const name of names) expect(await client.putFile(name, file, bytes.length)).toBe(`cezar/${name}`);
    expect(fake.objects.get(`cezar/${names[0]}`)!.equals(bytes)).toBe(true);

    const listed = await client.list(client.keyFor('cezar-backup-vps-'));
    expect(listed.map((object) => object.key)).toEqual(names.map((name) => `cezar/${name}`));
    expect(listed[0]!.size).toBe(bytes.length);
    await client.delete(listed[0]!.key);
    expect(fake.objects.has(`cezar/${names[0]}`)).toBe(false);
  });

  it('answers a clear error for an endpoint that is not there', async () => {
    const client = new S3Client({ ...target, endpoint: 'http://127.0.0.1:9' }, { timeoutMs: 2_000 });
    await expect(client.headBucket()).rejects.toThrow(/could not reach 127\.0\.0\.1:9/);
  });
});

/**
 * Against a real S3-compatible server (MinIO in the container test env). Opt-in: without an
 * endpoint it is SKIPPED, never failed — the in-memory suite above is the unit gate.
 *   BACKUP_S3_TEST_ENDPOINT=http://127.0.0.1:9000 BACKUP_S3_TEST_BUCKET=cezar-test
 *   BACKUP_S3_TEST_KEY=minioadmin BACKUP_S3_TEST_SECRET=minioadmin npm test -- src/backup/s3.test.ts
 */
const real = process.env.BACKUP_S3_TEST_ENDPOINT
  ? {
      endpoint: process.env.BACKUP_S3_TEST_ENDPOINT,
      bucket: process.env.BACKUP_S3_TEST_BUCKET ?? 'cezar-test',
      prefix: `cezar-test-${Date.now()}`,
      region: process.env.BACKUP_S3_TEST_REGION ?? 'us-east-1',
      accessKeyId: process.env.BACKUP_S3_TEST_KEY ?? 'minioadmin',
      secretAccessKey: process.env.BACKUP_S3_TEST_SECRET ?? 'minioadmin',
    }
  : null;

describe.skipIf(!real)('S3Client against a real S3-compatible endpoint (opt-in)', () => {
  it('round-trips an object', async () => {
    const client = new S3Client(real!);
    await client.headBucket();
    const dir = mkdtempSync(join(tmpdir(), 'cez-s3-real-'));
    try {
      const file = join(dir, 'x');
      writeFileSync(file, 'hello');
      const key = await client.putFile('cezar-backup-test-20261023T0300Z.tar.zst.age', file, 5);
      expect((await client.list(client.keyFor('cezar-backup-test-'))).map((object) => object.key)).toContain(key);
      await client.delete(key);
    } finally {
      await removeTempDir(dir);
    }
  });
});

