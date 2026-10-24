import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BRANDING_ASSETS,
  type BrandingAsset,
  type BrandingUploadKind,
  type WorkspaceBranding,
} from '@open-mercato/cezar-contract';
import { renameWithRetry } from '../fs-rename.ts';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { deriveAccentTokens } from './branding-accent.ts';
import { backdropOf, decodePng, encodePng, fitSquare, isPng, resize, type Rgba } from './branding-png.ts';
import { sanitizeSvg } from './branding-svg.ts';

/**
 * Cockpit branding files (spec `.ai/specs/2026-10-24-cockpit-branding.md`): the favicon and the
 * app icon an operator uploads, and every size derived from them, as
 * `<CEZ_HOME>/branding/<asset>-<sha256[:12]>.<ext>` — the project icons' content-addressed scheme,
 * so a new upload is a new URL and nothing has to forget a cached image. Written, never required:
 * delete the directory and the cockpit is cezar's own again. The logo keeps its older single file
 * beside the config (`branding-logo`, server.ts) and is not stored here.
 */

export const DEFAULT_BRAND_NAME = 'cezar';

/** The assets each upload writes; an upload replaces its whole group. */
export const BRANDING_GROUPS: Record<BrandingUploadKind, readonly BrandingAsset[]> = {
  favicon: ['favicon', 'favicon-16', 'favicon-32', 'favicon-48'],
  'app-icon': ['app-icon', 'app-icon-192', 'app-icon-maskable', 'apple-touch-icon'],
};

const TYPES = { png: 'image/png', svg: 'image/svg+xml' } as const;
type Extension = keyof typeof TYPES;
const FILE_RE = new RegExp(`^(${BRANDING_ASSETS.join('|')})-([0-9a-f]{12})\\.(png|svg)$`);

export const brandingDir = (env: NodeJS.ProcessEnv = process.env): string => join(cezarHomeDir(env), 'branding');

export interface DerivedFile {
  asset: BrandingAsset;
  ext: Extension;
  bytes: Buffer;
}
export type DeriveResult = { ok: true; files: DerivedFile[] } | { ok: false; error: string };

/** The longest side any size is derived from; a larger upload is reduced to it once. */
const WORKING_SIZE = 1024;

// Derivation is CPU work on the server's one thread, so it yields a turn between steps.
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function workingImage(image: Rgba): Promise<Rgba> {
  await nextTurn();
  const longest = Math.max(image.width, image.height);
  if (longest <= WORKING_SIZE) return image;
  const scale = WORKING_SIZE / longest;
  const reduced = resize(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  await nextTurn();
  return reduced;
}

async function renderEach(steps: ReadonlyArray<readonly [BrandingAsset, () => Rgba]>): Promise<DerivedFile[]> {
  const files: DerivedFile[] = [];
  for (const [asset, render] of steps) {
    files.push({ asset, ext: 'png', bytes: encodePng(render()) });
    await nextTurn();
  }
  return files;
}

/** SVG is sanitised and kept as the vector favicon; PNG becomes 16, 32 and 48 px squares. */
export async function deriveFavicon(bytes: Buffer): Promise<DeriveResult> {
  if (isPng(bytes)) {
    const decoded = decodePng(bytes);
    if (!decoded.ok) return decoded;
    if (Math.min(decoded.image.width, decoded.image.height) < 16) return { ok: false, error: 'a favicon PNG is at least 16 × 16 pixels' };
    const image = await workingImage(decoded.image);
    return { ok: true, files: await renderEach(([16, 32, 48] as const).map((size) => [`favicon-${size}`, () => fitSquare(image, size)] as const)) };
  }
  const text = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(text.slice(0, 4096))) return { ok: false, error: 'a favicon is an SVG or a PNG image' };
  const clean = sanitizeSvg(text);
  if (!clean.ok) return clean;
  return { ok: true, files: [{ asset: 'favicon', ext: 'svg', bytes: Buffer.from(clean.svg, 'utf8') }] };
}

/**
 * One square PNG of at least 512 px: 512 and 192 for the manifest, a maskable 512 whose mark sits
 * inside the 80% safe zone, and the 180 px apple-touch-icon. The two that must be opaque stand on
 * the icon's own corner colour (white when the corner is transparent).
 */
export async function deriveAppIcon(bytes: Buffer): Promise<DeriveResult> {
  if (!isPng(bytes)) return { ok: false, error: 'an app icon is a PNG image' };
  const decoded = decodePng(bytes);
  if (!decoded.ok) return decoded;
  const { width, height } = decoded.image;
  if (width !== height) return { ok: false, error: `an app icon is square — this one is ${width} × ${height}` };
  if (width < 512) return { ok: false, error: `an app icon is at least 512 × 512 pixels — this one is ${width} × ${height}` };
  const fill = backdropOf(decoded.image);
  const image = await workingImage(decoded.image);
  return {
    ok: true,
    files: await renderEach([
      ['app-icon', () => fitSquare(image, 512)],
      ['app-icon-192', () => fitSquare(image, 192)],
      ['app-icon-maskable', () => fitSquare(image, 512, { inner: 410, fill })],
      ['apple-touch-icon', () => fitSquare(image, 180, { fill })],
    ]),
  };
}

export const deriveBranding = (kind: BrandingUploadKind, bytes: Buffer): Promise<DeriveResult> =>
  kind === 'favicon' ? deriveFavicon(bytes) : deriveAppIcon(bytes);

export const brandingFileName = (file: DerivedFile): string =>
  `${file.asset}-${createHash('sha256').update(file.bytes).digest('hex').slice(0, 12)}.${file.ext}`;

// Writes and removals of one cezar are serialised, so a racing upload and reset can never leave a
// group half one upload and half another.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

async function removeGroups(assets: readonly BrandingAsset[], keep: ReadonlySet<string>, env: NodeJS.ProcessEnv): Promise<void> {
  const dir = brandingDir(env);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  assertCezarHomeWriteIsSandboxed(dir, env);
  for (const file of files) {
    const match = FILE_RE.exec(file.replace(/\.[^.]+\.tmp$/, ''));
    if (match && assets.includes(match[1] as BrandingAsset) && !keep.has(file)) await rm(join(dir, file), { force: true });
  }
}

/** Replace `kind`'s group with these files. */
export function saveBranding(kind: BrandingUploadKind, files: DerivedFile[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return serial(async () => {
    const dir = brandingDir(env);
    assertCezarHomeWriteIsSandboxed(dir, env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const written = new Set<string>();
    for (const file of files) {
      const name = brandingFileName(file);
      const tmp = join(dir, `${name}.${randomUUID()}.tmp`);
      await writeFile(tmp, file.bytes, { mode: 0o600 });
      // A reader serving the previous upload holds the name on Windows for an instant.
      await renameWithRetry(tmp, join(dir, name));
      written.add(name);
    }
    await removeGroups(BRANDING_GROUPS[kind], written, env);
  });
}

export function removeBranding(kinds: readonly BrandingUploadKind[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return serial(() => removeGroups(kinds.flatMap((kind) => BRANDING_GROUPS[kind]), new Set(), env));
}

/** The stored file of each asset. Two of one asset exist only mid-write; the newer one wins. */
export async function brandingFiles(env: NodeJS.ProcessEnv = process.env): Promise<Partial<Record<BrandingAsset, string>>> {
  const dir = brandingDir(env);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return {};
  }
  const found: Partial<Record<BrandingAsset, { file: string; mtime: number }>> = {};
  for (const file of files) {
    const match = FILE_RE.exec(file);
    if (!match) continue;
    const asset = match[1] as BrandingAsset;
    const mtime = await stat(join(dir, file)).then((s) => s.mtimeMs, () => -1);
    if (mtime < 0) continue;
    const current = found[asset];
    if (!current || mtime > current.mtime || (mtime === current.mtime && file > current.file)) found[asset] = { file, mtime };
  }
  return Object.fromEntries(Object.entries(found).map(([asset, entry]) => [asset, entry!.file]));
}

/** The stored bytes, their type and `hash` — the `?v=` that addresses this version. */
export async function readBrandingAsset(asset: BrandingAsset, env: NodeJS.ProcessEnv = process.env): Promise<{ bytes: Buffer; type: string; hash: string } | null> {
  const file = (await brandingFiles(env))[asset];
  if (!file) return null;
  try {
    const bytes = await readFile(join(brandingDir(env), file));
    return { bytes, type: TYPES[file.slice(file.lastIndexOf('.') + 1) as Extension], hash: FILE_RE.exec(file)![2]! };
  } catch {
    return null;
  }
}

/** `/api/v1/workspace/branding/<asset>?v=<hash>` — the hash is the file name's, no read needed. */
export function brandingAssetUrl(file: string): string {
  const match = FILE_RE.exec(file)!;
  return `/api/v1/workspace/branding/${match[1]}?v=${match[2]}`;
}

/** Everything the cockpit and the shell need to show the brand, from the config and the files. */
export interface BrandingState {
  name: string;
  logoUrl: string | null;
  accent: string | null;
  urls: Partial<Record<BrandingAsset, string>>;
}

export async function brandingState(
  stored: { name?: string; accent?: string },
  logoUrl: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrandingState> {
  const files = await brandingFiles(env);
  const urls = Object.fromEntries(Object.entries(files).map(([asset, file]) => [asset, brandingAssetUrl(file!)]));
  const accent = stored.accent && deriveAccentTokens(stored.accent) ? stored.accent : null;
  return { name: stored.name ?? DEFAULT_BRAND_NAME, logoUrl, accent, urls };
}

export function brandingBody(state: BrandingState): WorkspaceBranding {
  const faviconUrl = state.urls.favicon ?? state.urls['favicon-32'] ?? null;
  const appIconUrl = state.urls['app-icon'] ?? null;
  return {
    name: state.name,
    logoUrl: state.logoUrl,
    faviconUrl,
    appIconUrl,
    accent: state.accent,
    accentTokens: state.accent ? deriveAccentTokens(state.accent) : null,
    custom: state.name !== DEFAULT_BRAND_NAME || state.logoUrl !== null || state.accent !== null || Object.keys(state.urls).length > 0,
  };
}

/** One `<link>` the shell's head carries. */
export interface HeadLink {
  rel: 'icon' | 'apple-touch-icon' | 'manifest';
  href: string;
  type?: string;
  sizes?: string;
}

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: 'any' | 'maskable';
}

/** cezar's own mark, the default of every slot below. */
const CEZAR_ICON = '/icon.svg';

/**
 * The favicon links, most specific first: an uploaded favicon (PNG sizes, then the vector a browser
 * that takes SVG prefers), else the logo, else the app icon, else cezar's own mark. The cockpit's
 * `tabIconOf` (use-document-title.ts) keeps the same order.
 */
export function brandingLinks(state: BrandingState): HeadLink[] {
  const { urls } = state;
  const links: HeadLink[] = [];
  for (const size of [16, 32, 48] as const) {
    const href = urls[`favicon-${size}`];
    if (href) links.push({ rel: 'icon', href, type: 'image/png', sizes: `${size}x${size}` });
  }
  if (urls.favicon) links.push({ rel: 'icon', href: urls.favicon, type: 'image/svg+xml' });
  // The logo was the tab icon before favicons could be uploaded, and stays it until one is.
  if (links.length === 0 && state.logoUrl) links.push({ rel: 'icon', href: state.logoUrl });
  if (links.length === 0 && urls['app-icon-192']) links.push({ rel: 'icon', href: urls['app-icon-192'], type: 'image/png', sizes: '192x192' });
  if (links.length === 0) links.push({ rel: 'icon', href: CEZAR_ICON, type: 'image/svg+xml' });
  if (urls['apple-touch-icon']) links.push({ rel: 'apple-touch-icon', href: urls['apple-touch-icon'], sizes: '180x180' });
  links.push({ rel: 'manifest', href: '/manifest.webmanifest' });
  return links;
}

export function manifestIcons(state: BrandingState): ManifestIcon[] {
  const { urls } = state;
  const icons: ManifestIcon[] = [];
  if (urls['app-icon-192']) icons.push({ src: urls['app-icon-192'], sizes: '192x192', type: 'image/png', purpose: 'any' });
  if (urls['app-icon']) icons.push({ src: urls['app-icon'], sizes: '512x512', type: 'image/png', purpose: 'any' });
  if (urls['app-icon-maskable']) icons.push({ src: urls['app-icon-maskable'], sizes: '512x512', type: 'image/png', purpose: 'maskable' });
  if (icons.length === 0 && urls.favicon) icons.push({ src: urls.favicon, sizes: 'any', type: 'image/svg+xml' });
  if (icons.length === 0 && urls['favicon-48']) icons.push({ src: urls['favicon-48'], sizes: '48x48', type: 'image/png' });
  if (icons.length === 0) icons.push({ src: CEZAR_ICON, sizes: 'any', type: 'image/svg+xml' });
  return icons;
}
