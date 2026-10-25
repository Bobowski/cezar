import { describe, expect, it, vi } from 'vitest';

import { hmrFromHtml, probeHmr } from './hmr-probe.ts';

/** The server's one read of a loopback page (spec 2026-10-24-cockpit-polish §3.2). */

const URL_ = new URL('http://localhost:3000/');
const asFetch = (fn: (...args: unknown[]) => Promise<Response>) => vi.fn(fn) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('hmrFromHtml', () => {
  it('knows the Turbopack-era Next dev client, Astro, SvelteKit and Remix', () => {
    expect(hmrFromHtml('<script src="/_next/static/chunks/%5Bturbopack%5D_browser_dev_hmr-client.js"></script><script>self.__turbopack_load__</script>')).toBe('connected');
    expect(hmrFromHtml('<script src="/_next/static/chunks/node_modules_next_dist_compiled_react-dom_1e674e._.js"></script>')).toBe('connected');
    expect(hmrFromHtml('<script type="module" src="/@id/astro:scripts/page.js"></script>')).toBe('connected');
    expect(hmrFromHtml('import("/@fs/app/node_modules/@sveltejs/kit/src/runtime/client/entry.js")')).toBe('connected');
    expect(hmrFromHtml('<script type="module" src="/@id/__x00__virtual:remix/inject-hmr-runtime"></script>')).toBe('connected');
  });

  it('a production build of the same stacks is not hot reload', () => {
    expect(hmrFromHtml('<script src="/_next/static/chunks/main-app-8c1f2a.js" async></script>')).toBe('none');
    expect(hmrFromHtml('<script type="module" src="/_astro/hoisted.a1b2c3.js"></script>')).toBe('none');
    expect(hmrFromHtml('import("/_app/immutable/entry/start.4f2a.js")')).toBe('none');
  });
});

describe('probeHmr', () => {
  it('follows no redirect: a 3xx is a page it could not read', async () => {
    const fetcher = asFetch(async () => new Response(null, { status: 302, headers: { location: 'http://evil.example/' } }));
    expect(await probeHmr(URL_, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as [URL, RequestInit])[1].redirect).toBe('manual');
  });

  it('a non-HTML answer is no page with hot reload, and its body is not read', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetcher = asFetch(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await probeHmr(URL_, fetcher)).toBe('none');
    expect(cancel).toHaveBeenCalled();
  });

  it('reads at most 512 KiB: a marker past the cap is not seen, and the rest is never pulled', async () => {
    const chunk = new TextEncoder().encode(`<!--${'x'.repeat(64 * 1024 - 7)}-->`);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(pulled > 8 ? new TextEncoder().encode('<script src="/@vite/client"></script>') : chunk);
        if (pulled > 64) controller.close();
      },
    });
    const fetcher = asFetch(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await probeHmr(URL_, fetcher)).toBe('none');
    expect(pulled).toBeLessThan(16);
  });

  it('a marker inside the cap is seen', async () => {
    const fetcher = asFetch(async () => new Response('<script src="/@vite/client"></script>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await probeHmr(URL_, fetcher)).toBe('connected');
  });
});
