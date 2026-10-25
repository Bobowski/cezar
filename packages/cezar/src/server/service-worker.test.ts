import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { renderServiceWorker, resolveGetRequest, SERVICE_WORKER_PATH, shellAssetPaths } from './static-ui.ts';

/** `/sw.js` (spec 2026-10-24-mobile-cockpit §3.5, §5): caches only hashed assets, shows a push. */

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(input = { version: 'v1', assets: ['/assets/index-abc.js'], icon: '/icon-192.png' }) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(async () => undefined);
  const scope = {
    location: { origin: 'https://cezar.example.com' },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    registration: { showNotification },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: vi.fn(async () => null) },
  };
  runInNewContext(renderServiceWorker(input), { self: scope, caches: {}, URL, fetch: () => undefined });
  return { listeners, showNotification, scope };
}

describe('the service worker', () => {
  it('is a static path the SPA catch-all leaves alone', () => {
    expect(SERVICE_WORKER_PATH).toBe('/sw.js');
    expect(resolveGetRequest({ path: '/sw.js', distExists: true })).toBe('passthrough');
  });

  it('precaches exactly the hashed bundles the shell names', () => {
    const html = '<script type="module" src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index-def.css"><link rel="icon" href="/icon.svg">';
    expect(shellAssetPaths(html)).toEqual(['/assets/index-abc.js', '/assets/index-def.css']);
  });

  it('answers only same-origin /assets/ GETs — never the shell or an API response', () => {
    const { listeners } = loadWorker();
    const fetchListener = listeners.get('fetch')!;
    for (const url of ['https://cezar.example.com/api/v1/runs', 'https://cezar.example.com/', 'https://cezar.example.com/p/x/tasks/1', 'https://cdn.example.com/assets/x.js']) {
      const respondWith = vi.fn();
      fetchListener({ request: { method: 'GET', url }, respondWith });
      expect(respondWith, url).not.toHaveBeenCalled();
    }
    const respondWith = vi.fn();
    fetchListener({ request: { method: 'POST', url: 'https://cezar.example.com/assets/x.js' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('shows a push message as title + status, and refuses an off-origin url', async () => {
    const { listeners, showNotification } = loadWorker();
    const waits: Array<Promise<unknown>> = [];
    listeners.get('push')!({
      data: { json: () => ({ title: 'Fix login', status: 'Task needs review', url: '//evil.example/x', tag: 'cezar-run-1' }) },
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);
    expect(showNotification).toHaveBeenCalledWith('Fix login', { body: 'Task needs review', data: { url: '/' }, tag: 'cezar-run-1', icon: '/icon-192.png' });
  });
});
