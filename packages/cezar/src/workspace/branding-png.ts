import { PNG } from 'pngjs';

/**
 * PNG decoding, resizing and re-encoding for the branding uploads (spec 2026-10-24-cockpit-branding
 * §3, §5). Every PNG cezar serves is one it encoded itself from decoded pixels, so nothing an upload
 * carried beyond its pixels — ancillary chunks, trailing bytes, a polyglot payload — survives.
 */

export interface Rgba {
  width: number;
  height: number;
  /** 8-bit RGBA, row-major, not premultiplied. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A 2 MB upload can still inflate to gigabytes; 4096² is far beyond any icon and 64 MB of RGBA. */
export const MAX_PNG_PIXELS = 4096 * 4096;

export function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(SIGNATURE);
}

export type DecodeResult = { ok: true; image: Rgba } | { ok: false; error: string };

/** The dimensions from IHDR, read before any inflate, so a bomb is refused unopened. */
function headerSize(bytes: Buffer): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The bytes up to the end of IEND: whatever an editor (or a polyglot) appended is not the image. */
function throughIend(bytes: Buffer): Buffer {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IEND') return bytes.subarray(0, end);
    offset = end;
  }
  return bytes;
}

export function decodePng(bytes: Buffer): DecodeResult {
  const size = headerSize(bytes);
  if (!size) return { ok: false, error: 'not a PNG image' };
  if (size.width === 0 || size.height === 0 || size.width * size.height > MAX_PNG_PIXELS) {
    return { ok: false, error: 'the PNG is larger than 4096 × 4096 pixels' };
  }
  try {
    const png = PNG.sync.read(throughIend(bytes));
    return { ok: true, image: { width: png.width, height: png.height, data: new Uint8Array(png.data) } };
  } catch {
    return { ok: false, error: 'the PNG could not be decoded' };
  }
}

export function encodePng(image: Rgba): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png, { colorType: 6 });
}

/**
 * One axis of an area-average resample over premultiplied channels: each output sample is the
 * coverage-weighted mean of the input samples its span overlaps. Downscaling is a box filter;
 * upscaling degrades to nearest-ish, which is fine for the rare favicon under 48 px.
 */
function resampleAxis(src: Float64Array, srcLen: number, dstLen: number, lines: number, horizontal: boolean, srcStride: number): Float64Array {
  const out = new Float64Array(dstLen * lines * 4);
  const scale = srcLen / dstLen;
  for (let line = 0; line < lines; line += 1) {
    for (let d = 0; d < dstLen; d += 1) {
      const start = d * scale;
      const end = start + scale;
      const acc = [0, 0, 0, 0];
      let weightSum = 0;
      for (let s = Math.floor(start); s < Math.min(Math.ceil(end), srcLen); s += 1) {
        const weight = Math.min(s + 1, end) - Math.max(s, start);
        if (weight <= 0) continue;
        const i = horizontal ? (line * srcStride + s) * 4 : (s * srcStride + line) * 4;
        for (let c = 0; c < 4; c += 1) acc[c]! += src[i + c]! * weight;
        weightSum += weight;
      }
      const o = horizontal ? (line * dstLen + d) * 4 : (d * lines + line) * 4;
      for (let c = 0; c < 4; c += 1) out[o + c] = weightSum > 0 ? acc[c]! / weightSum : 0;
    }
  }
  return out;
}

export function resize(image: Rgba, width: number, height: number): Rgba {
  const pre = new Float64Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i += 1) {
    const a = image.data[i * 4 + 3]! / 255;
    pre[i * 4] = image.data[i * 4]! * a;
    pre[i * 4 + 1] = image.data[i * 4 + 1]! * a;
    pre[i * 4 + 2] = image.data[i * 4 + 2]! * a;
    pre[i * 4 + 3] = image.data[i * 4 + 3]!;
  }
  const rows = resampleAxis(pre, image.width, width, image.height, true, image.width);
  const both = resampleAxis(rows, image.height, height, width, false, width);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const alpha = both[i * 4 + 3]!;
    const a = alpha / 255;
    for (let c = 0; c < 3; c += 1) data[i * 4 + c] = a > 0 ? clamp(both[i * 4 + c]! / a) : 0;
    data[i * 4 + 3] = clamp(alpha);
  }
  return { width, height, data };
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** A `size`² canvas, `fill` or transparent, with the image fitted inside `inner`² at its centre. */
export function fitSquare(image: Rgba, size: number, options: { inner?: number; fill?: readonly [number, number, number] } = {}): Rgba {
  const inner = options.inner ?? size;
  const scale = inner / Math.max(image.width, image.height);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const fitted = resize(image, w, h);
  const data = new Uint8Array(size * size * 4);
  if (options.fill) {
    for (let i = 0; i < size * size; i += 1) data.set([...options.fill, 255], i * 4);
  }
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const s = (y * w + x) * 4;
      const d = ((top + y) * size + left + x) * 4;
      const a = fitted.data[s + 3]! / 255;
      // Source-over onto whatever the canvas holds.
      const below = data[d + 3]! / 255;
      const outA = a + below * (1 - a);
      for (let c = 0; c < 3; c += 1) {
        data[d + c] = outA > 0 ? clamp((fitted.data[s + c]! * a + data[d + c]! * below * (1 - a)) / outA) : 0;
      }
      data[d + 3] = clamp(outA * 255);
    }
  }
  return { width: size, height: size, data };
}

/** The colour behind an icon that has to be opaque: its own corner when that is opaque, else white. */
export function backdropOf(image: Rgba): readonly [number, number, number] {
  return image.data[3] === 255 ? [image.data[0]!, image.data[1]!, image.data[2]!] : [255, 255, 255];
}
