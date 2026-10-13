import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubReposResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { listGithubRepos, originSlug, type GhApiRunner } from './github-repos.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const gh = (over: Record<string, unknown>) => ({
  full_name: 'acme/shop', name: 'shop', owner: { login: 'acme' }, description: 'A shop', private: true, fork: false,
  archived: false, pushed_at: '2026-10-01T00:00:00Z', ...over,
});

describe('the clone dialog’s repository list', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-gh-repos-')));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    vi.stubEnv('CEZ_DRY_RUN', '');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Acme/Shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n');
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => {
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads pages until a short one, and drops what is archived or not cloneable', async () => {
    const asked: string[] = [];
    const run: GhApiRunner = async (path) => {
      asked.push(path);
      const page = Number(/page=(\d+)$/.exec(path)?.[1]);
      if (page === 1) return JSON.stringify(Array.from({ length: 100 }, (_, i) => gh({ full_name: `acme/r${i}`, name: `r${i}` })));
      if (page === 3) return '[]';
      return JSON.stringify([gh({}), gh({ full_name: 'acme/old', name: 'old', archived: true }), gh({ full_name: 'bad name/x' }), { nonsense: true }]);
    };
    const listing = await listGithubRepos({ run });
    if (!listing.available) throw new Error(listing.reason);
    expect(asked).toEqual([1, 2, 3].map((page) => `user/repos?per_page=100&sort=pushed&page=${page}`));
    expect(listing.repos).toHaveLength(101);
    expect(listing.repos.at(-1)).toEqual({ slug: 'acme/shop', owner: 'acme', name: 'shop', description: 'A shop', private: true, fork: false, pushedAt: '2026-10-01T00:00:00Z' });
  });

  it('lists one organisation directly, and a person through the signed-in account', async () => {
    const asked: string[] = [];
    const org: GhApiRunner = async (path) => { asked.push(path); return path.endsWith('page=1') ? JSON.stringify([gh({}), gh({ full_name: 'acme/api', name: 'api' })]) : '[]'; };
    const listing = await listGithubRepos({ run: org, owner: 'acme' });
    expect(asked).toEqual([1, 2, 3].map((page) => `orgs/acme/repos?type=all&per_page=100&sort=pushed&page=${page}`));
    expect(listing.available && listing.repos.map((repo) => repo.slug)).toEqual(['acme/shop', 'acme/api']);

    asked.length = 0;
    const person: GhApiRunner = async (path) => {
      asked.push(path);
      if (path.startsWith('orgs/')) throw Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)' });
      return path.endsWith('page=1') ? JSON.stringify([gh({ full_name: 'me/dotfiles', name: 'dotfiles', owner: { login: 'Me' } }), gh({})]) : '[]';
    };
    const mine = await listGithubRepos({ run: person, owner: 'me' });
    expect(asked.filter((path) => path.startsWith('user/'))).toHaveLength(3);
    expect(mine.available && mine.repos.map((repo) => repo.slug)).toEqual(['me/dotfiles']);
    // Told the owner is the signed-in account, the organisation route is never tried.
    asked.length = 0;
    await listGithubRepos({ run: person, owner: 'me', personal: true });
    expect(asked.every((path) => path.startsWith('user/repos?affiliation=owner&'))).toBe(true);
  });

  it('answers with a reason when gh is missing, signed out or failing', async () => {
    const failing = (err: unknown): GhApiRunner => async () => { throw err; };
    expect(await listGithubRepos({ run: failing(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })) })).toEqual({ available: false, reason: 'gh is not installed' });
    expect(await listGithubRepos({ run: failing(Object.assign(new Error('Command failed: gh api'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' })) }))
      .toEqual({ available: false, reason: 'gh is not signed in — run `gh auth login`' });
    expect(await listGithubRepos({ run: failing(Object.assign(new Error('Command failed: gh api user/repos'), { stderr: 'error connecting to api.github.com\n' })) }))
      .toEqual({ available: false, reason: 'error connecting to api.github.com' });
    expect(await listGithubRepos({ run: async () => 'not json' })).toMatchObject({ available: false });
  });

  it('reads a checkout’s origin as a slug, and nothing from a folder without one', async () => {
    expect(await originSlug(root)).toBe('acme/shop');
    expect(await originSlug(join(root, 'home'))).toBeNull();
  });

  it('serves the list and marks the repository a registered project was cloned from', async () => {
    const project = await registerProject(root);
    const app = (ghApiRunner: GhApiRunner) =>
      createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: project.id, ghApiRunner });
    const ok = await apiRequest(app(async () => JSON.stringify([gh({}), gh({ full_name: 'acme/other', name: 'other', private: false })])), '/api/v1/projects/github-repos');
    const body = githubReposResponseSchema.parse(await ok.json());
    expect(body.repos.map((repo) => [repo.slug, repo.projectId])).toEqual([['acme/shop', project.id], ['acme/other', null]]);

    const down = await apiRequest(app(async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }), '/api/v1/projects/github-repos?refresh=1');
    expect(down.status).toBe(200);
    expect(githubReposResponseSchema.parse(await down.json())).toEqual({ available: false, reason: 'gh is not installed', repos: [] });
  });
});
