import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewHmrProbeResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { hmrFromHtml } from './preview/hmr-probe.ts';
import { createApp } from './server.ts';

/**
 * `POST /api/v1/preview/hmr-probe` (spec 2026-10-24-cockpit-polish §3.2): a local cockpit cannot
 * read a cross-origin page it frames, so the server fetches the page once and reads its HTML.
 */
describe('the preview HMR probe', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedRemote = process.env.CEZ_REMOTE;

  const page = (html: string, type = 'text/html; charset=utf-8') =>
    vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': type } }));
  const makeApp = (previewProbeFetch: typeof fetch): Hono =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', previewProbeFetch });
  const probe = (app: Hono, target: string) =>
    apiRequest(app, '/api/v1/preview/hmr-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' },
      body: JSON.stringify({ target }),
    });

  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-hmr-probe-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  it('reads a Vite page as hot-reloading, a plain one as not, in the contract shape', async () => {
    const vite = page('<html><head><script type="module" src="/@vite/client"></script></head></html>');
    const res = await probe(makeApp(vite as unknown as typeof fetch), 'http://localhost:5173/app#top');
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(previewHmrProbeResponseSchema.parse(body)).toEqual({ hmr: 'connected' });
    expect(String((vite.mock.calls[0] as unknown[])[0])).toBe('http://localhost:5173/app');
    const plain = page('<html><body><p>static</p></body></html>');
    expect(await (await probe(makeApp(plain as unknown as typeof fetch), 'http://localhost:8080/')).json()).toEqual({ hmr: 'none' });
  });

  it('answers null for a page it could not read', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await (await probe(makeApp(down as unknown as typeof fetch), 'http://localhost:5173/')).json()).toEqual({ hmr: null });
  });

  it('fetches only loopback http:// pages, never cezar itself, and only on a local cockpit', async () => {
    const fetcher = page('<p>x</p>');
    const app = makeApp(fetcher as unknown as typeof fetch);
    expect((await probe(app, 'http://example.com/')).status).toBe(400);
    expect((await probe(app, 'https://localhost:5173/')).status).toBe(400);
    expect((await probe(app, 'http://127.0.0.1:4317/')).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    process.env.CEZ_REMOTE = '1';
    expect((await probe(makeApp(fetcher as unknown as typeof fetch), 'http://localhost:5173/')).status).toBe(409);
  });

  it('knows Next, webpack-dev-server and live-reload clients', () => {
    expect(hmrFromHtml('<script id="__NEXT_DATA__">{"props":{},"buildId":"development"}</script>')).toBe('connected');
    expect(hmrFromHtml('<script src="/_next/static/chunks/webpack.js"></script>')).toBe('connected');
    expect(hmrFromHtml('<script src="/_next/static/chunks/webpack-3f2a1b.js"></script>')).toBe('none');
    expect(hmrFromHtml('<script src="/livereload.js?port=35729"></script>')).toBe('connected');
  });
});
