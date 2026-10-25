import { isLoopbackHostHeader } from '../capabilities.ts';

/**
 * Whether a loopback page brings its own hot reload, read from its HTML by the server (spec
 * 2026-10-24-cockpit-polish §3.2): a local cockpit frames the page directly, and where that page
 * is cross-origin the cockpit cannot read its document — but this process can fetch it.
 */

const PROBE_TIMEOUT_MS = 3_000;
/** A dev server's shell page; past this the markers would have been seen already. */
const PROBE_MAX_BYTES = 512 * 1024;

/** Script markers a hot-reload or live-reload client leaves in a page's HTML. */
const HMR_MARKERS: RegExp[] = [
  /\/@vite\/client/, // Vite
  /__vite_plugin_react_preamble_installed__/,
  /"buildId"\s*:\s*"development"/, // Next (pages router, dev)
  /\/_next\/static\/chunks\/(webpack|react-refresh)\.js/, // Next (dev chunks are unhashed)
  /\/_next\/webpack-hmr|__webpack_hmr|webpack-dev-server/, // webpack-dev-server, hot middleware
  /livereload\.js|browser-sync-client/, // a reload client already reloads the page itself
];

export function hmrFromHtml(html: string): 'connected' | 'none' {
  return HMR_MARKERS.some((marker) => marker.test(html)) ? 'connected' : 'none';
}

/** `http://localhost:5173/app` from what the cockpit framed, or why it will not be fetched. */
export function parseProbeTarget(raw: string, forbiddenPorts: number[] = []): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not an address' };
  }
  if (url.protocol !== 'http:') return { ok: false, reason: 'only local http:// pages are probed' };
  if (!isLoopbackHostHeader(url.host) || url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'only local http:// pages are probed' };
  }
  if (forbiddenPorts.includes(url.port === '' ? 80 : Number(url.port))) return { ok: false, reason: 'that is cezar itself' };
  url.hash = '';
  return { ok: true, url };
}

/** One GET of the page, no redirects followed; null when it could not be read as a page. */
export async function probeHmr(url: URL, fetcher: typeof fetch = fetch): Promise<'connected' | 'none' | null> {
  try {
    const response = await fetcher(url, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return null;
    if (!(response.headers.get('content-type') ?? '').includes('html')) {
      await response.body.cancel().catch(() => {});
      return 'none';
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let read = 0;
    while (read < PROBE_MAX_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += chunk.value.byteLength;
      html += decoder.decode(chunk.value, { stream: true });
      if (hmrFromHtml(html) === 'connected') break;
    }
    await reader.cancel().catch(() => {});
    return hmrFromHtml(html);
  } catch {
    return null;
  }
}
