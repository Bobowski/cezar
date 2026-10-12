import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverServiceCandidates } from './discover.ts';

let root: string;
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cez-services-discover-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('service candidates (spec 2026-10-11-project-services §3.1)', () => {
  it('offers nothing for a repository with none of the sources', async () => {
    put('README.md', '# x');
    expect(await discoverServiceCandidates(root, () => true)).toEqual([]);
  });

  it('reads scripts of nested packages through the nearest lockfile\'s package manager, long-lived first', async () => {
    put('app/yarn.lock', '');
    put('app/package.json', JSON.stringify({ scripts: { build: 'turbo build', dev: 'turbo dev' } }));
    put('app/apps/web/package.json', JSON.stringify({ scripts: { 'dev:api': 'next dev', lint: 'eslint', 'bad name; rm': 'x' } }));
    put('app/node_modules/pkg/package.json', JSON.stringify({ scripts: { dev: 'nope' } }));
    const found = await discoverServiceCandidates(root, () => true);
    expect(found.map((c) => [c.name, c.command, c.cwd, c.primary])).toEqual([
      ['app: dev', 'yarn run dev', 'app', true],
      ['web: dev:api', 'yarn run dev:api', 'app/apps/web', true],
      ['app: build', 'yarn run build', 'app', false],
      ['web: lint', 'yarn run lint', 'app/apps/web', false],
    ]);
    expect(found[0]).toMatchObject({ source: 'app/package.json', detail: 'turbo dev', unavailable: null });
  });

  it('offers a compose file attached, a Procfile line and Makefile targets', async () => {
    put('docker-compose.yml', 'services: {}');
    put('Procfile', 'web: bundle exec puma\n# c\nworker: sidekiq -q default\n');
    put('Makefile', 'dev: deps\n\tyarn dev\nlint:\n\tyarn lint\n');
    const found = await discoverServiceCandidates(root, () => true);
    expect(found.map((c) => [c.name, c.command, c.source])).toEqual([
      ['compose', 'docker compose -f docker-compose.yml up', 'docker-compose.yml'],
      ['web', 'bundle exec puma', 'Procfile'],
      ['worker', 'sidekiq -q default', 'Procfile'],
      ['make dev', 'make dev', 'Makefile'],
      ['make lint', 'make lint', 'Makefile'],
    ]);
  });

  it('lists a candidate whose executable is missing, disabled with the reason', async () => {
    put('compose.yaml', 'services: {}');
    const [compose] = await discoverServiceCandidates(root, (bin) => bin !== 'docker');
    expect(compose?.unavailable).toBe('docker is not on PATH');
  });

  it('survives a malformed manifest', async () => {
    put('package.json', '{ not json');
    expect(await discoverServiceCandidates(root, () => true)).toEqual([]);
  });
});
