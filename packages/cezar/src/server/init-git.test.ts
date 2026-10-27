import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dryRunCommandRunner, type CommandRunner } from './create-project.ts';
import { initGitInFolder } from './init-git.ts';

/** "Initialize git here" (spec 2026-10-26-first-run-onboarding). Real git; the dry-run runner
 *  lends the commit an identity so the host's git config does not matter. */
describe('initGitInFolder', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-init-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('commits the files already in the folder, so a task worktree is not empty', async () => {
    writeFileSync(join(root, 'notes.md'), '# notes\n');

    const result = await initGitInFolder({ root, run: dryRunCommandRunner });

    expect(result).toEqual({ ok: true, branch: 'main' });
    expect(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim()).toBe('notes.md');
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe('main');
  });

  it('refuses a folder that already is a repository', async () => {
    mkdirSync(join(root, '.git'));

    expect(await initGitInFolder({ root, run: dryRunCommandRunner })).toMatchObject({ ok: false, status: 409 });
  });

  it('removes the .git it created when the commit fails, so a retry starts clean', async () => {
    const failingCommit: CommandRunner = (cmd, args, opts) =>
      args[0] === 'commit'
        ? Promise.resolve({ ok: false, error: 'Author identity unknown\n*** Please tell me who you are.' })
        : dryRunCommandRunner(cmd, args, opts);

    const result = await initGitInFolder({ root, run: failingCommit });

    expect(result).toEqual({ ok: false, status: 500, error: 'the initial commit failed: Author identity unknown' });
    expect(existsSync(join(root, '.git'))).toBe(false);
  });
});
