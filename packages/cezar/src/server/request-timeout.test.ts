import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRequestTimeout } from './request-timeout.ts';

/** Send headers and a first byte of a 10-byte body, then stall; resolve with how it ended. */
function stalledUpload(server: Server, path: string, waitMs: number): Promise<string> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve) => {
    const req = request({ port, path, method: 'POST', headers: { 'content-length': '10' } }, (res) => resolve(`status ${res.statusCode}`));
    req.on('error', () => resolve('closed'));
    req.write('x');
    setTimeout(() => {
      resolve('still open');
      req.destroy();
    }, waitMs);
  });
}

describe('applyRequestTimeout (spec 2026-10-23-backup-restore §10)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('bounds every request but the exempt upload routes, with Node\'s own bound off', async () => {
    server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => res.end('ok'));
    });
    applyRequestTimeout(server, (path) => path === '/upload', 150);
    expect(server.requestTimeout).toBe(0);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const [other, upload] = await Promise.all([
      stalledUpload(server, '/api/v1/other?x=1', 600),
      stalledUpload(server, '/upload?code=1', 600),
    ]);
    expect(other).toMatch(/status 408|closed/);
    expect(upload).toBe('still open');
  });
});
