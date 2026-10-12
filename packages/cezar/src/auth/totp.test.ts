import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpStep, verifyTotp } from './totp.ts';

// RFC 6238 Appendix B, SHA-1 rows, truncated to the 6 digits this profile uses.
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: Array<[seconds: number, code: string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('totp', () => {
  it.each(RFC_VECTORS)('matches RFC 6238 at T=%i', (seconds, code) => {
    expect(hotp(RFC_KEY, totpStep(seconds * 1000))).toBe(code);
  });

  it('round-trips base32 and rejects what is not base32', () => {
    expect(base32Encode(RFC_KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toEqual(RFC_KEY);
    expect(base32Decode('not base32!')).toBeNull();
    expect(base32Decode('')).toBeNull();
  });

  const secret = base32Encode(RFC_KEY);
  const now = 1111111109_000;

  it('accepts the current code and one step of drift either side, nothing further', () => {
    const step = totpStep(now);
    expect(verifyTotp(secret, hotp(RFC_KEY, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(RFC_KEY, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(RFC_KEY, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(RFC_KEY, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, hotp(RFC_KEY, step + 2), now)).toBeNull();
  });

  it('refuses a code at or before the last accepted step', () => {
    const step = totpStep(now);
    const code = hotp(RFC_KEY, step);
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, code, now, step - 1)).toBe(step);
  });

  it('refuses malformed codes and an unusable seed without throwing', () => {
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
    expect(verifyTotp('!!!', '123456', now)).toBeNull();
  });

  it('mints a 160-bit seed and a URI authenticator apps read', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
    expect(otpauthUri('mateusz', 'ABC')).toBe(
      'otpauth://totp/cezar:mateusz?secret=ABC&issuer=cezar&algorithm=SHA1&digits=6&period=30',
    );
  });
});
