import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderManifest, renderShellHtml } from '../server/static-ui.ts';
import { contrastRatio, deriveAccentTokens, parseHexColor } from './branding-accent.ts';
import { decodePng, encodePng, type Rgba } from './branding-png.ts';
import { pngBomb } from './branding-png.testkit.ts';
import { sanitizeSvg } from './branding-svg.ts';
import {
  brandingBody,
  brandingDir,
  brandingState,
  deriveAppIcon,
  deriveFavicon,
  readBrandingAsset,
  removeBranding,
  saveBranding,
} from './branding.ts';

/** A solid square with a transparent quarter, so fitting and opacity both show. */
function fixture(width: number, height: number, rgb: readonly [number, number, number] = [200, 30, 90]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data.set([...rgb, x < width / 2 && y < height / 2 ? 0 : 255], i);
    }
  }
  return encodePng({ width, height, data });
}

const sizeOf = (bytes: Buffer): [number, number] => {
  const decoded = decodePng(bytes);
  if (!decoded.ok) throw new Error(decoded.error);
  return [decoded.image.width, decoded.image.height];
};

const pixel = (image: Rgba, x: number, y: number) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

describe('the favicon SVG sanitiser', () => {
  it('drops scripts, handlers, foreign objects, external images and links, and keeps the picture', () => {
    const result = sanitizeSvg(`<?xml version="1.0"?>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
        <script>alert(1)</script>
        <style>@import url(https://evil.test/x.css);</style>
        <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
        <foreignObject><iframe src="https://evil.test"/></foreignObject>
        <image href="https://evil.test/track.png" width="10" height="10"/>
        <a href="javascript:alert(1)"><rect width="1" height="1"/></a>
        <path id="p" d="M0 0h10v10H0z" fill="url(#g)" onclick="alert(1)"/>
        <rect width="5" height="5" fill="url(https://evil.test/p.svg#x)" style="fill:url(//evil.test/a)"/>
        <use xlink:href="#p"/><use href="https://evil.test/sprite.svg#a"/>
        <animate attributeName="href" to="javascript:alert(1)"/>
      </svg>`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { svg } = result;
    for (const gone of ['script', 'alert', 'onload', 'onclick', '<style', 'foreignObject', 'iframe', '<image', 'evil.test', '<a', 'animate', 'javascript']) {
      expect(svg, gone).not.toContain(gone);
    }
    expect(svg).toContain('<path id="p" d="M0 0h10v10H0z" fill="url(#g)"/>');
    expect(svg).toContain('xlink:href="#p"');
    expect(svg).toContain('<linearGradient id="g">');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('refuses rather than repairs: a DOCTYPE, entities, a non-SVG root, broken XML', () => {
    expect(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>').ok).toBe(false);
    expect(sanitizeSvg('<html xmlns="http://www.w3.org/1999/xhtml"><svg xmlns="http://www.w3.org/2000/svg"/></html>').ok).toBe(false);
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path></svg>').ok).toBe(false);
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/1999/xhtml"><path d="M0 0"/></svg>').ok).toBe(false);
  });

  it('serves a bare <svg> with the namespace it was parsed in', () => {
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')).toEqual({
      ok: true, svg: '<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    });
  });
});

describe('derived sizes', () => {
  it('a PNG favicon becomes 16, 32 and 48 px squares, fitted without stretching', () => {
    const result = deriveFavicon(fixture(64, 32));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => [file.asset, file.ext, sizeOf(file.bytes)])).toEqual([
      ['favicon-16', 'png', [16, 16]],
      ['favicon-32', 'png', [32, 32]],
      ['favicon-48', 'png', [48, 48]],
    ]);
    const decoded = decodePng(result.files[2]!.bytes);
    if (!decoded.ok) throw new Error(decoded.error);
    // 64×32 fits as 48×24: the bands above and below stay transparent.
    expect(pixel(decoded.image, 24, 2)[3]).toBe(0);
    expect(pixel(decoded.image, 40, 30)).toEqual([200, 30, 90, 255]);
  });

  it('an SVG favicon is kept as the vector, sanitised', () => {
    const result = deriveFavicon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>x()</script><rect width="1" height="1"/></svg>'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ asset: 'favicon', ext: 'svg' });
    expect(result.files[0]!.bytes.toString('utf8')).not.toContain('script');
  });

  it('refuses a favicon that is neither, or too small to read', () => {
    expect(deriveFavicon(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject({ ok: false });
    expect(deriveFavicon(fixture(8, 8))).toMatchObject({ ok: false, error: expect.stringContaining('16') });
  });

  it('an app icon becomes 512, 192, a maskable 512 and the 180 px apple-touch-icon', () => {
    const result = deriveAppIcon(fixture(600, 600));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => [file.asset, sizeOf(file.bytes)])).toEqual([
      ['app-icon', [512, 512]],
      ['app-icon-192', [192, 192]],
      ['app-icon-maskable', [512, 512]],
      ['apple-touch-icon', [180, 180]],
    ]);
    const decode = (index: number) => {
      const decoded = decodePng(result.files[index]!.bytes);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.image;
    };
    // The corner of the source is transparent, so the opaque ones stand on white…
    expect(pixel(decode(3), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(decode(2), 0, 0)).toEqual([255, 255, 255, 255]);
    // …and the maskable mark sits inside the 80% safe zone: its edge band is background.
    expect(pixel(decode(2), 511, 300)).toEqual([255, 255, 255, 255]);
    expect(pixel(decode(2), 400, 400)).toEqual([200, 30, 90, 255]);
    // The plain one keeps the transparency.
    expect(pixel(decode(0), 0, 0)[3]).toBe(0);
  });

  it('refuses an app icon that is not a square PNG of at least 512 px', () => {
    expect(deriveAppIcon(fixture(600, 500))).toMatchObject({ ok: false, error: expect.stringContaining('square') });
    expect(deriveAppIcon(fixture(256, 256))).toMatchObject({ ok: false, error: expect.stringContaining('512') });
    expect(deriveAppIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({ ok: false });
  });

  it('re-encodes: nothing but the pixels survives, and a decompression bomb is refused unopened', () => {
    const marker = Buffer.from('<script>polyglot</script>');
    const result = deriveAppIcon(Buffer.concat([fixture(512, 512), marker]));
    expect(result.ok).toBe(true);
    if (result.ok) for (const file of result.files) expect(file.bytes.includes(marker)).toBe(false);
    const bomb = Buffer.from(fixture(16, 16));
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    expect(decodePng(bomb)).toMatchObject({ ok: false, error: expect.stringContaining('2048') });
  });

  it('inflates within the header\'s byte budget, and refuses more than 2048² pixels', () => {
    expect(decodePng(pngBomb({ interlace: false, inflatedMiB: 64 }))).toMatchObject({ ok: false, error: expect.stringContaining('more image data') });
    const wide = Buffer.from(fixture(16, 16));
    wide.writeUInt32BE(2049, 16);
    wide.writeUInt32BE(2048, 20);
    expect(decodePng(wide)).toMatchObject({ ok: false, error: expect.stringContaining('2048') });
  });
});

describe('content-addressed storage', () => {
  const saved = process.env.CEZ_HOME;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-branding-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('names each file <asset>-<sha256[:12]>.<ext> under CEZ_HOME/branding and addresses it by that hash', async () => {
    const derived = deriveAppIcon(fixture(512, 512));
    if (!derived.ok) throw new Error(derived.error);
    await saveBranding('app-icon', derived.files);
    const files = readdirSync(brandingDir()).sort();
    expect(files).toHaveLength(4);
    for (const file of files) expect(file).toMatch(/^(app-icon|app-icon-192|app-icon-maskable|apple-touch-icon)-[0-9a-f]{12}\.png$/);
    const state = await brandingState({}, null);
    const hash = files.find((file) => file.startsWith('app-icon-') && !file.startsWith('app-icon-192') && !file.startsWith('app-icon-maskable'))!.slice(9, 21);
    expect(state.urls['app-icon']).toBe(`/api/v1/workspace/branding/app-icon?v=${hash}`);
    const stored = await readBrandingAsset('app-icon');
    expect(stored?.type).toBe('image/png');
    expect(stored?.bytes.equals(readFileSync(join(brandingDir(), files.find((file) => file.includes(hash))!)))).toBe(true);
  });

  it('a new upload replaces its whole group and nothing else; removal clears it', async () => {
    const first = deriveFavicon(fixture(32, 32));
    const second = deriveFavicon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'));
    const icon = deriveAppIcon(fixture(512, 512));
    if (!first.ok || !second.ok || !icon.ok) throw new Error('fixtures');
    await saveBranding('favicon', first.files);
    await saveBranding('app-icon', icon.files);
    await saveBranding('favicon', second.files);
    const assets = readdirSync(brandingDir()).map((file) => file.replace(/-[0-9a-f]{12}\.\w+$/, '')).sort();
    expect(assets).toEqual(['app-icon', 'app-icon-192', 'app-icon-maskable', 'apple-touch-icon', 'favicon']);
    await removeBranding(['favicon']);
    expect(Object.keys((await brandingState({}, null)).urls).sort()).toEqual(['app-icon', 'app-icon-192', 'app-icon-maskable', 'apple-touch-icon']);
    await removeBranding(['app-icon']);
    expect(brandingBody(await brandingState({}, null))).toEqual({
      name: 'cezar', logoUrl: null, faviconUrl: null, appIconUrl: null, accent: null, accentTokens: null, custom: false,
    });
  });

  it('no directory at all is cezar\'s own brand, never an error', async () => {
    expect((await brandingState({}, null)).urls).toEqual({});
    expect(await readBrandingAsset('favicon')).toBeNull();
  });
});

describe('the accent colour', () => {
  it('derives a fill, ink and ring per theme that meet the contrast rules', () => {
    for (const color of ['#a8f372', '#ffff00', '#000080', '#7c3aed', '#101010']) {
      const tokens = deriveAccentTokens(color)!;
      const rgb = (hex: string) => parseHexColor(hex)!;
      expect(contrastRatio(rgb(tokens.dark.primary), rgb('#131316')), `${color} dark fill`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(rgb(tokens.dark.primaryStrong), rgb('#131316')), `${color} dark ink`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb(tokens.light.primaryStrong), rgb('#ffffff')), `${color} light ink`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb(tokens.light.ring), rgb('#ffffff')), `${color} light ring`).toBeGreaterThanOrEqual(3);
      expect(tokens.light.primary).toBe(color);
      for (const theme of ['dark', 'light'] as const) {
        expect(contrastRatio(rgb(tokens[theme].primaryForeground), rgb(tokens[theme].primary)), `${color} ${theme} text on fill`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(deriveAccentTokens('lime')).toBeNull();
    expect(deriveAccentTokens('#abc')).toBeNull();
  });
});

describe('the rendered manifest and shell', () => {
  const SHELL = `<!DOCTYPE html>
<html lang="en">
  <head>
    <!-- a note -->
    <link rel="icon" href="/icon.svg" />
    <title>cezar</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

  it('is cezar\'s own by default', () => {
    const state = { name: 'cezar', logoUrl: null, accent: null, urls: {} };
    expect(JSON.parse(renderManifest(state))).toMatchObject({
      name: 'cezar', short_name: 'cezar', display: 'standalone', start_url: '/',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
    const html = renderShellHtml(SHELL, state);
    expect(html).toContain('<title>cezar</title>');
    expect(html.match(/rel="icon"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml" />');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).not.toContain('data-brand-accent');
    expect(html).not.toContain('og:image');
  });

  it('names the brand, its icons and accent, and escapes the operator\'s text', () => {
    const state = {
      name: 'Agents <&> "Lab" Workspace Ltd',
      logoUrl: null,
      accent: '#7c3aed',
      urls: {
        favicon: '/api/v1/workspace/branding/favicon?v=aaaaaaaaaaaa',
        'favicon-32': '/api/v1/workspace/branding/favicon-32?v=bbbbbbbbbbbb',
        'app-icon': '/api/v1/workspace/branding/app-icon?v=cccccccccccc',
        'app-icon-192': '/api/v1/workspace/branding/app-icon-192?v=dddddddddddd',
        'app-icon-maskable': '/api/v1/workspace/branding/app-icon-maskable?v=eeeeeeeeeeee',
        'apple-touch-icon': '/api/v1/workspace/branding/apple-touch-icon?v=ffffffffffff',
      },
    };
    const manifest = JSON.parse(renderManifest(state));
    expect(manifest.name).toBe(state.name);
    expect(manifest.short_name).toBe('Agents <&> "');
    expect(manifest.icons).toEqual([
      { src: state.urls['app-icon-192'], sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: state.urls['app-icon'], sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: state.urls['app-icon-maskable'], sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
    const html = renderShellHtml(SHELL, state, 'https://agents.example.com');
    expect(html).toContain('<title>Agents &lt;&amp;&gt; &quot;Lab&quot; Workspace Ltd</title>');
    expect(html).not.toContain('href="/icon.svg"');
    expect(html).toContain(`<link rel="icon" href="${state.urls['favicon-32']}" type="image/png" sizes="32x32" />`);
    expect(html).toContain(`<link rel="icon" href="${state.urls.favicon}" type="image/svg+xml" />`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${state.urls['apple-touch-icon']}" sizes="180x180" />`);
    expect(html).toContain(`<meta property="og:image" content="https://agents.example.com${state.urls['app-icon']}" />`);
    expect(html).toMatch(/<html lang="en" data-brand-accent style="--brand-dark-primary:#[0-9a-f]{6};[^"]*--brand-light-ring:#[0-9a-f]{6}">/);
  });

  it('without a favicon, the tab shows the logo, then the app icon', () => {
    const urls = { 'app-icon-192': '/a?v=1' };
    expect(renderShellHtml(SHELL, { name: 'x', logoUrl: null, accent: null, urls })).toContain('<link rel="icon" href="/a?v=1" type="image/png" sizes="192x192" />');
    const withLogo = renderShellHtml(SHELL, { name: 'x', logoUrl: '/api/v1/workspace/branding-logo?v=2', accent: null, urls });
    expect(withLogo.match(/rel="icon"/g)).toHaveLength(1);
    expect(withLogo).toContain('<link rel="icon" href="/api/v1/workspace/branding-logo?v=2" />');
  });
});
