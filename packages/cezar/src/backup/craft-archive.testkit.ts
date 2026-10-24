import { createWriteStream } from 'node:fs';
import { pipeline, Readable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { compressor, encrypted } from './codec.ts';
import { MANIFEST_VERSION, type BackupManifest } from './collect.ts';
import { tarStream, type TarSource } from './tar.ts';
import { TEST_RECIPIENT } from './age-vector.testkit.ts';

/** Hand-made archives for the restore tests: what a hostile or broken one could carry. */

const BLOCK = 512;
const now = new Date('2026-10-24T00:00:00Z');

export function manifestFor(projects: BackupManifest['projects'], sizes: Partial<BackupManifest['sizes']> = {}): BackupManifest {
  return {
    version: MANIFEST_VERSION,
    createdAt: now.toISOString(),
    cezarVersion: 'test',
    host: 'crafted',
    compression: 'gzip',
    projects,
    sizes: { data: 0, agents: 0, projects: 0, files: 0, ...sizes },
  };
}

export const file = (name: string, text: string | Buffer): TarSource => {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  return { name, type: 'file', mode: 0o600, mtime: now, size: bytes.length, bytes };
};

/** A manifest entry whose sizes add up to what `entries` really carry (unless overridden). */
export function withManifest(projects: BackupManifest['projects'], entries: TarSource[], sizes: Partial<BackupManifest['sizes']> = {}): TarSource[] {
  const sum = (prefix: string) => entries.filter((e) => e.type === 'file' && e.name.startsWith(prefix)).reduce((n, e) => n + e.size, 0);
  const manifest = manifestFor(projects, {
    data: sum('data/'), agents: sum('agents/'), projects: sum('projects/'), files: entries.filter((e) => e.type === 'file').length, ...sizes,
  });
  return [file('manifest.json', `${JSON.stringify(manifest)}\n`), ...entries];
}

/** One raw ustar entry of any type, any name — what `tarStream` itself would never write. */
export function rawEntry(name: string, type: string, body: Buffer = Buffer.alloc(0), linkname = ''): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 100), 0, 100, 'utf8');
  block.write('0000600\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write(`${Math.floor(now.getTime() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'ascii');
  block.write(linkname.slice(0, 100), 157, 100, 'utf8');
  block.write('ustar\u000000', 257, 8, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const pad = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK);
  return Buffer.concat([block, body, pad]);
}

export async function tarBytes(entries: TarSource[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream(entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** gzip + age (to the test vector) around a finished tar, written to `path`. */
export async function sealTar(tar: Buffer, path: string): Promise<void> {
  const squeeze = compressor('gzip');
  pipeline(Readable.from([tar]), squeeze, (error) => {
    if (error) squeeze.destroy(error);
  });
  const sealed = await encrypted(squeeze, { kind: 'age', recipient: TEST_RECIPIENT });
  await pipelineAsync(sealed, createWriteStream(path));
}

export async function sealArchive(entries: TarSource[], path: string): Promise<void> {
  await sealTar(await tarBytes(entries), path);
}
