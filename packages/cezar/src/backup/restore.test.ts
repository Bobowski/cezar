import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStateLocations } from '../paths.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { TEST_IDENTITY } from './age-vector.testkit.ts';
import { file, sealArchive, withManifest } from './craft-archive.testkit.ts';
import { applyStaged, stageArchive } from './restore.ts';

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
  const registry = (projects: Array<{ id: string; root: string }>, projectsDir = join(dir, 'projects-dir')) =>
    file('data/config.json', JSON.stringify({ projectsDir, projects: projects.map((p) => ({ ...p, addedAt: '2026-10-24T00:00:00Z' })) }));

  it('writes a project only at a root the registry or the projects directory vouches for', async () => {
    const app = join(dir, 'code', 'app');
    const outside = join(dir, 'outside');
    const listed = join(dir, 'projects-dir', 'listed');
    for (const root of [app, outside, listed]) mkdirSync(root, { recursive: true });
    await restore(
      [registry([{ id: 'app', root: app }]), file('projects/app/.env', 'A=1'), file('projects/evil/.env', 'E=1'), file('projects/listed/.env', 'L=1')],
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

  it('puts back only allowlisted project files, whatever else the archive carries', async () => {
    const app = join(dir, 'code', 'app');
    mkdirSync(app, { recursive: true });
    await restore(
      [
        registry([{ id: 'app', root: app }]),
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
    await restore(
      [registry([{ id: 'app', root: app }]), file('projects/app/.ai/cezar/runs.json', '{}')],
      [{ id: 'app', root: app, remote: null, branch: null }],
    );
    expect(existsSync(join(elsewhere, 'cezar', 'runs.json'))).toBe(false);
    expect(log.join('\n')).toMatch(/kept .*\.ai: /);
  });
});
