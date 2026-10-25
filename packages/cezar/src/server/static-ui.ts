import { brandingLinks, manifestIcons, type BrandingState } from '../workspace/branding.ts';
import { accentStyleOf, deriveAccentTokens } from '../workspace/branding-accent.ts';

/** Which browser UI a request for `/` gets.
 *
 *  The React cockpit built to `web/dist` is the only web UI — the legacy
 *  vanilla page (`web/app.js` + friends) was deleted in phase R7 of the spec
 *  `.ai/specs/2026-07-14-cockpit-ui-redesign.md`. A checkout without a build
 *  gets a small built-in hint page (`build-hint`), never a 404.
 */
export type IndexTarget = 'dist' | 'build-hint';

/** Pick the response for `/`, given whether the build exists.
 *
 *  The published tarball always ships `web/dist`, so `build-hint` is a dev-only
 *  state (a fresh checkout that never ran `npm run build:web`) — the spec's
 *  degradation matrix answers it with a plain "run the build" page.
 */
export function resolveIndexHtml(opts: { distExists: boolean }): IndexTarget {
  return opts.distExists ? 'dist' : 'build-hint';
}

/** `passthrough` = not the SPA's to answer: `/api/*` keeps its JSON/SSE behavior
 *  and its own 404s, and the files with dedicated static routes keep being
 *  served by them. */
export type GetTarget = IndexTarget | 'passthrough';

/** The web manifest, rendered from branding (spec 2026-10-24-cockpit-branding §4). */
export const MANIFEST_PATH = '/manifest.webmanifest';

/** The service worker (spec 2026-10-24-mobile-cockpit §3.5), at the root so its scope is the
 *  whole cockpit. */
export const SERVICE_WORKER_PATH = '/sw.js';

/** Paths owned by routes registered before the catch-all: the built app's
 *  hashed bundles, the favicon, the manifest and the service worker. */
function isStaticAsset(path: string): boolean {
  return path.startsWith('/assets/') || path === '/icon.svg' || path === '/open-mercato.svg' || path === MANIFEST_PATH || path === SERVICE_WORKER_PATH;
}

/** Decide what any GET gets, so every route in the spec's map (`/tasks/:id/changes`,
 *  `/settings/skills`, …) cold-loads and survives a refresh — that is what makes a
 *  cockpit URL pasteable.
 *
 *  Unknown paths deliberately resolve to the shell, not a 404: react-router owns
 *  the 404 (it is the only side that knows the route map). Everything the server
 *  itself owns — `/api/*` and the static files above — passes through untouched.
 */
export function resolveGetRequest(opts: { path: string; distExists: boolean }): GetTarget {
  const { path, distExists } = opts;
  if (path === '/api' || path.startsWith('/api/') || isStaticAsset(path)) {
    return 'passthrough';
  }
  return resolveIndexHtml({ distExists });
}

/** The dev fallback page served for every shell route when `web/dist` is
 *  missing (spec degradation matrix: "run `npm run dev:web` or
 *  `npm run build:web`"). Built into the server so it needs no files on disk. */
export const BUILD_HINT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cezar — build the cockpit</title>
<style>
  body { margin: 0; display: grid; place-items: center; min-height: 100dvh;
         font: 15px/1.6 system-ui, sans-serif; background: #101014; color: #e8e8ea; }
  main { max-width: 34rem; padding: 2rem; }
  code { font-family: ui-monospace, monospace; background: #1c1c22; border-radius: 6px; padding: 2px 6px; }
  p { color: #a0a0aa; }
</style>
</head>
<body>
<main>
  <h1>The cockpit isn&rsquo;t built yet</h1>
  <p>This checkout has no <code>web/dist</code>. Run <code>npm run build:web</code>
  and reload — or use <code>npm run dev:web</code> for the live dev server.</p>
</main>
</body>
</html>
`;

const ASSET_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

/** True only for a plain filename the `/assets/:file` route may serve.
 *
 *  `basename` alone is not a guard here: `basename('..')` is `'..'`, which
 *  joins back to the assets dir itself and turns the route's `readFileSync`
 *  into an EISDIR crash (a 500) instead of a 404. Dot-segments, separators,
 *  and NUL all mean "not a file we ship" — the caller answers 404. */
export function isSafeAssetFilename(file: string): boolean {
  return (
    file.length > 0 &&
    file !== '.' &&
    file !== '..' &&
    !file.includes('/') &&
    !file.includes('\\') &&
    !file.includes('\0')
  );
}

/** Content type for a hashed file under `web/dist/assets/`. */
export function assetContentType(file: string): string {
  return ASSET_TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Vite fingerprints every filename under `assets/`, so the bytes behind a URL
 *  can never change — cache them for a year. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** …and the shell that NAMES those filenames must never be cached, which is the
 *  other half of the same rule. It went out with no cache header at all, so a
 *  browser was free to reuse it on its own judgement — and since every bundle it
 *  points at is `immutable`, a phone that kept one stale shell kept the whole
 *  stale app, across reloads, with no way for a user to tell. That is a cockpit
 *  that silently cannot be updated: `npm run build:web` changed the bytes on
 *  disk and the device went on running last week's cockpit.
 *
 *  `no-cache` rather than `no-store`: the response may be held, it just may not
 *  be reused without asking. The shell is ~5 KB and the assets beside it still
 *  carry the year. */
export const SHELL_CACHE_CONTROL = 'no-cache';

// ---- branding (spec 2026-10-24-cockpit-branding) ----------------------------------------------

/** The dark surfaces of `index.css`: the splash behind a launching PWA and its title bar. */
const MANIFEST_BACKGROUND = '#131316';
const MANIFEST_THEME = '#0b0b0d';

/** `/manifest.webmanifest`. `short_name` is what a home screen fits under an icon. */
export function renderManifest(state: BrandingState): string {
  const letters = [...state.name];
  return JSON.stringify({
    name: state.name,
    short_name: letters.length > 12 ? letters.slice(0, 12).join('').trimEnd() : state.name,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: MANIFEST_BACKGROUND,
    theme_color: MANIFEST_THEME,
    icons: manifestIcons(state),
  });
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/**
 * The built `index.html` with the brand in it: the `<title>`, every icon link and the manifest,
 * Open Graph for a link to the sign-in page, and the accent as custom properties on `<html>` (read
 * by `index.css`'s `[data-brand-accent]` rules) so it paints before the bundle runs. `origin` makes
 * `og:image` absolute, which link previews require.
 */
export function renderShellHtml(html: string, state: BrandingState, origin: string | null = null): string {
  const tokens = state.accent ? deriveAccentTokens(state.accent) : null;
  const head = [
    ...brandingLinks(state).map((link) =>
      `<link rel="${link.rel}" href="${escapeHtml(link.href)}"${link.type ? ` type="${link.type}"` : ''}${link.sizes ? ` sizes="${link.sizes}"` : ''} />`),
    `<meta property="og:title" content="${escapeHtml(state.name)}" />`,
    ...(state.urls['app-icon'] && origin ? [`<meta property="og:image" content="${escapeHtml(`${origin}${state.urls['app-icon']}`)}" />`] : []),
    ...(tokens ? [`<meta name="theme-color" content="${tokens.dark.primary}" />`] : []),
  ].join('\n    ');
  let out = html
    .replace(/[ \t]*<link\b[^>]*\brel=["'](?:icon|shortcut icon|apple-touch-icon|manifest)["'][^>]*>[ \t]*\r?\n?/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(state.name)}</title>`)
    .replace(/<\/head>/i, () => `  ${head}\n  </head>`);
  if (tokens) out = out.replace(/<html\b([^>]*)>/i, (_, attrs: string) => `<html${attrs} data-brand-accent style="${accentStyleOf(tokens)}">`);
  return out;
}

// ---- the service worker (spec 2026-10-24-mobile-cockpit §3.5, §5) -----------------------------

/** The hashed bundles a built shell names — what the worker precaches for an instant open. */
export function shellAssetPaths(html: string): string[] {
  return [...new Set([...html.matchAll(/["'(](\/assets\/[^"'()\s]+)["')]/g)].map((match) => match[1]!))].sort();
}

/**
 * `/sw.js`. It caches ONLY `/assets/*` — content-hashed, so a cached copy can never be stale —
 * and never the shell or an API response: data still comes from the one SSE stream and the
 * refetch on focus. `version` names the build, so a new build installs a new worker that drops
 * the old cache. It also shows a Web Push message (title + status) and opens its thread on a tap.
 */
export function renderServiceWorker(input: { version: string; assets: readonly string[]; icon: string | null }): string {
  const config = JSON.stringify({ cache: `cezar-assets-${input.version}`, assets: input.assets, icon: input.icon });
  return `/* cezar service worker — generated by the server, do not edit. */
'use strict';
const CONFIG = ${config};
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CONFIG.cache).then((cache) => cache.addAll(CONFIG.assets)).catch(() => undefined));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('cezar-assets-') && key !== CONFIG.cache).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/assets/')) return;
  event.respondWith(caches.open(CONFIG.cache).then(async (cache) => {
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
    return response;
  }));
});
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = {}; }
  const path = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/';
  const options = { body: typeof data.status === 'string' ? data.status : '', data: { url: path } };
  if (typeof data.tag === 'string') options.tag = data.tag;
  if (CONFIG.icon) options.icon = CONFIG.icon;
  event.waitUntil(self.registration.showNotification(typeof data.title === 'string' && data.title ? data.title : 'cezar', options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      const navigated = client.navigate ? client.navigate(target).catch(() => client) : Promise.resolve(client);
      return navigated.then((next) => (next || client).focus());
    }
    return self.clients.openWindow(target);
  }));
});
`;
}
