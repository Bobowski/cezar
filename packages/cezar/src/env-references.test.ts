import { describe, expect, it } from 'vitest';

import { EnvReferenceError, hasDirectives, parseSource, readDirectives, renderEnvFiles, type EnvRenderContext } from './env-references.ts';

const main: EnvRenderContext = { projectRoot: '/srv/app', worktreePath: '/srv/app' };
const task3: EnvRenderContext = { projectRoot: '/srv/app', worktreePath: '/srv/app/.ai/cezar/worktrees/r1', slot: 3, runId: 'r1' };

const BACKEND = [
  '# Backend',
  '#cezar PORT=${{ task.port(0, 9000) }}',
  'PORT=9000',
  '#cezar DATABASE_URL=postgres://u:p@localhost:${{ task.port(2, 5432) }}/app${{ task.suffix }}',
  'DATABASE_URL=postgres://u:p@localhost:5432/app',
  'SECRET="keep # me"',
  '',
].join('\n');

const STOREFRONT = [
  '#cezar MEDUSA_BACKEND_URL=http://localhost:${{ apps/backend/.env:PORT }}',
  'MEDUSA_BACKEND_URL=http://localhost:9000',
  '#cezar STORE_PORT=${{ task.port(1, 3000) }}',
  'STORE_PORT=3000',
  '#cezar SITE=http://localhost:${{ STORE_PORT }}',
  'SITE=http://localhost:3000',
  '',
].join('\n');

const files = () => new Map([['apps/backend/.env', BACKEND], ['apps/storefront/.env', STOREFRONT]]);

describe('renderEnvFiles', () => {
  it('leaves the main checkout as it is when its values already match', () => {
    expect(renderEnvFiles(files(), main).size).toBe(0);
  });

  it('renders task values from the slot, following same-file and cross-file references', () => {
    const out = renderEnvFiles(files(), task3);
    expect(out.get('apps/backend/.env')).toBe(BACKEND
      .replace('PORT=9000', 'PORT=20300')
      .replace('localhost:5432/app', 'localhost:20302/app_3'));
    expect(out.get('apps/storefront/.env')).toBe(STOREFRONT
      .replace('MEDUSA_BACKEND_URL=http://localhost:9000', 'MEDUSA_BACKEND_URL=http://localhost:20300')
      .replace('STORE_PORT=3000', 'STORE_PORT=20301')
      .replace('SITE=http://localhost:3000', 'SITE=http://localhost:20301'));
  });

  it('keeps every line it does not own byte for byte', () => {
    const out = renderEnvFiles(files(), task3).get('apps/backend/.env')!;
    expect(out).toContain('# Backend\n');
    expect(out).toContain('SECRET="keep # me"\n');
    expect(out).toContain('#cezar PORT=${{ task.port(0, 9000) }}\n');
  });

  it('renders a task without a slot like the main checkout', () => {
    expect(renderEnvFiles(files(), { ...task3, slot: undefined }).size).toBe(0);
  });

  it('fills the simple references', () => {
    const text = [
      '#cezar A=${{ task.slot }}|${{ task.suffix }}|${{ task.id }}',
      '#cezar B=${{ worktree.path }}',
      '#cezar C=${{ project.root }}',
      '#cezar D=\\${{ literal }}',
      '',
    ].join('\n');
    const out = renderEnvFiles(new Map([['.env', text]]), task3).get('.env')!;
    expect(out).toBe([
      '#cezar A=${{ task.slot }}|${{ task.suffix }}|${{ task.id }}', 'A=3|_3|r1',
      '#cezar B=${{ worktree.path }}', 'B=/srv/app/.ai/cezar/worktrees/r1',
      '#cezar C=${{ project.root }}', 'C=/srv/app',
      '#cezar D=\\${{ literal }}', 'D="\\${{ literal }}"',
      '',
    ].join('\n'));
  });

  it('inserts the assignment under a directive that has none', () => {
    const out = renderEnvFiles(new Map([['.env', '#cezar PORT=${{ task.port(0, 9000) }}\nOTHER=1\n']]), main).get('.env');
    expect(out).toBe('#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\nOTHER=1\n');
  });

  it('keeps an export prefix and quotes a value that needs it', () => {
    const text = '#cezar GREETING=hello ${{ task.slot }} world\nexport GREETING=old\n';
    expect(renderEnvFiles(new Map([['.env', text]]), task3).get('.env')).toBe('#cezar GREETING=hello ${{ task.slot }} world\nexport GREETING="hello 3 world"\n');
  });

  it('refuses a cycle, naming it', () => {
    const text = '#cezar A=${{ B }}\nA=\n#cezar B=${{ A }}\nB=\n';
    expect(() => renderEnvFiles(new Map([['.env', text]]), main)).toThrow(/cycle: .env:A → .env:B → .env:A/);
  });

  it('refuses a cross-file cycle', () => {
    const one = '#cezar X=${{ two/.env:Y }}\nX=\n';
    const two = '#cezar Y=${{ .env:X }}\nY=\n';
    expect(() => renderEnvFiles(new Map([['.env', one], ['two/.env', two]]), main)).toThrow(/cycle/);
  });

  it('refuses a variable that is not set, and a file that is not in the project', () => {
    expect(() => renderEnvFiles(new Map([['.env', '#cezar A=${{ MISSING }}\nA=\n']]), main)).toThrow(/MISSING is not set in .env/);
    expect(() => renderEnvFiles(new Map([['.env', '#cezar A=${{ api/.env:PORT }}\nA=\n']]), main)).toThrow(/no env file api\/.env/);
  });

  it('refuses a directive that is not right above its own assignment', () => {
    expect(() => renderEnvFiles(new Map([['.env', 'PORT=1\n#cezar PORT=${{ task.port(0, 9000) }}\nOTHER=2\n']]), main)).toThrow(/right above/);
  });
});

describe('readDirectives / parseSource', () => {
  it('reports the line of a bad directive or reference', () => {
    expect(() => readDirectives('.env', 'A=1\n#cezar nope\n')).toThrow(EnvReferenceError);
    expect(() => readDirectives('.env', 'A=1\n#cezar nope\n')).toThrow(/line 2/);
    expect(() => readDirectives('.env', '#cezar A=${{ task.port(0) }}\n')).toThrow(/task.port\(k, default\)/);
    expect(() => readDirectives('.env', '#cezar A=${{ env.HOME }}\n')).toThrow(/unknown reference "env.HOME"/);
    expect(() => readDirectives('.env', '#cezar A=${{ task.slot\n')).toThrow(/close the reference/);
    expect(() => readDirectives('.env', '#cezar A=1\n#cezar A=2\n')).toThrow(/two #cezar directives/);
  });

  it('parses literal text and references in order', () => {
    expect(parseSource('http://x:${{ task.port(1, 3000) }}/y')).toEqual({
      pieces: ['http://x:', { kind: 'task.port', offset: 1, fallback: 3000 }, '/y'],
    });
  });

  it('a plain comment is not a directive', () => {
    expect(hasDirectives('# cezar is great\nA=1\n')).toBe(false);
    expect(hasDirectives('#cezar A=1\n')).toBe(true);
  });
});
