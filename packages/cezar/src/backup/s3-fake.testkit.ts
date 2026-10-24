import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/** An in-memory S3 that checks what a real one checks: a signature header and the payload hash. */
export function fakeS3(bucket: string): { server: Server; objects: Map<string, Buffer>; requests: string[] } {
  const objects = new Map<string, Buffer>();
  const requests: string[] = [];
  const body = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=key/')) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code><Message>no signature</Message></Error>');
      return;
    }
    const [, name, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (name !== bucket) {
      res.writeHead(404).end('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>');
      return;
    }
    if (req.method === 'HEAD') return void res.writeHead(200).end();
    if (req.method === 'PUT') {
      const bytes = await body(req);
      if (createHash('sha256').update(bytes).digest('hex') !== req.headers['x-amz-content-sha256']) {
        res.writeHead(400).end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
        return;
      }
      objects.set(key, bytes);
      return void res.writeHead(200).end();
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      return void res.writeHead(204).end();
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      // Two per page, to walk the continuation token.
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = keys.slice(start, start + 2);
      const more = start + 2 < keys.length;
      const contents = page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${objects.get(k)!.length}</Size><LastModified>2026-10-23T03:00:00.000Z</LastModified></Contents>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' }).end(
        `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
      return;
    }
    res.writeHead(400).end();
  });
  return { server, objects, requests };
}
