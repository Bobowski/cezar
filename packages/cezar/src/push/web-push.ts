import {
  createECDH,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * Web Push with Node's own crypto (spec 2026-10-24-mobile-cockpit §3.5): VAPID (RFC 8292) for the
 * application server's identity and `aes128gcm` message encryption (RFC 8291 over RFC 8188). No
 * dependency — the whole protocol is one ECDH, two HKDFs, one AES-GCM and one ES256 signature.
 */

/** The VAPID key pair: `publicKey` is the uncompressed P-256 point, base64url (what the browser's
 *  `applicationServerKey` takes); `privateKey` the JWK the signature is made with. */
export interface VapidKeys {
  publicKey: string;
  privateKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string };
}

/** The browser's `PushSubscription.toJSON()`, the parts encryption needs. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromB64u = (text: string): Buffer => Buffer.from(text, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
    privateKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
  };
}

function signingKey(keys: VapidKeys): KeyObject {
  return createPrivateKey({ key: keys.privateKey, format: 'jwk' });
}

/** Who the push services may contact about this sender. Apple requires a `mailto:` or https URL. */
export const VAPID_SUBJECT = 'https://github.com/open-mercato/cezar';

/** `Authorization: vapid t=…, k=…` for one endpoint (RFC 8292 §2–§3). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: VAPID_SUBJECT })));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** The record size the header announces; one record always fits a push payload (≤ 4 KiB). */
const RECORD_SIZE = 4096;

/** What `encryptPayload` may be handed instead of fresh randomness — the RFC 8291 §5 vector. */
export interface EncryptionSeed {
  /** The sender's ephemeral ECDH private key (32 bytes). */
  senderPrivateKey?: Buffer;
  salt?: Buffer;
}

/** RFC 8291 §3.4: encrypt one push message body for one subscription. */
export function encryptPayload(target: PushTarget, plaintext: Buffer, seed: EncryptionSeed = {}): Buffer {
  const uaPublic = fromB64u(target.keys.p256dh);
  const authSecret = fromB64u(target.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth is not 16 bytes');
  const ecdh = createECDH('prime256v1');
  if (seed.senderPrivateKey) ecdh.setPrivateKey(seed.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = seed.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record, so it is the last: the delimiter is 0x02 and no padding follows.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export type PushOutcome = 'sent' | 'gone' | 'stale' | 'failed';

/**
 * POST one message to a push service. `gone` (404/410) means the browser dropped the
 * subscription — the caller deletes it. `stale` (401/403) means the push service no longer
 * accepts our VAPID key for it (the key rotated) — only the device can re-subscribe. A redirect
 * is `failed` and never followed: a push service never sends one, and following it would let a
 * public endpoint bounce our POST to an internal address. Never throws: a push is a courtesy.
 */
export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  let body: Buffer;
  try {
    body = encryptPayload(target, Buffer.from(JSON.stringify(payload)));
  } catch {
    return 'gone';
  }
  try {
    const response = await fetchImpl(target.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(target.endpoint, keys),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(24 * 3600),
        urgency: 'high',
      },
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 || response.status === 410) return 'gone';
    if (response.status === 401 || response.status === 403) return 'stale';
    return response.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
