import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dryRunCommandRunner, spawnCommandRunner, type CommandResult, type CommandRunner } from './create-project.ts';

/**
 * `POST /api/v1/projects/:projectId/git-init` (spec 2026-10-26-first-run-onboarding): make a
 * `not-git` folder a repository. The existing files are committed, not left untracked — task
 * worktrees branch from HEAD, so an empty initial commit would hand every agent an empty tree.
 * Nothing is pushed and no remote is added.
 */

const INITIAL_BRANCH = 'main';

export type InitGitResult =
  | { ok: true; branch: string }
  | { ok: false; status: 409 | 500; error: string };

export async function initGitInFolder(opts: {
  root: string;
  run?: CommandRunner;
  signal?: AbortSignal;
}): Promise<InitGitResult> {
  const gitDir = join(opts.root, '.git');
  if (await exists(gitDir)) return { ok: false, status: 409, error: `already a git repository: ${opts.root}` };

  const run = opts.run ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCommandRunner : spawnCommandRunner);
  const exec = async (args: string[]): Promise<CommandResult> => {
    try {
      return await run('git', args, { cwd: opts.root, signal: opts.signal });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const init = await exec(['init', '-b', INITIAL_BRANCH]);
  if (!init.ok) return { ok: false, status: 500, error: `git init failed: ${firstLine(init.error)}` };

  // Only the `.git` this call created is removed on a later failure, so a retry starts clean
  // instead of meeting "already a git repository" over a repo with no commit.
  const undo = async (error: string): Promise<InitGitResult> => {
    await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, status: 500, error };
  };
  const add = await exec(['add', '-A']);
  if (!add.ok) return undo(`git add failed: ${firstLine(add.error)}`);
  const commit = await exec(['commit', '--allow-empty', '-m', 'Initial commit']);
  if (!commit.ok) return undo(`the initial commit failed: ${firstLine(commit.error)}`);
  return { ok: true, branch: INITIAL_BRANCH };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}
