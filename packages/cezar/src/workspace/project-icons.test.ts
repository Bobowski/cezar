import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findIconCandidates, projectIconsDir, readProjectIcon, removeProjectIcons, saveProjectIcon, sniffIconType } from './project-icons.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-a-png')]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-icons-'));
  env = { CEZ_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('project icons (spec 2026-10-12-project-identity)', () => {
  it('knows an image by its bytes, whatever it is called', () => {
    expect(sniffIconType(PNG)).toBe('image/png');
    expect(sniffIconType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffIconType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffIconType(Buffer.from('GIF89a...'))).toBe('image/gif');
    expect(sniffIconType(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon');
    expect(sniffIconType(SVG)).toBe('image/svg+xml');
    expect(sniffIconType(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(sniffIconType(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull();
  });

  it('stores an icon under a name that carries its hash, and replaces the previous one', async () => {
    const first = await saveProjectIcon('shop', PNG, env);
    if (!first.ok) throw new Error(first.error);
    expect(first.value).toMatch(/^shop-[0-9a-f]{12}\.png$/);
    expect(await readProjectIcon(first.value, env)).toEqual({ bytes: PNG, type: 'image/png' });
    // Another project whose id merely starts the same is not this one's to delete.
    const other = await saveProjectIcon('shop-admin', PNG, env);
    const second = await saveProjectIcon('shop', SVG, env);
    if (!second.ok || !other.ok) throw new Error('save failed');
    expect(readdirSync(projectIconsDir(env)).sort()).toEqual([other.value, second.value].sort());
    await removeProjectIcons('shop', null, env);
    expect(readdirSync(projectIconsDir(env))).toEqual([other.value]);
  });

  it('refuses what is not an image, is empty, or is too large', async () => {
    expect(await saveProjectIcon('shop', Buffer.from('hello'), env)).toMatchObject({ ok: false });
    expect(await saveProjectIcon('shop', Buffer.alloc(0), env)).toMatchObject({ ok: false });
    expect(await saveProjectIcon('shop', Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), env)).toMatchObject({ ok: false });
    expect(existsSync(projectIconsDir(env))).toBe(false);
  });

  it('reads nothing for a name that is not one of its files', async () => {
    expect(await readProjectIcon('../config.json', env)).toBeNull();
    expect(await readProjectIcon('shop-000000000000.png', env)).toBeNull();
    expect(await readProjectIcon('shop-000000000000.exe', env)).toBeNull();
  });

  it('finds the repository\'s own favicon and logo, likeliest first, and nothing in dependency trees', async () => {
    const root = join(home, 'repo');
    const put = (rel: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), PNG); };
    for (const rel of ['docs/logo.png', 'apps/web/public/favicon.ico', 'apps/web/public/favicon.svg', 'public/icon.png', 'src/photo.png', 'node_modules/pkg/favicon.ico', 'apps/web/src/Logo.tsx']) put(rel);
    expect(await findIconCandidates(root)).toEqual(['apps/web/public/favicon.svg', 'apps/web/public/favicon.ico', 'public/icon.png', 'docs/logo.png']);
    expect(await findIconCandidates(join(home, 'missing'))).toEqual([]);
  });
});
