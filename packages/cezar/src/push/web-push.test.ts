import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encryptPayload, generateVapidKeys, sendWebPush, vapidAuthorization, type PushTarget } from './web-push.ts';

const b = (text: string) => Buffer.from(text, 'base64url');

/** RFC 8291 §5, the worked example. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The user agent's side, written from the RFC independently of the sender. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const record = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString();
}

describe('web push encryption (RFC 8291)', () => {
  it('reproduces the RFC 8291 §5 example byte for byte', () => {
    const target: PushTarget = { endpoint: 'https://push.example.net/x', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };
    const out = encryptPayload(target, Buffer.from(RFC.plaintext), { senderPrivateKey: b(RFC.asPrivate), salt: b(RFC.salt) });
    expect(out.toString('base64url')).toBe(RFC.body);
  });

  it('round-trips with fresh keys and salt', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const target: PushTarget = { endpoint: 'https://push.example.net/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    const out = encryptPayload(target, Buffer.from('{"title":"t"}'));
    expect(decrypt(out, ua.getPrivateKey(), auth)).toBe('{"title":"t"}');
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a JWT for the endpoint origin that verifies against the public key', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 1_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b(claims!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000 + 12 * 3600, sub: expect.stringMatching(/^https:\/\//) });
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: keys.privateKey.x, y: keys.privateKey.y }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(signature!))).toBe(true);
  });
});

describe('sendWebPush', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const target: PushTarget = { endpoint: 'https://push.example.net/sub/1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
  const keys = generateVapidKeys();

  it('posts an aes128gcm body with VAPID authorization', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    expect(await sendWebPush(target, { title: 'x' }, keys, fetchImpl as unknown as typeof fetch)).toBe('sent');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.authorization).toMatch(/^vapid t=/);
  });

  it('reports a dropped subscription as gone and a network error as failed', async () => {
    expect(await sendWebPush(target, {}, keys, (async () => new Response(null, { status: 410 })) as unknown as typeof fetch)).toBe('gone');
    expect(await sendWebPush(target, {}, keys, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBe('failed');
  });

  it('reports a subscription made with another VAPID key (401/403) as stale', async () => {
    for (const status of [401, 403]) {
      expect(await sendWebPush(target, {}, keys, (async () => new Response(null, { status })) as unknown as typeof fetch)).toBe('stale');
    }
  });

  it('never follows a redirect: a 307 is failed, and its location is never posted to', async () => {
    // Fetch's own semantics: `redirect: 'error'` rejects on a 3xx; the default follows it.
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(url);
      if (init.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect');
      if (init.redirect === 'manual') return new Response(null, { status: 307, headers: { location: 'https://169.254.169.254/x' } });
      calls.push('https://169.254.169.254/x');
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendWebPush(target, {}, keys, fetchImpl)).toBe('failed');
    expect(calls).toEqual([target.endpoint]);
  });

  it('reports a redirect status that reaches it as failed, never sent', async () => {
    const fetchImpl = (async () => new Response(null, { status: 307, headers: { location: 'https://x.example/' } })) as unknown as typeof fetch;
    expect(await sendWebPush(target, {}, keys, fetchImpl)).toBe('failed');
  });
});
