import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { generateX25519Identity } from 'age-encryption';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_ARCHIVE_NAME_RE } from '@open-mercato/cezar-contract';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { compressor, decompressed, decrypted, encrypted, parseIdentity, WrongIdentityError } from './codec.ts';
import { archiveHost, archiveStamp, backupManifestSchema, collectBackup, projectFileQualifies, projectUntrackedFiles } from './collect.ts';
import { safeArchivePath } from './restore.ts';
import { readTar, tarStream, type TarEntry, type TarSource } from './tar.ts';

/** A fixed X25519 test vector: `age-keygen` output, and the recipient `age-keygen -y` derives. */
export const TEST_IDENTITY = 'AGE-SECRET-KEY-1QR4F256FCES52DV24YG4PDN4YFPCA7S79VZ60D3HU4GG5ASPWMGSU4L3C6';
export const TEST_RECIPIENT = 'age18j35t29smu32hg0lgmtsh3x7cad66hl7p5n2cdyd5jtsy5w6gc7swv3dp3';

async function collectBytes(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function untar(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Array<TarEntry & { body?: string }>> {
  const out: Array<TarEntry & { body?: string }> = [];
  await readTar(stream, (entry) => {
    const record: TarEntry & { body?: string } = { ...entry };
    out.push(record);
    if (entry.type !== 'file') return null;
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
      final(callback) {
        record.body = Buffer.concat(chunks).toString('utf8');
        callback();
      },
    });
  });
  return out;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });

describe('the archive tar', () => {
  it('round-trips files, directories, long names and modes', async () => {
    const long = `projects/app/${'deep/'.repeat(30)}.env.production`;
    const now = new Date('2026-10-23T04:12:00Z');
    const sources: TarSource[] = [
      { name: 'manifest.json', type: 'file', mode: 0o600, mtime: now, size: 2, bytes: Buffer.from('{}') },
      { name: 'data', type: 'dir', mode: 0o700, mtime: now, size: 0 },
      { name: 'data/empty', type: 'file', mode: 0o644, mtime: now, size: 0, bytes: Buffer.alloc(0) },
      { name: long, type: 'file', mode: 0o600, mtime: now, size: 7, bytes: Buffer.from('SECRET=') },
      { name: 'data/zażółć.txt', type: 'file', mode: 0o640, mtime: now, size: 4, bytes: Buffer.from('ąę') },
    ];
    const entries = await untar(Readable.from(tarStream(sources)));
    expect(entries.map((entry) => [entry.name, entry.type, entry.mode])).toEqual([
      ['manifest.json', 'file', 0o600],
      ['data', 'dir', 0o700],
      ['data/empty', 'file', 0o644],
      [long, 'file', 0o600],
      ['data/zażółć.txt', 'file', 0o640],
    ]);
    expect(entries[3]!.body).toBe('SECRET=');
    expect(entries[4]!.body).toBe('ąę');
    expect(entries[0]!.mtime.toISOString()).toBe('2026-10-23T04:12:00.000Z');
  });

  it('pads a file that shrank after it was listed, so the stream stays aligned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-tar-'));
    try {
      writeFileSync(join(dir, 'log'), 'abc');
      const now = new Date();
      const entries = await untar(
        Readable.from(
          tarStream([
            { name: 'data/log', type: 'file', mode: 0o600, mtime: now, size: 6, path: join(dir, 'log') },
            { name: 'data/next', type: 'file', mode: 0o600, mtime: now, size: 2, bytes: Buffer.from('ok') },
          ]),
        ),
      );
      expect(entries.map((entry) => entry.body?.replace(/\0/g, '.'))).toEqual(['abc...', 'ok']);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('refuses a truncated or corrupt stream', async () => {
    const bytes = await collectBytes(tarStream([{ name: 'a', type: 'file', mode: 0o600, mtime: new Date(), size: 1000, bytes: Buffer.alloc(1000) }]));
    await expect(untar(Readable.from([bytes.subarray(0, 700)]))).rejects.toThrow(/truncated/);
    const corrupt = Buffer.from(bytes);
    corrupt[10] = 0x41;
    await expect(untar(Readable.from([corrupt]))).rejects.toThrow(/corrupt/);
  });

  it('keeps every entry inside the staging layout', () => {
    expect(safeArchivePath('data/config.json')).toBe('data/config.json');
    expect(safeArchivePath('manifest.json')).toBe('manifest.json');
    for (const bad of ['../etc/passwd', 'data/../../x', '/data/x', 'C:/x', 'data\\x', 'other/x', 'data//x', '']) {
      expect(safeArchivePath(bad)).toBeNull();
    }
  });
});

describe('the archive codec', () => {
  const plaintext = Buffer.from('a'.repeat(50_000) + 'tail');

  it('encrypts to the test-vector recipient and decrypts with its identity', async () => {
    const sealed = await collectBytes(await encrypted(Readable.from([plaintext]), { kind: 'age', recipient: TEST_RECIPIENT }));
    expect(sealed.subarray(0, 22).toString()).toBe('age-encryption.org/v1\n');
    expect(sealed.includes(Buffer.from('aaaaaaaa'))).toBe(false);
    // An `age-keygen` file pasted whole: comments and the public key line are fine.
    const keyFile = `# created: 2026-10-23T04:12:00Z\n# public key: ${TEST_RECIPIENT}\n${TEST_IDENTITY}\n`;
    const opened = await collectBytes(await decrypted(Readable.from([sealed]), keyFile));
    expect(opened.equals(plaintext)).toBe(true);
    await expect(decrypted(Readable.from([sealed]), await generateX25519Identity())).rejects.toBeInstanceOf(WrongIdentityError);
    await expect(decrypted(Readable.from([sealed]), `${TEST_IDENTITY.slice(0, -1)}Q`)).rejects.toThrow(/not a valid age identity/);
  });

  it('encrypts to a passphrase (scrypt) and refuses the wrong one', async () => {
    const sealed = await collectBytes(
      await encrypted(Readable.from([plaintext]), { kind: 'passphrase', passphrase: 'correct horse' }, { scryptWorkFactor: 10 }),
    );
    expect(sealed.toString('latin1')).toContain('-> scrypt');
    const opened = await collectBytes(await decrypted(Readable.from([sealed]), 'correct horse'));
    expect(opened.equals(plaintext)).toBe(true);
    await expect(decrypted(Readable.from([sealed]), 'battery staple')).rejects.toBeInstanceOf(WrongIdentityError);
  });

  it('tells an identity from a passphrase', () => {
    expect(parseIdentity(`${TEST_IDENTITY}\n`)).toEqual({ identities: [TEST_IDENTITY] });
    expect(parseIdentity('a passphrase with spaces\n')).toEqual({ identities: [], passphrase: 'a passphrase with spaces' });
    expect(parseIdentity('')).toEqual({ identities: [] });
  });

  it('decompresses zstd and gzip alike, by their magic bytes', async () => {
    for (const kind of ['zstd', 'gzip'] as const) {
      if (kind === 'zstd' && !('createZstdCompress' in (await import('node:zlib')))) continue;
      const squeeze = compressor(kind);
      const through = new PassThrough();
      squeeze.pipe(through);
      squeeze.end(plaintext);
      const packed = await collectBytes(through);
      expect(packed.length).toBeLessThan(plaintext.length / 10);
      const unpacked = await collectBytes(await decompressed(Readable.from([packed])));
      expect(unpacked.equals(plaintext)).toBe(true);
    }
    await expect(decompressed(Readable.from([Buffer.from('not an archive')]))).rejects.toThrow(/unknown compression/);
  });
});

describe('what a project contributes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-backup-project-'));
    git(root, 'init', '-q');
    const write = (rel: string, text = 'x') => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write('.gitignore', 'node_modules/\n.env\n.env.*\n!.env.example\ndist/\n.ai/cezar/\n');
    write('.env.example', 'KEY=');
    write('README.md', '# app');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    write('.env', 'KEY=1');
    write('apps/api/.env.local', 'API=1');
    write('.ai/cezar/workflows/review.yaml', 'steps: []');
    write('.ai/cezar/runs.json', '{}');
    write('.ai/cezar/config.local.json', '{}');
    write('.ai/cezar/worktrees/abc123/README.md', 'a task worktree');
    write('config.local.json', '{}');
    write('node_modules/pkg/.env', 'NOPE=1');
    write('dist/bundle.js', 'build output');
    write('src/new-file.ts', 'untracked source');
  });

  afterEach(() => removeTempDir(root));

  it('is the untracked allowlist: env files and .ai/cezar in, worktrees and node_modules out', async () => {
    expect(await projectUntrackedFiles(root)).toEqual([
      '.ai/cezar/config.local.json',
      '.ai/cezar/runs.json',
      '.ai/cezar/workflows/review.yaml',
      '.env',
      'apps/api/.env.local',
      'config.local.json',
    ]);
  });

  it('never qualifies a tracked file, a dependency tree, a worktree or a traversal', () => {
    expect(projectFileQualifies('.env')).toBe(true);
    expect(projectFileQualifies('services/web/.env.production')).toBe(true);
    expect(projectFileQualifies('.ai/cezar/lifecycle/setup.sh')).toBe(true);
    expect(projectFileQualifies('.ai/cezar/worktrees/x/.env')).toBe(false);
    expect(projectFileQualifies('node_modules/a/.env')).toBe(false);
    expect(projectFileQualifies('src/index.ts')).toBe(false);
    expect(projectFileQualifies('../.env')).toBe(false);
    expect(projectFileQualifies('nested/config.local.json')).toBe(false);
  });

  it('writes a manifest that round-trips through its schema', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-backup-home-'));
    try {
      writeFileSync(join(home, 'config.json'), '{}');
      mkdirSync(join(home, 'backups'));
      writeFileSync(join(home, 'backups', 'old.age'), 'never archived');
      const now = new Date('2026-10-23T04:12:30Z');
      const { manifest, entries } = await collectBackup({
        cezarHome: home,
        locations: { claude: join(home, 'none'), claudeState: null, codex: join(home, 'none'), gh: join(home, 'none'), ssh: join(home, 'none'), gitconfig: join(home, 'none') },
        projects: [{ id: 'app', root }],
        cezarVersion: '0.17.0',
        compression: 'gzip',
        host: 'vps',
        now,
      });
      expect(entries[0]!.name).toBe('manifest.json');
      const parsed = backupManifestSchema.parse(JSON.parse(entries[0]!.bytes!.toString('utf8')));
      expect(parsed).toEqual(manifest);
      expect(parsed.projects).toEqual([{ id: 'app', root, remote: null, branch: expect.any(String) }]);
      expect(entries.map((entry) => entry.name)).toContain('data/config.json');
      expect(entries.map((entry) => entry.name)).toContain('projects/app/apps/api/.env.local');
      expect(entries.some((entry) => entry.name.startsWith('data/backups'))).toBe(false);
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('KEY=1');
    } finally {
      await removeTempDir(home);
    }
  });
});

describe('the archive name', () => {
  it('matches the contract pattern', () => {
    const name = `cezar-backup-${archiveHost('Fancy_Fence.VPS')}-${archiveStamp(new Date('2026-10-23T04:12:59.999Z'))}.tar.zst.age`;
    expect(name).toBe('cezar-backup-fancy-fence-vps-20261023T0412Z.tar.zst.age');
    expect(BACKUP_ARCHIVE_NAME_RE.test(name)).toBe(true);
    expect(BACKUP_ARCHIVE_NAME_RE.test(name.replace('.tar.zst', '.tar.gz').replace('.age', '-2.age'))).toBe(false);
    expect(BACKUP_ARCHIVE_NAME_RE.test(name.replace('Z.tar', 'Z-2.tar'))).toBe(true);
    expect(BACKUP_ARCHIVE_NAME_RE.test('../cezar-backup-x-20261023T0412Z.tar.zst.age')).toBe(false);
    expect(archiveHost('---')).toBe('cezar');
  });
});
