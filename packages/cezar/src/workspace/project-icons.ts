import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ICON_MAX_BYTES, type ProjectIconType } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { ENV_WALK_SKIP_DIRS, isDependencyVendorDir } from '../worktree-env.ts';

/**
 * Project icons (spec `.ai/specs/2026-10-12-project-identity.md`): one small image per project,
 * kept in `~/.cezar/project-icons/` beside the registry that names it. The registry entry holds
 * the FILE NAME, which carries a hash of the bytes — so a new icon is a new name, the URL the
 * cockpit builds from it changes, and nothing has to be told to forget a cached image.
 *
 * Written, never required: delete the directory and every project falls back to its initial.
 */

const EXTENSION: Record<ProjectIconType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
};
const TYPE_OF_EXTENSION = Object.fromEntries(Object.entries(EXTENSION).map(([type, extension]) => [extension, type])) as Record<string, ProjectIconType>;

export const projectIconsDir = (env: NodeJS.ProcessEnv = process.env): string => join(cezarHomeDir(env), 'project-icons');

/** What these bytes are, by their first bytes — a name or a header is a claim, not a fact. */
export function sniffIconType(bytes: Buffer): ProjectIconType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon';
  // SVG is text: an optional prolog, comments and doctype, then the root element.
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 2048)).replace(/^﻿/, '');
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

export type IconResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Store `bytes` as `projectId`'s icon and answer the file name the registry should hold. */
export async function saveProjectIcon(projectId: string, bytes: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<IconResult<string>> {
  if (bytes.length === 0) return { ok: false, error: 'the image is empty' };
  if (bytes.length > PROJECT_ICON_MAX_BYTES) return { ok: false, error: `an icon is at most ${PROJECT_ICON_MAX_BYTES / 1024} KB` };
  const type = sniffIconType(bytes);
  if (!type) return { ok: false, error: 'not an image this cockpit shows — use PNG, JPEG, WebP, GIF, SVG or ICO' };
  const dir = projectIconsDir(env);
  const name = `${projectId}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${EXTENSION[type]}`;
  assertCezarHomeWriteIsSandboxed(dir, env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${name}.tmp`);
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, join(dir, name));
  await removeProjectIcons(projectId, name, env);
  return { ok: true, value: name };
}

/** Drop every icon file of `projectId` except `keep`. Best-effort: a stale file costs bytes, nothing else. */
export async function removeProjectIcons(projectId: string, keep: string | null = null, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = projectIconsDir(env);
  try {
    assertCezarHomeWriteIsSandboxed(dir, env);
    // `<id>-<12 hex>.<ext>`: the hash is what tells `shop` apart from `shop-admin`.
    const own = new RegExp(`^${projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{12}\\.[a-z0-9]+(?:\\.tmp)?$`);
    for (const file of await readdir(dir)) if (file !== keep && own.test(file)) await rm(join(dir, file), { force: true });
  } catch {
    // No directory, or an unreadable one: nothing to remove.
  }
}

/** The stored icon's bytes and type, or `null` when the file is gone or is not one of ours. */
export async function readProjectIcon(file: string, env: NodeJS.ProcessEnv = process.env): Promise<{ bytes: Buffer; type: ProjectIconType } | null> {
  if (!/^[a-z0-9-]{1,80}\.[a-z0-9]{2,5}$/.test(file)) return null;
  const type = TYPE_OF_EXTENSION[file.slice(file.lastIndexOf('.') + 1)];
  if (!type) return null;
  try {
    return { bytes: await readFile(join(projectIconsDir(env), file)), type };
  } catch {
    return null;
  }
}

const CANDIDATE = /^(favicon|icon|logo|apple-touch-icon|app-icon|brand)[\w.@-]*\.(png|ico|svg|jpe?g|webp|gif)$/i;
const MAX_DEPTH = 4;
const MAX_DIRS = 1500;
const MAX_CANDIDATES = 12;

/** How likely a file is THE project's mark: a favicon over a logo, shallow over deep, vector over raster. */
function rank(path: string): number {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const kind = name.startsWith('favicon') ? 0 : name.startsWith('icon') || name.startsWith('app-icon') ? 1 : name.startsWith('logo') ? 2 : 3;
  const format = name.endsWith('.svg') ? 0 : name.endsWith('.png') ? 1 : 2;
  return kind * 100 + path.split('/').length * 10 + format;
}

/** Images in `root` named like a logo or a favicon, likeliest first. Reads names only. */
export async function findIconCandidates(root: string): Promise<string[]> {
  const found: string[] = [];
  let opened = 0;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (opened >= MAX_DIRS) return;
    opened += 1;
    let entries;
    try {
      entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (rel !== '' && entries.some((entry) => entry.name === '.git')) return;
    if (isDependencyVendorDir(rel, entries.map((entry) => entry.name))) return;
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isFile()) {
        if (CANDIDATE.test(entry.name)) found.push(path);
      } else if (entry.isDirectory() && depth < MAX_DEPTH && !entry.name.startsWith('.') && !ENV_WALK_SKIP_DIRS.has(entry.name)) {
        await visit(path, depth + 1);
      }
    }
  };
  await visit('', 0);
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_CANDIDATES);
}
