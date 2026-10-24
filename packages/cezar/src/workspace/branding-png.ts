import { inflateSync } from 'node:zlib';
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
/**
 * A 2 MB upload can still inflate to gigabytes, and decoding blocks the server's one thread (a
 * 16-bit 2048² took ~500 ms). 1024² is every size an icon needs and a quarter of that work.
 */
export const MAX_PNG_SIDE = 1024;
export const MAX_PNG_PIXELS = MAX_PNG_SIDE * MAX_PNG_SIDE;
/** Samples per pixel by IHDR colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(SIGNATURE);
}

export type DecodeResult = { ok: true; image: Rgba } | { ok: false; error: string };

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

/** IHDR, read before any inflate, so a bomb is refused unopened. */
function readHeader(bytes: Buffer): Header | null {
  if (!isPng(bytes) || bytes.length < 29 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24]!,
    colorType: bytes[25]!,
    interlaced: bytes[28] !== 0,
  };
}

/**
 * The bytes up to the end of IEND — whatever an editor (or a polyglot) appended is not the
 * image — and the IDAT payload they carry.
 */
function chunksThroughIend(bytes: Buffer): { png: Buffer; idat: Buffer } {
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, Math.min(offset + 8 + length, bytes.length)));
    if (type === 'IEND') return { png: bytes.subarray(0, end), idat: Buffer.concat(idat) };
    offset = end;
  }
  return { png: bytes, idat: Buffer.concat(idat) };
}

export function decodePng(bytes: Buffer): DecodeResult {
  const header = readHeader(bytes);
  if (!header) return { ok: false, error: 'not a PNG image' };
  const { width, height, bitDepth, colorType } = header;
  if (width === 0 || height === 0 || width * height > MAX_PNG_PIXELS) {
    return { ok: false, error: `the PNG is larger than ${MAX_PNG_SIDE} × ${MAX_PNG_SIDE} pixels` };
  }
  // pngjs inflates an Adam7 image without a size bound; an icon never needs interlacing.
  if (header.interlaced) return { ok: false, error: 'an interlaced PNG is not accepted — save it without interlacing' };
  const channels = CHANNELS[colorType];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(bitDepth)) return { ok: false, error: 'the PNG could not be decoded' };
  const { png: image, idat } = chunksThroughIend(bytes);
  // One filter byte per scanline plus its packed samples: the most a well-formed IDAT inflates to.
  const inflatedBytes = height * (1 + Math.ceil((width * channels * bitDepth) / 8));
  try {
    inflateSync(idat, { maxOutputLength: inflatedBytes });
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, error: 'the PNG carries more image data than its size allows' };
    return { ok: false, error: 'the PNG could not be decoded' };
  }
  try {
    const png = PNG.sync.read(image);
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
 * For each output sample of a `srcLen` → `dstLen` axis, the source samples its span overlaps and
 * by how much. Spans are measured in 1/(srcLen·dstLen) steps, so every weight is an integer and
 * one output's weights sum to `srcLen`.
 */
function axisSpans(srcLen: number, dstLen: number): { offsets: Int32Array; index: Int32Array; weight: Int32Array } {
  const offsets = new Int32Array(dstLen + 1);
  const index: number[] = [];
  const weight: number[] = [];
  for (let d = 0; d < dstLen; d += 1) {
    offsets[d] = index.length;
    const lo = d * srcLen;
    const hi = lo + srcLen;
    for (let s = Math.floor(lo / dstLen); s < srcLen && s * dstLen < hi; s += 1) {
      const w = Math.min((s + 1) * dstLen, hi) - Math.max(s * dstLen, lo);
      if (w > 0) {
        index.push(s);
        weight.push(w);
      }
    }
  }
  offsets[dstLen] = index.length;
  return { offsets, index: Int32Array.from(index), weight: Int32Array.from(weight) };
}

/** Round-half-up division of non-negative integers. */
const roundDiv = (n: number, d: number): number => Math.floor((n + Math.floor(d / 2)) / d);

/**
 * An area-average resample over premultiplied channels, in integers: each output pixel is the
 * coverage-weighted mean of the input pixels its span overlaps (a box filter downscaling,
 * nearest-ish upscaling). The one intermediate is 16-bit, `c·a` and `a·255` both being ≤ 65025.
 */
export function resize(image: Rgba, width: number, height: number): Rgba {
  const { width: sw, height: sh, data: src } = image;
  const xs = axisSpans(sw, width);
  const rows = new Uint16Array(width * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    const rowIn = y * sw * 4;
    const rowOut = y * width * 4;
    for (let d = 0; d < width; d += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = xs.offsets[d]!; k < xs.offsets[d + 1]!; k += 1) {
        const i = rowIn + xs.index[k]! * 4;
        const alpha = src[i + 3]! * xs.weight[k]!;
        r += src[i]! * alpha;
        g += src[i + 1]! * alpha;
        b += src[i + 2]! * alpha;
        a += alpha;
      }
      const o = rowOut + d * 4;
      rows[o] = roundDiv(r, sw);
      rows[o + 1] = roundDiv(g, sw);
      rows[o + 2] = roundDiv(b, sw);
      rows[o + 3] = roundDiv(a * 255, sw);
    }
  }
  const ys = axisSpans(sh, height);
  const data = new Uint8Array(width * height * 4);
  for (let d = 0; d < height; d += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = ys.offsets[d]!; k < ys.offsets[d + 1]!; k += 1) {
        const i = (ys.index[k]! * width + x) * 4;
        const w = ys.weight[k]!;
        r += rows[i]! * w;
        g += rows[i + 1]! * w;
        b += rows[i + 2]! * w;
        a += rows[i + 3]! * w;
      }
      const o = (d * width + x) * 4;
      if (a > 0) {
        // Un-premultiply: mean(c·a) / mean(a·255) · 255.
        data[o] = Math.min(255, roundDiv(r * 255, a));
        data[o + 1] = Math.min(255, roundDiv(g * 255, a));
        data[o + 2] = Math.min(255, roundDiv(b * 255, a));
      }
      data[o + 3] = roundDiv(a, sh * 255);
    }
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
