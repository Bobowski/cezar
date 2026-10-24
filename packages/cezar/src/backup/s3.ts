import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * Just enough S3 for an off-box copy (spec `2026-10-23-backup-restore.md` §4): HEAD the bucket,
 * PUT, LIST and DELETE an object, signed with SigV4 by hand — R2, B2, MinIO and AWS all speak it,
 * and an SDK would be the largest dependency in the package for four calls. Path-style URLs
 * (`<endpoint>/<bucket>/<key>`), which every one of those accepts.
 */

export interface S3Target {
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

export class S3Error extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** RFC 3986 encoding, as SigV4 wants it (`encodeURIComponent` leaves `!'()*` alone). */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeKeyPath(key: string): string {
  return key.split('/').map(encode).join('/');
}

/**
 * Sign one request (AWS SigV4, service `s3`). `headers` are the ones to send and sign besides
 * `host`, `x-amz-date` and `x-amz-content-sha256`, which this adds. Returns every header to send.
 */
export function signV4(input: {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams.entries()]
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalRequest = [input.method, input.url.pathname || '/', query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]!) : undefined;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class S3Client {
  private readonly base: string;

  constructor(
    private readonly target: S3Target,
    private readonly options: { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number } = {},
  ) {
    this.base = target.endpoint.replace(/\/+$/, '');
  }

  /** `<prefix>/<name>`, with exactly one slash between them. */
  keyFor(name: string): string {
    const prefix = this.target.prefix.replace(/^\/+|\/+$/g, '');
    return prefix ? `${prefix}/${name}` : name;
  }

  private url(key?: string, query?: Record<string, string>): URL {
    const url = new URL(`${this.base}/${encode(this.target.bucket)}${key ? `/${encodeKeyPath(key)}` : ''}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private async send(
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; payloadHash?: string; body?: ReadableStream<Uint8Array>; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers = signV4({
      method,
      url,
      headers: init.headers,
      payloadHash: init.payloadHash ?? EMPTY_SHA256,
      region: this.target.region,
      accessKeyId: this.target.accessKeyId,
      secretAccessKey: this.target.secretAccessKey,
      now: (this.options.now ?? (() => new Date()))(),
    });
    // `host` is the fetch's own business; sending it explicitly is refused by undici.
    delete headers.host;
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(init.body ? { body: init.body, duplex: 'half' } : {}),
        signal: AbortSignal.timeout(init.timeoutMs ?? this.options.timeoutMs ?? 30_000),
      } as RequestInit);
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause?.message;
      throw new S3Error(`could not reach ${url.host}${cause ? ` (${cause})` : error instanceof Error ? ` (${error.message})` : ''}`);
    }
    if (!response.ok) {
      const text = method === 'HEAD' ? '' : await response.text().catch(() => '');
      const code = xmlText(text, 'Code');
      const message = xmlText(text, 'Message');
      const reason =
        response.status === 403 ? 'access denied — check the key and its permissions on the bucket'
        : response.status === 404 ? 'the bucket does not exist at this endpoint'
        : `HTTP ${response.status}`;
      throw new S3Error(code ? `${code}${message ? `: ${message}` : ''}` : reason, response.status);
    }
    return response;
  }

  async headBucket(): Promise<void> {
    const response = await this.send('HEAD', this.url());
    void response.body?.cancel().catch(() => {});
  }

  async putFile(name: string, path: string, size: number): Promise<string> {
    const key = this.keyFor(name);
    const payloadHash = await fileSha256(path);
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
    const response = await this.send('PUT', this.url(key), {
      headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
      payloadHash,
      body,
      // A big archive over a slow uplink: an hour, not thirty seconds.
      timeoutMs: 60 * 60_000,
    });
    void response.body?.cancel().catch(() => {});
    return key;
  }

  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const xml = await (await this.send('GET', this.url(undefined, query))).text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = match[1]!;
        const key = xmlText(block, 'Key');
        if (!key) continue;
        out.push({ key, size: Number(xmlText(block, 'Size') ?? 0), lastModified: xmlText(block, 'LastModified') ?? '' });
      }
      token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : undefined;
      if (!token) break;
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', this.url(key));
    void response.body?.cancel().catch(() => {});
  }
}
