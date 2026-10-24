import { createReadStream } from 'node:fs';
import type { Writable } from 'node:stream';

/**
 * The smallest tar this feature needs (spec `2026-10-23-backup-restore.md` §3): POSIX ustar with
 * PAX `path` records for long names, regular files and directories only. Readable by GNU and BSD
 * tar, so an archive decrypted on a laptop (`age -d … | zstd -d | tar t`) lists like any other.
 */

const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK);

export interface TarSource {
  /** `/`-separated, relative. Directories without a trailing slash. */
  name: string;
  type: 'file' | 'dir';
  mode: number;
  mtime: Date;
  /** Files: the size at listing time — exactly this many bytes are written (padded if it shrank). */
  size: number;
  /** Files: the absolute path to read, or the bytes themselves. */
  path?: string;
  bytes?: Buffer;
}

export interface TarEntry {
  name: string;
  type: 'file' | 'dir' | 'other';
  mode: number;
  size: number;
  mtime: Date;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0').slice(-(width - 1));
}

function header(name: string, type: '0' | '5' | 'x', mode: number, size: number, mtime: Date): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 100), 0, 100, 'utf8');
  block.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(Math.max(0, Math.floor(mtime.getTime() / 1000)), 12), 136, 12, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\u000000', 257, 8, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${octal(sum, 7)}\u0000 `, 148, 8, 'ascii');
  return block;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, 'utf8');
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/** The header blocks for one entry: a PAX header first when the name does not fit ustar. */
function headersFor(source: TarSource): Buffer[] {
  const name = source.type === 'dir' ? `${source.name}/` : source.name;
  const type = source.type === 'dir' ? '5' : '0';
  const size = source.type === 'dir' ? 0 : source.size;
  const out: Buffer[] = [];
  if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) {
    const pax = paxRecord('path', name);
    out.push(header(`PaxHeader/${name.slice(-80)}`.slice(0, 100), 'x', 0o644, pax.length, source.mtime), pax, Buffer.alloc(padding(pax.length)));
  }
  out.push(header(name, type, source.mode, size, source.mtime));
  return out;
}

/** Stream `sources` as a tar archive. */
export async function* tarStream(sources: AsyncIterable<TarSource> | Iterable<TarSource>): AsyncGenerator<Buffer> {
  for await (const source of sources) {
    for (const block of headersFor(source)) yield block;
    if (source.type === 'dir') continue;
    let written = 0;
    if (source.bytes) {
      yield source.bytes.subarray(0, source.size);
      written = Math.min(source.size, source.bytes.length);
    } else if (source.path && source.size > 0) {
      // A log appended while we read must not desynchronise the archive: read what was listed.
      for await (const chunk of createReadStream(source.path, { start: 0, end: source.size - 1 })) {
        const buffer = chunk as Buffer;
        yield buffer;
        written += buffer.length;
      }
    }
    if (written < source.size) yield Buffer.alloc(source.size - written);
    const pad = padding(source.size);
    if (pad > 0) yield Buffer.alloc(pad);
  }
  yield ZERO;
  yield ZERO;
}

/** Exact-length reads over a chunk stream. */
class ByteReader {
  private buffers: Buffer[] = [];
  private length = 0;
  private done = false;
  private readonly iterator: AsyncIterator<Buffer | Uint8Array>;

  constructor(source: AsyncIterable<Buffer | Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.buffers.push(chunk);
      this.length += chunk.length;
    }
  }

  private take(n: number): Buffer {
    const all = this.buffers.length === 1 ? this.buffers[0]! : Buffer.concat(this.buffers, this.length);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.buffers = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  /** Exactly `n` bytes, or null at a clean end of stream. */
  async read(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.length === 0 && this.done) return null;
    if (this.length < n) throw new Error('the archive is truncated');
    return this.take(n);
  }

  /** `n` bytes as chunks, without holding them all. */
  async *chunks(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      if (this.length === 0) throw new Error('the archive is truncated');
      const piece = this.take(Math.min(left, this.length));
      left -= piece.length;
      yield piece;
    }
  }
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function octalField(block: Buffer, start: number, length: number): number {
  const text = field(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('the archive has a malformed header');
  return parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === octalField(block, 148, 8);
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(body.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

const write = (sink: Writable, chunk: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    sink.write(chunk, (error) => (error ? reject(error) : resolve()));
  });

const finish = (sink: Writable): Promise<void> =>
  new Promise((resolve, reject) => {
    sink.once('error', reject);
    sink.end(() => resolve());
  });

/**
 * Read a tar stream. `onEntry` answers a sink for a file's bytes (or null to skip it); directory
 * and other entries are reported and never carry a body. A checksum or truncation error throws.
 */
export async function readTar(
  source: AsyncIterable<Buffer | Uint8Array>,
  onEntry: (entry: TarEntry) => Promise<Writable | null> | Writable | null,
): Promise<void> {
  const reader = new ByteReader(source);
  let pax: Record<string, string> = {};
  let zeros = 0;
  for (;;) {
    const block = await reader.read(BLOCK);
    if (!block) {
      if (zeros === 0) throw new Error('the archive is truncated');
      return;
    }
    if (block.equals(ZERO)) {
      zeros += 1;
      if (zeros === 2) return;
      continue;
    }
    zeros = 0;
    if (!checksumOk(block)) throw new Error('the archive has a corrupt header');
    const type = String.fromCharCode(block[156] ?? 0);
    const size = octalField(block, 124, 12);
    const pad = padding(size);
    if (type === 'x' || type === 'g') {
      const body = size > 0 ? await reader.read(size) : Buffer.alloc(0);
      if (pad > 0) await reader.read(pad);
      if (type === 'x' && body) pax = parsePax(body);
      continue;
    }
    const prefix = field(block, 345, 155);
    const plain = field(block, 0, 100);
    const name = (pax.path ?? (prefix ? `${prefix}/${plain}` : plain)).replace(/\/+$/, '');
    pax = {};
    const entry: TarEntry = {
      name,
      type: type === '0' || type === '\u0000' ? 'file' : type === '5' ? 'dir' : 'other',
      mode: octalField(block, 100, 8),
      size,
      mtime: new Date(octalField(block, 136, 12) * 1000),
    };
    const sink = await onEntry(entry);
    if (entry.type === 'file' && sink) {
      for await (const chunk of reader.chunks(size)) await write(sink, chunk);
      await finish(sink);
    } else {
      for await (const _ of reader.chunks(size)) { /* skipped */ }
    }
    if (pad > 0) await reader.read(pad);
  }
}
