import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envVariableNames, listEnvFiles, readEnvFile, removeEnvFile, writeEnvFile } from './env-files.ts';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
}
function put(rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cez-env-files-'));
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  put('.gitignore', '.env\n.env.local\nnode_modules/\n');
  put('package.json', '{}');
  put('apps/api/package.json', '{}');
  put('apps/api/.env.example', 'DATABASE_URL=\nJWT_SECRET=\n');
  put('apps/web/package.json', '{}');
  put('apps/web/.env.test', 'TRACKED=1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('project env files (spec 2026-10-12-project-env-files)', () => {
  it('reads variable names and never a value', () => {
    expect(envVariableNames('# c\nA=1\nexport B = "two"\n A=again\nnot a line\n')).toEqual(['A', 'B']);
  });

  it('lists what an example asks for, what exists, and likely paths — by git\'s ignore answer', async () => {
    put('apps/web/.env.local', 'NEXT_PUBLIC_URL=http://x\n');
    const list = await listEnvFiles(repo, true);
    expect(list.files.map((f) => [f.path, f.exists, f.template, f.missing])).toEqual([
      ['apps/api/.env', false, 'apps/api/.env.example', ['DATABASE_URL', 'JWT_SECRET']],
      ['apps/web/.env.local', true, null, []],
    ]);
    expect(list.files[1]?.variables).toEqual(['NEXT_PUBLIC_URL']);
    // A tracked `.env.test` is the branch's file and is never offered; neither is a listed path.
    expect(list.suggestions).toEqual(['.env', 'apps/web/.env']);
    expect(JSON.stringify(list)).not.toContain('http://x');
  });

  it('offers an app that is named vendor', async () => {
    put('apps/vendor/package.json', '{}');
    expect((await listEnvFiles(repo, true)).suggestions).toContain('apps/vendor/.env');
  });

  it('degrades to an empty listing outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-env-plain-'));
    writeFileSync(join(plain, '.env'), 'A=1\n');
    expect(await listEnvFiles(plain, true)).toEqual({ editable: true, files: [], suggestions: [] });
    rmSync(plain, { recursive: true, force: true });
  });

  it('creates a file from nothing, private, and reports the example beside it', async () => {
    const before = await readEnvFile(repo, 'apps/api/.env');
    expect(before).toEqual({ ok: true, value: { path: 'apps/api/.env', content: '', version: null, template: 'DATABASE_URL=\nJWT_SECRET=\n' } });
    const saved = await writeEnvFile(repo, 'apps/api/.env', 'DATABASE_URL=postgres://x\n', null);
    expect(saved.ok).toBe(true);
    expect(readFileSync(join(repo, 'apps/api/.env'), 'utf8')).toBe('DATABASE_URL=postgres://x\n');
    if (process.platform !== 'win32') expect(statSync(join(repo, 'apps/api/.env')).mode & 0o777).toBe(0o600);
    expect(git('status', '--porcelain')).toBe('');
    const list = await listEnvFiles(repo, true);
    expect(list.files[0]?.missing).toEqual(['JWT_SECRET']);
  });

  it('fills #cezar directives with the main checkout values on save (spec 2026-10-21-env-references)', async () => {
    const saved = await writeEnvFile(repo, 'apps/api/.env', '#cezar PORT=${{ task.port(0, 9000) }}\n#cezar DB=app${{ task.suffix }}\nDB=stale\n', null);
    expect(saved.ok && saved.value.content).toBe('#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\n#cezar DB=app${{ task.suffix }}\nDB=app\n');
    expect(readFileSync(join(repo, 'apps/api/.env'), 'utf8')).toBe('#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\n#cezar DB=app${{ task.suffix }}\nDB=app\n');
  });

  it('refuses a directive it cannot render, naming the line, and writes nothing', async () => {
    const refused = await writeEnvFile(repo, 'apps/api/.env', 'A=1\n#cezar B=${{ env.HOME }}\n', null);
    expect(refused).toEqual({ ok: false, status: 400, error: expect.stringMatching(/apps\/api\/\.env, line 2: unknown reference "env.HOME"/) });
    expect(existsSync(join(repo, 'apps/api/.env'))).toBe(false);
  });

  it('a file reading a value from the saved one follows it', async () => {
    put('apps/web/.env', '#cezar API=http://localhost:${{ apps/api/.env:PORT }}\nAPI=http://localhost:1\n');
    await writeEnvFile(repo, 'apps/api/.env', 'PORT=4000\n', null);
    expect(readFileSync(join(repo, 'apps/web/.env'), 'utf8')).toBe('#cezar API=http://localhost:${{ apps/api/.env:PORT }}\nAPI=http://localhost:4000\n');
  });

  it('leaves a file without directives byte for byte', async () => {
    await writeEnvFile(repo, 'apps/api/.env', 'A="x # y"\n# note\n', null);
    expect(readFileSync(join(repo, 'apps/api/.env'), 'utf8')).toBe('A="x # y"\n# note\n');
  });

  it('refuses a save over a file that changed since it was opened', async () => {
    put('apps/api/.env', 'A=1\n');
    const opened = await readEnvFile(repo, 'apps/api/.env');
    if (!opened.ok) throw new Error(opened.error);
    put('apps/api/.env', 'A=2\n');
    const saved = await writeEnvFile(repo, 'apps/api/.env', 'A=3\n', opened.value.version);
    expect(saved).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(join(repo, 'apps/api/.env'), 'utf8')).toBe('A=2\n');
  });

  it('refuses a path git would commit', async () => {
    const saved = await writeEnvFile(repo, 'apps/web/.env.test', 'X=1\n', null);
    expect(saved).toMatchObject({ ok: false, status: 409 });
    expect(saved.ok ? '' : saved.error).toContain('git does not ignore');
    expect(readFileSync(join(repo, 'apps/web/.env.test'), 'utf8')).toBe('TRACKED=1\n');
  });

  it('refuses paths that leave the checkout or are not env files', async () => {
    mkdirSync(join(repo, 'nested/.git'), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'cez-env-outside-'));
    symlinkSync(outside, join(repo, 'link'));
    for (const [path, status] of [
      ['../.env', 400], ['/etc/.env', 400], ['apps/api/config.json', 400], ['.git/.env', 400],
      ['node_modules/x/.env', 400], ['nested/.env', 409], ['link/.env', 409], ['missing/.env', 409],
    ] as const) {
      expect(await writeEnvFile(repo, path, 'A=1\n', null), path).toMatchObject({ ok: false, status });
    }
    expect(existsSync(join(outside, '.env'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('removes a file, and says so when there is none', async () => {
    put('.env', 'A=1\n');
    expect(await removeEnvFile(repo, '.env')).toEqual({ ok: true, value: null });
    expect(existsSync(join(repo, '.env'))).toBe(false);
    expect(await removeEnvFile(repo, '.env')).toMatchObject({ ok: false, status: 404 });
  });
});
