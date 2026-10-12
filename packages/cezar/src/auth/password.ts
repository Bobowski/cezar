import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing (spec `2026-10-12-cockpit-authentication.md` §5.2): scrypt from `node:crypto`,
 * parameters stored WITH the hash so they can be raised without invalidating what is on disk.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP's scrypt floor (2^17, r=8, p=1) — about 128 MB and a few hundred ms per attempt. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC so one password typed on two keyboards hashes the same.
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return null;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  // A hand-edited cost must not become a denial of service: bound what a stored hash may ask for.
  if (!Number.isInteger(params.N) || params.N < 2 || params.N > 2 ** 20 || (params.N & (params.N - 1)) !== 0) return null;
  if (!Number.isInteger(params.r) || params.r < 1 || params.r > 32) return null;
  if (!Number.isInteger(params.p) || params.p < 1 || params.p > 16) return null;
  return { params, salt: Buffer.from(salt, 'base64'), key: Buffer.from(key, 'base64') };
}

/** False for a wrong password AND for an unparseable hash — never a throw on stored input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || parsed.key.length !== KEY_LENGTH) return false;
  try {
    return timingSafeEqual(await derive(password, parsed.salt, parsed.params), parsed.key);
  } catch {
    return false;
  }
}
