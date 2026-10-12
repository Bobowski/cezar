import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238 over RFC 4226): SHA-1, 6 digits, 30 s — the profile every authenticator app
 * implements. Small enough to own, and pinned to the RFC's test vectors in `totp.test.ts`.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Null on anything that is not base32 — a stored seed is input, not a guarantee. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  if (clean === '') return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * The time step `code` is valid for, or null. Accepts one step either side for clock drift, and
 * only a step AFTER `lastStep`, so a code that was just used cannot be used again (§5.2).
 */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep = -1): number | null {
  const key = base32Decode(secret);
  const candidate = code.replace(/\s+/g, '');
  if (!key || !/^\d{6}$/.test(candidate)) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // No early exit: every window is computed, so timing does not say which one matched.
  for (const step of [current - 1, current, current + 1]) {
    const equal = timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(candidate));
    if (equal && step > lastStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(account: string, secret: string, issuer = 'cezar'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
