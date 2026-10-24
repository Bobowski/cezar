import { constants, deflateRawSync } from 'node:zlib';

/** Hand-built PNGs for the decoder's refusal tests: headers pngjs's encoder will not write. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A `width`×`height` RGBA PNG whose IDAT inflates to `inflatedMiB` MiB of zeros — a few KB per
 * MiB on disk. The zlib stream is one non-final deflate block per MiB, so it is built without
 * ever holding the inflated bytes.
 */
export function pngBomb(options: { width?: number; height?: number; interlace: boolean; inflatedMiB: number }): Buffer {
  const { width = 16, height = 16, interlace, inflatedMiB } = options;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, interlace ? 1 : 0], 8);
  const block = deflateRawSync(Buffer.alloc(1024 * 1024), { finishFlush: constants.Z_SYNC_FLUSH });
  const total = inflatedMiB * 1024 * 1024;
  const adler = Buffer.alloc(4);
  // Adler-32 of n zero bytes: a stays 1, b counts the bytes.
  adler.writeUInt32BE((((total % 65521) << 16) | 1) >>> 0, 0);
  const zlibStream = Buffer.concat([Buffer.from([0x78, 0x9c]), ...Array.from({ length: inflatedMiB }, () => block), deflateRawSync(Buffer.alloc(0)), adler]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStream),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
