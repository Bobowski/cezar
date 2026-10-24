import { pipeline, Readable, type Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import * as zlib from 'node:zlib';
import { Decrypter, Encrypter } from 'age-encryption';

/**
 * Compression and encryption for the archive (spec `2026-10-23-backup-restore.md` §3): zstd
 * level 3 through Node's own `zlib` (22.15+/23.8+), gzip on an older Node; age through the
 * `age-encryption` package, in-process. The decompressor sniffs the magic bytes, so an archive
 * written by either kind of Node restores on the other.
 */

export type Compression = 'zstd' | 'gzip';

/** `zlib`'s zstd half, absent from `@types/node@20` and from a Node older than 22.15. */
const zstd = zlib as unknown as {
  createZstdCompress?: (options?: { params?: Record<number, number> }) => Transform;
  createZstdDecompress?: () => Transform;
  constants: { ZSTD_c_compressionLevel?: number };
};

export function availableCompression(): Compression {
  return typeof zstd.createZstdCompress === 'function' && typeof zstd.createZstdDecompress === 'function' ? 'zstd' : 'gzip';
}

export function compressor(kind: Compression): Transform {
  if (kind === 'zstd') {
    const level = zstd.constants.ZSTD_c_compressionLevel;
    return zstd.createZstdCompress!(level === undefined ? {} : { params: { [level]: 3 } });
  }
  return zlib.createGzip({ level: 6 });
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** The plaintext of an archive, decompressed by whatever its first bytes say it is. */
export async function decompressed(source: AsyncIterable<Buffer | Uint8Array>): Promise<Readable> {
  const iterator = source[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  while (head.length < 4) {
    const next = await iterator.next();
    if (next.done) break;
    head = Buffer.concat([head, Buffer.from(next.value)]);
  }
  let kind: Compression;
  if (head.subarray(0, 4).equals(ZSTD_MAGIC)) kind = 'zstd';
  else if (head.subarray(0, 2).equals(GZIP_MAGIC)) kind = 'gzip';
  else throw new Error('the archive is not a cezar backup (unknown compression)');
  if (kind === 'zstd' && availableCompression() !== 'zstd') {
    throw new Error(`this archive is zstd-compressed and Node ${process.versions.node} has no zstd — restore it with Node 22.15 or newer`);
  }
  const decoder = kind === 'zstd' ? zstd.createZstdDecompress!() : zlib.createGunzip();
  async function* rest(): AsyncGenerator<Buffer> {
    if (head.length > 0) yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield Buffer.from(next.value);
    }
  }
  pipeline(Readable.from(rest()), decoder, (error) => {
    if (error) decoder.destroy(error);
  });
  return decoder;
}

export type EncryptTo = { kind: 'age'; recipient: string } | { kind: 'passphrase'; passphrase: string };

/** `source` as an age file. `scryptWorkFactor` is a test seam (the default, 18, takes ~1 s). */
export async function encrypted(source: Readable, to: EncryptTo, options: { scryptWorkFactor?: number } = {}): Promise<Readable> {
  const encrypter = new Encrypter();
  if (to.kind === 'age') encrypter.addRecipient(to.recipient);
  else {
    if (options.scryptWorkFactor !== undefined) encrypter.setScryptWorkFactor(options.scryptWorkFactor);
    encrypter.setPassphrase(to.passphrase);
  }
  const web = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
  const out = await encrypter.encrypt(web);
  return Readable.fromWeb(out as unknown as WebReadableStream<Uint8Array>);
}

/**
 * What a restore was given — an `AGE-SECRET-KEY-1…` identity (an `age-keygen` file pasted whole,
 * comments and all, is fine) or, when it holds none, a passphrase.
 */
export function parseIdentity(text: string): { identities: string[]; passphrase?: string } {
  const identities = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^AGE-SECRET-KEY-(?:PQ-)?1[0-9A-Z]+$/.test(line));
  if (identities.length > 0) return { identities };
  const passphrase = text.replace(/\r?\n$/, '');
  return passphrase === '' ? { identities: [] } : { identities: [], passphrase };
}

export class WrongIdentityError extends Error {
  constructor() {
    super('this identity or passphrase does not open the archive');
  }
}

/** The plaintext stream of an age file. A key that does not match is a `WrongIdentityError`. */
export async function decrypted(source: Readable, identity: string): Promise<Readable> {
  const { identities, passphrase } = parseIdentity(identity);
  if (identities.length === 0 && passphrase === undefined) throw new WrongIdentityError();
  const decrypter = new Decrypter();
  for (const key of identities) {
    try {
      decrypter.addIdentity(key);
    } catch {
      throw new Error('that is not a valid age identity — paste the AGE-SECRET-KEY-1… line age-keygen wrote');
    }
  }
  if (passphrase !== undefined) decrypter.addPassphrase(passphrase);
  const web = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
  try {
    const out = await decrypter.decrypt(web);
    return Readable.fromWeb(out as unknown as WebReadableStream<Uint8Array>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no identity matched|incorrect passphrase|failed to decrypt|scrypt/i.test(message)) throw new WrongIdentityError();
    throw new Error(`the archive could not be decrypted (${message})`);
  }
}
