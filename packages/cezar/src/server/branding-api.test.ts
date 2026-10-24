import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceBrandingSchema, type WorkspaceBranding } from '@open-mercato/cezar-contract';
import { workspaceConfigPath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { encodePng } from '../workspace/branding-png.ts';
import { pngBomb } from '../workspace/branding-png.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** `/api/v1/workspace/branding*` and `/manifest.webmanifest` (spec 2026-10-24-cockpit-branding §4). */

function square(size: number): Buffer {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) data.set([20, 120, 220, 255], i * 4);
  return encodePng({ width: size, height: size, data });
}

describe('the cockpit branding API', () => {
  const saved = { home: process.env.CEZ_HOME, remote: process.env.CEZ_REMOTE, auth: process.env.CEZ_AUTH };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-branding-api-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_AUTH;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-branding-api-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_REMOTE', saved.remote], ['CEZ_AUTH', saved.auth]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const json = (method: string, path: string, body?: unknown) =>
    apiRequest(app, path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const branding = async (response: Response | Promise<Response>): Promise<WorkspaceBranding> => {
    const answer = await response;
    expect(answer.status).toBe(200);
    return workspaceBrandingSchema.parse(await answer.json());
  };
  const logoForm = () => {
    const form = new FormData();
    form.set('file', new File([square(26)], 'logo.png', { type: 'image/png' }));
    return form;
  };
  const upload = (kind: string, bytes: Buffer) => json('PUT', `/api/v1/workspace/branding/${kind}`, { data: bytes.toString('base64') });

  it('answers cezar\'s own brand with no state at all', async () => {
    expect(await branding(apiRequest(app, '/api/v1/workspace/branding'))).toEqual({
      name: 'cezar', logoUrl: null, faviconUrl: null, appIconUrl: null, accent: null, accentTokens: null, custom: false,
    });
    const manifest = await apiRequest(app, '/manifest.webmanifest');
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    expect(await manifest.json()).toMatchObject({ name: 'cezar', icons: [{ src: '/icon.svg' }] });
  });

  it('renames, colours, uploads and serves — every URL content-addressed', async () => {
    const named = await branding(json('PUT', '/api/v1/workspace/branding', { name: 'Agents', accent: '#7C3AED' }));
    expect(named).toMatchObject({ name: 'Agents', accent: '#7c3aed', custom: true });
    expect(named.accentTokens?.light.primary).toBe('#7c3aed');
    expect(JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')).branding).toEqual({ name: 'Agents', accent: '#7c3aed' });
    // The config route still reads the same name.
    expect(((await (await apiRequest(app, '/api/v1/workspace/config')).json()) as { branding: { name: string } }).branding.name).toBe('Agents');

    const icon = await branding(upload('app-icon', square(512)));
    expect(icon.appIconUrl).toMatch(/^\/api\/v1\/workspace\/branding\/app-icon\?v=[0-9a-f]{12}$/);
    expect(icon.faviconUrl).toBeNull();
    const served = await apiRequest(app, icon.appIconUrl!);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="x()"><rect width="1" height="1"/></svg>';
    const favicon = await branding(upload('favicon', Buffer.from(svg)));
    expect(favicon.faviconUrl).toMatch(/^\/api\/v1\/workspace\/branding\/favicon\?v=[0-9a-f]{12}$/);
    const vector = await apiRequest(app, favicon.faviconUrl!);
    expect(vector.headers.get('content-type')).toBe('image/svg+xml');
    expect(await vector.text()).not.toContain('onload');

    const manifest = await (await apiRequest(app, '/manifest.webmanifest')).json() as { name: string; icons: Array<{ purpose?: string; sizes: string }> };
    expect(manifest.name).toBe('Agents');
    expect(manifest.icons.map((entry) => `${entry.sizes} ${entry.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const size of ['app-icon-192', 'app-icon-maskable', 'apple-touch-icon']) {
      expect((await apiRequest(app, `/api/v1/workspace/branding/${size}`)).status).toBe(200);
    }
  });

  it('refuses what it cannot make an icon of, and writes nothing', async () => {
    const tooSmall = await upload('app-icon', square(128));
    expect(tooSmall.status).toBe(400);
    expect(((await tooSmall.json()) as { error: string }).error).toContain('512');
    expect((await upload('favicon', Buffer.from('<svg><script>'))).status).toBe(400);
    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(100_000)}${'</g>'.repeat(100_000)}</svg>`;
    expect((await upload('favicon', Buffer.from(deep))).status).toBe(400);
    expect((await upload('logo', square(64))).status).toBe(400); // the logo keeps its own route
    // A 16 × 16 interlaced header over 256 MiB of zeros: refused before anything is inflated.
    const bomb = await upload('favicon', pngBomb({ interlace: true, inflatedMiB: 256 }));
    expect(bomb.status).toBe(400);
    expect(((await bomb.json()) as { error: string }).error).toContain('interlaced');
    expect((await json('PUT', '/api/v1/workspace/branding', { accent: 'lime' })).status).toBe(400);
    expect(existsSync(join(home, 'branding'))).toBe(false);
    expect((await apiRequest(app, '/api/v1/workspace/branding/favicon')).status).toBe(404);
    expect((await apiRequest(app, '/api/v1/workspace/branding/config.json')).status).toBe(400);
  });

  it('removes one kind, and Reset restores every default in one call', async () => {
    await branding(json('PUT', '/api/v1/workspace/branding', { name: 'Agents', accent: '#123456' }));
    await branding(upload('app-icon', square(512)));
    await branding(upload('favicon', square(48)));
    expect((await apiRequest(app, '/api/v1/workspace/branding-logo', { method: 'POST', body: logoForm() })).status).toBe(200);

    const withoutIcon = await branding(json('DELETE', '/api/v1/workspace/branding/app-icon'));
    expect(withoutIcon.appIconUrl).toBeNull();
    expect(withoutIcon.faviconUrl).not.toBeNull();
    const withoutLogo = await branding(json('DELETE', '/api/v1/workspace/branding/logo'));
    expect(withoutLogo.logoUrl).toBeNull();

    const reset = await branding(json('DELETE', '/api/v1/workspace/branding'));
    expect(reset).toEqual({ name: 'cezar', logoUrl: null, faviconUrl: null, appIconUrl: null, accent: null, accentTokens: null, custom: false });
    expect(readdirSync(join(home, 'branding'))).toEqual([]);
    expect(JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')).branding).toEqual({});
  });

  it('changes only for a trusted operator — never on a hosted cockpit without sign-in', async () => {
    process.env.CEZ_REMOTE = '1';
    process.env.CEZ_AUTH = '0';
    for (const response of [
      json('PUT', '/api/v1/workspace/branding', { name: 'Hijacked' }),
      upload('favicon', square(48)),
      json('DELETE', '/api/v1/workspace/branding/favicon'),
      json('DELETE', '/api/v1/workspace/branding'),
      // The settings route's older spelling of the same name.
      json('PUT', '/api/v1/workspace/config', { branding: { name: 'Hijacked' } }),
      json('PUT', '/api/v1/workspace/config', { branding: { name: null } }),
      // The older logo routes too (BACKWARD_COMPATIBILITY.md §2 records the change).
      apiRequest(app, '/api/v1/workspace/branding-logo', { method: 'POST', body: logoForm() }),
      apiRequest(app, '/api/v1/workspace/branding-logo', { method: 'DELETE' }),
    ]) {
      expect((await response).status).toBe(409);
    }
    expect((await branding(apiRequest(app, '/api/v1/workspace/branding'))).name).toBe('cezar');
    // The rest of the settings route is not this gate's business.
    expect((await json('PUT', '/api/v1/workspace/config', { skillsAutoUpdate: false })).status).toBe(200);
  });
});
