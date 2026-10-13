import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { GithubRepo } from '@open-mercato/cezar-contract';
import { parseRepoRef } from './checkout.ts';
import { whyLine } from './forge/github.ts';

/**
 * The clone dialog's repository picker: what the signed-in `gh` account can clone, most recently
 * pushed first. Never throws — no `gh`, no login and no network are all `available: false`.
 */

export type GhApiRunner = (path: string) => Promise<string>;

export type GithubRepoListing =
  | { available: true; repos: Array<Omit<GithubRepo, 'projectId'>> }
  | { available: false; reason: string };

/** 300 repositories: enough that the one you pushed to this month is there; the rest is a paste. */
const PAGES = 3;
const PER_PAGE = 100;
const TTL_MS = 60_000;

const ghRepoSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  description: z.string().nullish(),
  private: z.boolean().catch(false),
  fork: z.boolean().catch(false),
  archived: z.boolean().catch(false),
  pushed_at: z.string().nullish(),
});

export const ghApiRunner: GhApiRunner = (path) =>
  new Promise((resolve, reject) => {
    execFile('gh', ['api', path], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      reject(Object.assign(err, { stderr }));
    });
  });

const DRY_RUN_REPOS: Array<Omit<GithubRepo, 'projectId'>> = [
  { slug: 'open-mercato/cezar', owner: 'open-mercato', name: 'cezar', description: 'Parallel coding-agents orchestrator', private: false, fork: false, pushedAt: '2026-10-12T09:00:00Z' },
  { slug: 'acme/storefront', owner: 'acme', name: 'storefront', description: null, private: true, fork: false, pushedAt: '2026-10-01T09:00:00Z' },
];

function reasonOf(err: unknown): string {
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 'gh is not installed';
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : err instanceof Error ? err.message : String(err);
  if (/gh auth login|not logged in|authentication/i.test(text)) return 'gh is not signed in — run `gh auth login`';
  return whyLine(text).slice(0, 300);
}

let cache: { at: number; listing: GithubRepoListing } | null = null;

export async function listGithubRepos(options: { run?: GhApiRunner; refresh?: boolean } = {}): Promise<GithubRepoListing> {
  if (process.env.CEZ_DRY_RUN === '1' && !options.run) return { available: true, repos: DRY_RUN_REPOS };
  // An injected runner is a test's: it must never read, or leave behind, another case's answer.
  const cached = !options.run && !options.refresh && cache && Date.now() - cache.at < TTL_MS ? cache.listing : null;
  if (cached) return cached;
  const run = options.run ?? ghApiRunner;
  const repos: Array<Omit<GithubRepo, 'projectId'>> = [];
  try {
    for (let page = 1; page <= PAGES; page += 1) {
      const raw: unknown = JSON.parse(await run(`user/repos?per_page=${PER_PAGE}&sort=pushed&page=${page}`));
      if (!Array.isArray(raw)) break;
      for (const entry of raw) {
        const parsed = ghRepoSchema.safeParse(entry);
        // An archived repository is one nobody starts work in; a name `gh` could not clone is not offered.
        if (!parsed.success || parsed.data.archived || !parseRepoRef(parsed.data.full_name)) continue;
        const repo = parsed.data;
        repos.push({
          slug: repo.full_name, owner: repo.owner.login, name: repo.name, description: repo.description || null,
          private: repo.private, fork: repo.fork, pushedAt: repo.pushed_at ?? null,
        });
      }
      if (raw.length < PER_PAGE) break;
    }
  } catch (err) {
    // A failure is not cached: signing in must show on the next open, not a minute later.
    return { available: false, reason: reasonOf(err) };
  }
  const listing: GithubRepoListing = { available: true, repos };
  if (!options.run) cache = { at: Date.now(), listing };
  return listing;
}

/** `owner/name` of a checkout's `origin`, lowercased, when it is a github.com repository. */
export async function originSlug(root: string): Promise<string | null> {
  let config: string;
  try {
    config = await readFile(join(root, '.git', 'config'), 'utf8');
  } catch {
    return null;
  }
  const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? '';
  const url = /^\s*url\s*=\s*(\S+)\s*$/m.exec(section)?.[1];
  return url ? parseRepoRef(url)?.slug.toLowerCase() ?? null : null;
}
