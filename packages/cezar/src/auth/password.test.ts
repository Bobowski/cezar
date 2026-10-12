import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('password hashing', () => {
  it('verifies the password it hashed and no other', async () => {
    const stored = await hashPassword('correct horse battery', FAST);
    expect(stored.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
  });

  it('salts: one password, two hashes', async () => {
    expect(await hashPassword('same password here', FAST)).not.toBe(await hashPassword('same password here', FAST));
  });

  it('treats two spellings of one character as one password', async () => {
    const stored = await hashPassword('café-password', FAST);
    expect(await verifyPassword('café-password', stored)).toBe(true);
  });

  it('answers false, never throws, for a hash it cannot use', async () => {
    for (const stored of ['', 'bcrypt$x', 'scrypt$1000$8$1$AAAA$AAAA', 'scrypt$1073741824$8$1$AAAA$AAAA', 'scrypt$1024$8$1$$']) {
      expect(await verifyPassword('anything at all', stored)).toBe(false);
    }
  });
});
