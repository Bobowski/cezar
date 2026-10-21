import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskSlotEnv } from './task-slot.ts';
import { rerenderTaskEnvFiles, seedWorktreeEnvFiles } from './worktree-env.ts';

let repo: string;
let wt: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A linked worktree, like a real run's. */
function makeWorktree(ref = 'HEAD'): string {
  git(repo, 'worktree', 'add', '-q', '--detach', wt, ref);
  return wt;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cez-env-'));
  wt = `${repo}-wt`;
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  put(repo, 'README.md', '# x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'before the ignore rule');
  put(repo, '.gitignore', '.env\n.env.local\nnode_modules/\n');
  put(repo, 'app/.env.example', 'KEY=');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
});

afterEach(() => {
  try {
    git(repo, 'worktree', 'remove', '--force', wt);
  } catch {
    // no worktree was made
  }
  rmSync(repo, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

describe('seedWorktreeEnvFiles — #cezar references (spec 2026-10-21-env-references)', () => {
  // The vitest setup pins CEZ_HOME to a per-worker sandbox, which is where slot leases go.
  const env = { CEZ_HOME: process.env.CEZ_HOME };
  const API = '#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\n#cezar DB=app${{ task.suffix }}\nDB=app\n';

  it('renders the task values into the copy, matching the slot the task processes are told', async () => {
    put(repo, '.env', API);
    put(repo, 'app/.env', '#cezar API=http://localhost:${{ .env:PORT }}\nAPI=http://localhost:9000\nPLAIN=1\n');
    put(repo, '.env.local', 'NO_DIRECTIVES=1');
    makeWorktree();

    const notes = await seedWorktreeEnvFiles(repo, wt, env, 'run-1');
    const { CEZ_TASK_SLOT: slot, CEZ_TASK_PORT_BASE: base } = taskSlotEnv('run-1', wt, env);
    expect(slot).not.toBe('');
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe(`#cezar PORT=\${{ task.port(0, 9000) }}\nPORT=${base}\n#cezar DB=app\${{ task.suffix }}\nDB=app_${slot}\n`);
    expect(readFileSync(join(wt, 'app/.env'), 'utf8')).toBe(`#cezar API=http://localhost:\${{ .env:PORT }}\nAPI=http://localhost:${base}\nPLAIN=1\n`);
    // A file without directives is still a byte copy.
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('NO_DIRECTIVES=1');
    expect(notes).toEqual(expect.arrayContaining(['.env (task values)', 'app/.env (task values)', '.env.local']));
    // The main checkout keeps its own values.
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe(API);
  });

  it('without a task to take a slot from, keeps the main checkout values', async () => {
    put(repo, '.env', API);
    makeWorktree();
    await seedWorktreeEnvFiles(repo, wt, env);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe(API);
  });

  it('keeps the main values and says why when a reference cannot be rendered', async () => {
    put(repo, '.env', '#cezar A=${{ MISSING }}\nA=main\n');
    makeWorktree();
    const notes = await seedWorktreeEnvFiles(repo, wt, env, 'run-2');
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('#cezar A=${{ MISSING }}\nA=main\n');
    expect(notes.at(-1)).toMatch(/kept at the main checkout's values — .*MISSING is not set/);
  });
});

describe('seedWorktreeEnvFiles', () => {
  it('copies the ignored env files, at any depth, and leaves the worktree clean', async () => {
    put(repo, '.env', 'ROOT=1');
    put(repo, 'app/packages/api/.env', 'STRIPE_API_KEY=sk_test');
    put(repo, 'app/apps/storefront/.env.local', 'NEXT=1');
    makeWorktree();

    const seeded = await seedWorktreeEnvFiles(repo, wt, {});
    expect(seeded.sort()).toEqual(['.env', 'app/apps/storefront/.env.local', 'app/packages/api/.env']);
    expect(readFileSync(join(wt, 'app/packages/api/.env'), 'utf8')).toBe('STRIPE_API_KEY=sk_test');
    // Nothing an autosave's `git add -A` could pick up.
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('leaves tracked env files to the branch, and unignored ones alone', async () => {
    put(repo, 'app/.env.example', 'KEY=changed-locally');
    put(repo, 'app/.env.staging', 'NOT_IGNORED=1');
    makeWorktree();

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
    expect(readFileSync(join(wt, 'app/.env.example'), 'utf8')).toBe('KEY=');
    expect(existsSync(join(wt, 'app/.env.staging'))).toBe(false);
  });

  it('never overwrites an env file the worktree already has', async () => {
    put(repo, '.env', 'PORT=3000');
    makeWorktree();
    put(wt, '.env', 'PORT=3107');

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('PORT=3107');
  });

  it('skips dependency trees and other checkouts', async () => {
    put(repo, 'node_modules/pkg/.env', 'FIXTURE=1');
    put(repo, 'nested/.git', 'gitdir: elsewhere');
    put(repo, 'nested/.env', 'OTHER_REPO=1');
    put(repo, '.git/info/exclude', 'nested/\n');
    makeWorktree();

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
  });

  it('seeds an app that is NAMED vendor, and still skips a vendored dependency tree', async () => {
    put(repo, 'apps/vendor/package.json', '{}');
    put(repo, 'apps/vendor/.env', 'VITE_BACKEND=1');
    put(repo, 'php/vendor/autoload.php', '<?php');
    put(repo, 'php/vendor/pkg/.env', 'FIXTURE=1');
    makeWorktree();

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual(['apps/vendor/.env']);
  });

  it('excludes a copy the worktree’s own branch would not ignore', async () => {
    put(repo, '.env', 'SECRET=1');
    // The commit before `.gitignore` existed: in this tree nothing says `.env` is ignored.
    makeWorktree('HEAD~1');

    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual(['.env']);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('SECRET=1');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('copies nothing when there is nothing to copy', async () => {
    makeWorktree();
    expect(await seedWorktreeEnvFiles(repo, wt, {})).toEqual([]);
  });

  it('is off under CEZ_WORKTREE_ENV=0, and for a run in the repo itself', async () => {
    put(repo, '.env', 'ROOT=1');
    makeWorktree();

    expect(await seedWorktreeEnvFiles(repo, wt, { CEZ_WORKTREE_ENV: '0' })).toEqual([]);
    expect(existsSync(join(wt, '.env'))).toBe(false);
    expect(await seedWorktreeEnvFiles(repo, repo, {})).toEqual([]);
  });

  it('does not throw outside a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-env-plain-'));
    try {
      expect(await seedWorktreeEnvFiles(repo, plain, {})).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('rerenderTaskEnvFiles — "Re-render in this task" (spec 2026-10-21-env-references §4)', () => {
  const env = { CEZ_HOME: process.env.CEZ_HOME };

  it('brings a reference added after the task was seeded into its copy, keeping the task\'s own edits', async () => {
    put(repo, '.env', 'PORT=9000\nDB=app\n');
    makeWorktree();
    await seedWorktreeEnvFiles(repo, wt, env, 'run-3');
    // The task changed a value by hand; the main checkout then gained references.
    put(wt, '.env', 'PORT=9000\nDB=app\nDEBUG=1\n');
    put(repo, '.env', '#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\nDB=app\n#cezar NAME=app${{ task.suffix }}\nNAME=app\n');

    const result = await rerenderTaskEnvFiles(repo, wt, 'run-3', env);
    const { CEZ_TASK_SLOT: slot, CEZ_TASK_PORT_BASE: base } = taskSlotEnv('run-3', wt, env);
    expect(result).toEqual({ changed: ['.env'], missing: [], slot: Number(slot) });
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe(`#cezar PORT=\${{ task.port(0, 9000) }}\nPORT=${base}\nDB=app\nDEBUG=1\n#cezar NAME=app\${{ task.suffix }}\nNAME=app_${slot}\n`);
    expect(readFileSync(join(repo, '.env'), 'utf8')).toContain('PORT=9000\n');
  });

  it('reports a referencing file the task has no copy of, and writes nothing twice', async () => {
    makeWorktree();
    put(repo, '.env', '#cezar A=${{ task.slot }}\nA=0\n');
    expect(await rerenderTaskEnvFiles(repo, wt, 'run-4', env)).toMatchObject({ changed: [], missing: ['.env'] });
    expect(existsSync(join(wt, '.env'))).toBe(false);
  });

  it('throws on a reference it cannot render, leaving the task file as it was', async () => {
    put(repo, '.env', 'A=1\n');
    makeWorktree();
    await seedWorktreeEnvFiles(repo, wt, env, 'run-5');
    put(repo, '.env', '#cezar A=${{ NOPE }}\nA=1\n');
    await expect(rerenderTaskEnvFiles(repo, wt, 'run-5', env)).rejects.toThrow(/NOPE is not set/);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('A=1\n');
  });
});
