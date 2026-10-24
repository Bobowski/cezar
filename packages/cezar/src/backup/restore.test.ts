import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStateLocations } from '../paths.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { TEST_IDENTITY } from './age-vector.testkit.ts';
import { file, rawEntry, sealArchive, sealTar, tarBytes, withManifest } from './craft-archive.testkit.ts';
import { PAX_HEADER_MAX } from './tar.ts';
import { applyStaged, cloneWithGit, placeFile, stageArchive, validCloneRemote } from './restore.ts';

/** What a restore may touch (review 2026-10-24): the archive is input, not an authority. */
describe('applying a crafted archive', () => {
  let dir: string;
  let home: string;
  let log: string[];
  let locations: AgentStateLocations;
  const saved = process.env.CEZ_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-restore-crafted-'));
    home = join(dir, 'home');
    process.env.CEZ_HOME = home;
    mkdirSync(home, { recursive: true });
    log = [];
    const none = join(dir, 'agents');
    locations = { claude: join(none, 'claude'), claudeState: null, codex: join(none, 'codex'), gh: join(none, 'gh'), ssh: join(none, 'ssh'), gitconfig: join(none, 'gitconfig') };
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved;
    await removeTempDir(dir);
  });

  const restore = async (entries: Parameters<typeof withManifest>[1], projects: Parameters<typeof withManifest>[0]) => {
    const archive = join(dir, 'crafted.age');
    await sealArchive(withManifest(projects, entries), archive);
    const staging = join(home, '.restore-test');
    const manifest = await stageArchive(archive, TEST_IDENTITY, staging);
    await applyStaged({ staging, manifest, cezarHome: home, locations, log: (line) => log.push(line) });
  };
  const registryJson = (projects: Array<{ id: string; root: string }>, projectsDir: string) =>
    JSON.stringify({ projectsDir, projects: projects.map((p) => ({ ...p, addedAt: '2026-10-24T00:00:00Z' })) });
  /** This machine's registry, as it stands before the restore. */
  const registry = (projects: Array<{ id: string; root: string }>, projectsDir = join(dir, 'projects-dir')) =>
    writeFileSync(join(home, 'config.json'), registryJson(projects, projectsDir));

  it('writes a project only at a root the registry or the projects directory vouches for', async () => {
    const app = join(dir, 'code', 'app');
    const outside = join(dir, 'outside');
    const listed = join(dir, 'projects-dir', 'listed');
    for (const root of [app, outside, listed]) mkdirSync(root, { recursive: true });
    registry([{ id: 'app', root: app }]);
    await restore(
      [file('projects/app/.env', 'A=1'), file('projects/evil/.env', 'E=1'), file('projects/listed/.env', 'L=1')],
      [
        { id: 'app', root: app, remote: null, branch: null },
        { id: 'evil', root: outside, remote: null, branch: null },
        { id: 'listed', root: listed, remote: null, branch: null },
      ],
    );
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe('A=1');
    expect(readFileSync(join(listed, '.env'), 'utf8')).toBe('L=1');
    expect(existsSync(join(outside, '.env'))).toBe(false);
    expect(log.join('\n')).toMatch(/skipped evil: .*neither/);
  });

  it('never lets the archive\'s own config vouch for the roots it restores to', async () => {
    const outside = join(dir, 'outside');
    const planted = join(dir, 'anywhere', 'planted');
    for (const root of [outside, planted]) mkdirSync(root, { recursive: true });
    registry([]);
    await restore(
      // The archive registers `evil` and widens the projects dir to cover `planted`.
      [file('data/config.json', registryJson([{ id: 'evil', root: outside }], join(dir, 'anywhere'))), file('projects/evil/.env', 'E=1'), file('projects/planted/.env', 'P=1')],
      [
        { id: 'evil', root: outside, remote: null, branch: null },
        { id: 'planted', root: planted, remote: null, branch: null },
      ],
    );
    expect(existsSync(join(outside, '.env'))).toBe(false);
    expect(existsSync(join(planted, '.env'))).toBe(false);
    expect(log.join('\n')).toMatch(/skipped evil: .*neither/);
    expect(log.join('\n')).toMatch(/skipped planted: .*neither/);
    // The archive's config itself is still restored — it just vouches for nothing this time.
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toContain('evil');
  });

  it('puts back only allowlisted project files, whatever else the archive carries', async () => {
    const app = join(dir, 'code', 'app');
    mkdirSync(app, { recursive: true });
    registry([{ id: 'app', root: app }]);
    await restore(
      [
        file('projects/app/.env', 'A=1'),
        file('projects/app/src/index.ts', 'evil()'),
        file('projects/app/node_modules/pkg/.env', 'N=1'),
        file('projects/app/.git/hooks/post-checkout', '#!/bin/sh\nevil'),
        file('projects/app/.ai/cezar/worktrees/x/.env', 'W=1'),
      ],
      [{ id: 'app', root: app, remote: null, branch: null }],
    );
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe('A=1');
    for (const rel of ['src/index.ts', 'node_modules/pkg/.env', '.git/hooks/post-checkout', '.ai/cezar/worktrees/x/.env']) {
      expect(existsSync(join(app, ...rel.split('/'))), rel).toBe(false);
    }
  });

  it('never removes a directory the archive has a file in place of', async () => {
    mkdirSync(join(home, 'keep'));
    writeFileSync(join(home, 'keep', 'inner.json'), 'mine');
    await restore([file('data/keep', 'a file now'), file('data/other.json', '{}')], []);
    expect(readFileSync(join(home, 'keep', 'inner.json'), 'utf8')).toBe('mine');
    expect(readFileSync(join(home, 'other.json'), 'utf8')).toBe('{}');
    expect(log.join('\n')).toMatch(/kept .*keep: .*directory/);
  });

  it('does not write through a directory link it finds in the destination', async () => {
    const app = join(dir, 'code', 'app');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(app, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(app, '.ai'), 'junction');
    registry([{ id: 'app', root: app }]);
    await restore(
      [file('projects/app/.ai/cezar/runs.json', '{}')],
      [{ id: 'app', root: app, remote: null, branch: null }],
    );
    expect(existsSync(join(elsewhere, 'cezar', 'runs.json'))).toBe(false);
    expect(log.join('\n')).toMatch(/kept .*\.ai: /);
  });

  it('does not merge run history through a directory link either', async () => {
    const app = join(dir, 'code', 'app');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(app, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(app, '.ai'), 'junction');
    registry([{ id: 'app', root: app }]);
    await restore(
      [file('projects/app/.ai/cezar/runs.json', '[]'), file('projects/app/.ai/cezar/runs/r.ndjson', '{}\n')],
      [{ id: 'app', root: app, remote: null, branch: null }],
    );
    expect(existsSync(join(elsewhere, 'cezar'))).toBe(false);
    expect(log.join('\n')).toMatch(/kept .*\.ai: /);
  });
});

describe('placing a file across filesystems (EXDEV)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-restore-exdev-'));
  });
  afterEach(() => removeTempDir(dir));

  const exdev = async () => {
    throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
  };

  it('replaces a file link at the destination instead of writing through it', async (ctx) => {
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, 'theirs');
    const dest = join(dir, 'home', 'auth.json');
    mkdirSync(join(dir, 'home'));
    try {
      symlinkSync(outside, dest, 'file');
    } catch {
      ctx.skip(); // no symlink privilege (Windows without developer mode)
    }
    const src = join(dir, 'staged.json');
    writeFileSync(src, 'restored');
    const warnings: string[] = [];
    expect(await placeFile(src, dest, 0o600, (line) => warnings.push(line), exdev)).toBe(true);
    expect(warnings).toEqual([]);
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('restored');
    expect(readFileSync(outside, 'utf8')).toBe('theirs');
  });

  it('replaces a plain file and leaves no temp sibling behind', async () => {
    const dest = join(dir, 'runs.json');
    writeFileSync(dest, 'old');
    const src = join(dir, 'staged.json');
    writeFileSync(src, 'new');
    expect(await placeFile(src, dest, 0o600, () => {}, exdev)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'staged.json'))).toBe(true); // a copy, the staging dir is removed later
    expect(readdirSync(dir).filter((name) => name.includes('cezar-restore'))).toEqual([]);
  });
});

describe('cloning a project back', () => {
  it('accepts only an https or ssh remote that cannot pass for an option', () => {
    for (const ok of [
      'https://github.com/open-mercato/cezar.git',
      'https://x-access-token:abc@github.com/o/r.git',
      'ssh://git@github.com:22/o/r.git',
      'git@github.com:open-mercato/cezar.git',
    ]) expect(validCloneRemote(ok), ok).toBe(true);
    for (const bad of [
      '--upload-pack=touch /tmp/pwned',
      '-u x',
      'ext::sh -c evil',
      'file:///etc',
      '/srv/git/repo',
      'C:\repos\app',
      'http://example.com/o/r.git',
      'https://-oProxyCommand=evil/x',
      'git@github.com:-evil',
      'https://github.com/o/r.git\nmore',
    ]) expect(validCloneRemote(bad), bad).toBe(false);
  });

  it('refuses a bad remote or branch before git runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-restore-clone-'));
    try {
      const at = join(dir, 'app');
      await expect(cloneWithGit('--upload-pack=evil', at, null)).rejects.toThrow(/https:\/\/ or ssh/);
      await expect(cloneWithGit('https://github.com/o/r.git', at, '--orphan=x')).rejects.toThrow(/branch/);
      expect(existsSync(at)).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe('staging an archive that lies about itself', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-restore-caps-'));
  });
  afterEach(() => removeTempDir(dir));

  const stage = async (tar: Buffer) => {
    const archive = join(dir, 'a.age');
    await sealTar(tar, archive);
    return stageArchive(archive, TEST_IDENTITY, join(dir, 'staging'));
  };

  it('stops once the staged bytes run past what the manifest declares (+10 %)', async () => {
    const entries = withManifest([], [file('data/big.bin', Buffer.alloc(10_000))], { data: 1_000 });
    await expect(stage(await tarBytes(entries))).rejects.toThrow(/more than its manifest/);
    // Within the margin it stages.
    const near = withManifest([], [file('data/big.bin', Buffer.alloc(1_050))], { data: 1_000 });
    await expect(stage(await tarBytes(near))).resolves.toMatchObject({ host: 'crafted' });
  });

  it('wants its manifest first', async () => {
    const [manifest, ...rest] = withManifest([], [file('data/a.json', '{}')]);
    await expect(stage(await tarBytes([...rest, manifest!]))).rejects.toThrow(/manifest first/);
  });

  it('refuses an extended header past 1 MiB', async () => {
    const huge = rawEntry('PaxHeader/x', 'x', Buffer.alloc(PAX_HEADER_MAX + 1, 0x41));
    const tar = Buffer.concat([await tarBytes(withManifest([], [])).then((b) => b.subarray(0, b.length - 1024)), huge, Buffer.alloc(1024)]);
    await expect(stage(tar)).rejects.toThrow(/extended header/);
  });
});

describe('staging a crafted tar', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-restore-tar-'));
  });
  afterEach(() => removeTempDir(dir));

  const header = async () => (await tarBytes(withManifest([], [file('data/real.json', '{}')], { files: 3 }))).subarray(0, -1024);
  const stage = async (...entries: Buffer[]) => {
    const archive = join(dir, 'a.age');
    await sealTar(Buffer.concat([await header(), ...entries, Buffer.alloc(1024)]), archive);
    const staging = join(dir, 'staging');
    return { staging, manifest: await stageArchive(archive, TEST_IDENTITY, staging) };
  };

  it('never makes a symlink or a hard link, whatever they point at', async () => {
    const { staging } = await stage(rawEntry('data/link', '2', Buffer.alloc(0), '/etc/passwd'), rawEntry('data/hard', '1', Buffer.alloc(0), 'data/real.json'));
    expect(readFileSync(join(staging, 'data', 'real.json'), 'utf8')).toBe('{}');
    expect(existsSync(join(staging, 'data', 'link'))).toBe(false);
    expect(existsSync(join(staging, 'data', 'hard'))).toBe(false);
  });

  it('refuses an absolute or climbing name, in the header or in a PAX path', async () => {
    for (const name of ['/etc/cron.d/evil', '../evil', 'data/../../evil', 'C:/evil']) {
      await expect(stage(rawEntry(name, '0', Buffer.from('x'))), name).rejects.toThrow(/outside its own layout/);
    }
    const pax = Buffer.from('27 path=../../outside/evil\n');
    await expect(stage(rawEntry('PaxHeader/x', 'x', pax), rawEntry('data/benign', '0', Buffer.from('x')))).rejects.toThrow(/outside its own layout/);
    expect(existsSync(join(dir, 'outside'))).toBe(false);
  });
});
