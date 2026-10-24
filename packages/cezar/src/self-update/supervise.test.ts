import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The container's supervisor (docker/supervise.sh, spec 2026-10-23 §4.2–4.3), run for real in a
 * POSIX shell with a fake `node` that follows a plan and a fake `date` that follows its clock. It
 * needs real symlinks and `sh`, so it skips on Windows and wherever no POSIX shell exists.
 */
const SCRIPT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../docker/supervise.sh');
const haveShell = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).status === 0;
const shellOut = (cmd: string) => (haveShell ? spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }) : null);
const realDate = shellOut('command -v date')?.stdout.trim() ?? '';
const haveBootTools = haveShell && shellOut('command -v jq')?.status === 0 && shellOut('date -u -d 2026-01-01T00:00:00Z +%s')?.status === 0;

const ENTRY = 'node_modules/@open-mercato/cezar/dist/index.js';

describe.skipIf(!haveShell)('the container supervisor loop', () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-supervise-'));
    home = join(dir, 'home');
    for (const id of ['0.17.0+aaaaaaaa', '0.17.0+bbbbbbbb']) install(id);
    symlinkSync('0.17.0+aaaaaaaa', join(home, 'versions', 'current'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // One plan line per launch: `<exit code> <seconds it ran> [flip <id>]` — a flip is what the
    // server's own `activate` does before it exits 75.
    script(join(bin, 'node'), `
echo "$1" >>"$CALLS"
line=$(head -n 1 "$PLAN")
tail -n +2 "$PLAN" >"$PLAN.next" && mv "$PLAN.next" "$PLAN"
set -- $line
echo $(( $(cat "$CLOCK") + $2 )) >"$CLOCK"
# \`docker stop\` while this cezar runs: the supervisor must pass the TERM on.
if [ "\${3:-}" = term-supervisor ]; then
  trap 'exit 42' TERM
  kill -TERM "$(cat "$SUP_PID")"
  while :; do sleep 0.1; done
fi
if [ "\${3:-}" = flip ]; then
  ln -sfn "$(basename "$(readlink "$HOME_DIR/versions/current")")" "$HOME_DIR/versions/previous"
  ln -sfn "$4" "$HOME_DIR/versions/current"
fi
exit "$1"
`);
    // The `TERM_ON_DATE`th clock read signals the supervisor: a stop that lands between launches.
    script(join(bin, 'date'), `
if [ "$1" != "+%s" ]; then exec "$REAL_DATE" "$@"; fi
n=$(( $(cat "$DATES") + 1 ))
echo "$n" >"$DATES"
if [ "$n" = "\${TERM_ON_DATE:-0}" ]; then kill -TERM "$(cat "$SUP_PID")"; fi
cat "$CLOCK"
`);
    writeFileSync(join(dir, 'dates'), '0\n');
    writeFileSync(join(dir, 'clock'), '1000\n');
    writeFileSync(join(dir, 'calls'), '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function install(id: string): void {
    const entry = join(home, 'versions', id, ENTRY);
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '');
    writeFileSync(join(home, 'versions', id, '.cezar-install.json'), JSON.stringify({ version: '0.17.0', source: 'branch', installedAt: '2026-10-23T00:00:00.000Z' }));
  }

  function script(path: string, body: string): void {
    writeFileSync(path, `#!/bin/sh\n${body.trim()}\n`);
    chmodSync(path, 0o755);
  }

  /** Run the loop over `plan`; returns its exit status and the installs it launched, in order. */
  function supervise(plan: string[], extraEnv: NodeJS.ProcessEnv = {}): { code: number; launched: string[] } {
    writeFileSync(join(dir, 'plan'), `${plan.join('\n')}\n`);
    const harness = join(dir, 'harness.sh');
    script(harness, `
echo $$ >"$SUP_PID"
. "$SCRIPT"
run_cezar() { exec node "$@"; }
supervise_loop "$HOME_DIR" serve --port 4321
`);
    const result = spawnSync('sh', [harness], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        SCRIPT,
        HOME_DIR: home,
        PLAN: join(dir, 'plan'),
        CALLS: join(dir, 'calls'),
        CLOCK: join(dir, 'clock'),
        REAL_DATE: realDate,
        DATES: join(dir, 'dates'),
        SUP_PID: join(dir, 'supervisor.pid'),
        ...extraEnv,
      },
    });
    const launched = readFileSync(join(dir, 'calls'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((entry) => basename(resolve(entry, '../../../../..')));
    return { code: result.status ?? -1, launched };
  }

  const current = () => readlinkSync(join(home, 'versions', 'current'));

  it('relaunches from the new current after an update exits 75', () => {
    const run = supervise(['75 5 flip 0.17.0+bbbbbbbb', '0 100']);
    expect(run.launched).toEqual(['0.17.0+aaaaaaaa', '0.17.0+bbbbbbbb']);
    expect(run.code).toBe(0);
    expect(existsSync(join(home, 'rollback.json'))).toBe(false);
  });

  it('rolls a freshly activated version that crashes within 30 s back to previous, once, and records it', () => {
    const run = supervise(['75 5 flip 0.17.0+bbbbbbbb', '1 2', '0 100']);
    expect(run.launched).toEqual(['0.17.0+aaaaaaaa', '0.17.0+bbbbbbbb', '0.17.0+aaaaaaaa']);
    expect(run.code).toBe(0);
    expect(current()).toBe('0.17.0+aaaaaaaa');
    expect(JSON.parse(readFileSync(join(home, 'rollback.json'), 'utf8'))).toMatchObject({ from: '0.17.0+bbbbbbbb', to: '0.17.0+aaaaaaaa', exitCode: 1 });
  });

  it('exits with the status of a crash after 30 s — that is not a bad version', () => {
    const run = supervise(['75 5 flip 0.17.0+bbbbbbbb', '1 60']);
    expect(run.launched).toEqual(['0.17.0+aaaaaaaa', '0.17.0+bbbbbbbb']);
    expect(run.code).toBe(1);
    expect(current()).toBe('0.17.0+bbbbbbbb');
    expect(existsSync(join(home, 'rollback.json'))).toBe(false);
  });

  it('exits when the rolled-back version crashes too, leaving it to Docker', () => {
    const run = supervise(['75 5 flip 0.17.0+bbbbbbbb', '1 2', '3 2']);
    expect(run.launched).toEqual(['0.17.0+aaaaaaaa', '0.17.0+bbbbbbbb', '0.17.0+aaaaaaaa']);
    expect(run.code).toBe(3);
  });

  it('forwards a TERM to the running cezar and exits with its status, launching nothing more', () => {
    const run = supervise(['0 5 term-supervisor', '0 100']);
    expect(run.launched).toEqual(['0.17.0+aaaaaaaa']);
    expect(run.code).toBe(42);
  });

  it('a TERM between an update exit and the relaunch stops instead of relaunching', () => {
    // Clock read 1 times the first launch, read 2 the relaunch after the 75.
    const run = supervise(['75 5 flip 0.17.0+bbbbbbbb', '0 100'], { TERM_ON_DATE: '2' });
    expect(run.launched).toEqual(['0.17.0+aaaaaaaa']);
    expect(run.code).toBe(0);
  });

  it('rolls back the first launch of a build `cezar update` activated from the CLI, after a container restart', () => {
    // The CLI's activate: previous → aaaa, current → bbbb, and the marker naming bbbb.
    rmSync(join(home, 'versions', 'current'));
    symlinkSync('0.17.0+bbbbbbbb', join(home, 'versions', 'current'));
    symlinkSync('0.17.0+aaaaaaaa', join(home, 'versions', 'previous'));
    writeFileSync(join(home, 'versions', '.fresh'), '0.17.0+bbbbbbbb\n');
    const run = supervise(['1 2', '0 100']);
    expect(run.launched).toEqual(['0.17.0+bbbbbbbb', '0.17.0+aaaaaaaa']);
    expect(current()).toBe('0.17.0+aaaaaaaa');
    expect(JSON.parse(readFileSync(join(home, 'rollback.json'), 'utf8'))).toMatchObject({ from: '0.17.0+bbbbbbbb', to: '0.17.0+aaaaaaaa' });
    expect(existsSync(join(home, 'versions', '.fresh'))).toBe(false);
  });

  it('arms the guard once: a marker is consumed by its first launch, and one naming another id is dropped', () => {
    symlinkSync('0.17.0+bbbbbbbb', join(home, 'versions', 'previous'));
    writeFileSync(join(home, 'versions', '.fresh'), '0.17.0+aaaaaaaa\n');
    expect(supervise(['0 100']).code).toBe(0);
    expect(existsSync(join(home, 'versions', '.fresh'))).toBe(false);
    // The next restart of the same install is not a first launch.
    expect(supervise(['1 2']).code).toBe(1);
    expect(current()).toBe('0.17.0+aaaaaaaa');

    writeFileSync(join(home, 'versions', '.fresh'), '0.17.0+bbbbbbbb\n');
    expect(supervise(['1 2']).code).toBe(1);
    expect(current()).toBe('0.17.0+aaaaaaaa');
    expect(existsSync(join(home, 'versions', '.fresh'))).toBe(false);
  });

  it('never rolls back a version that was not just activated', () => {
    symlinkSync('0.17.0+bbbbbbbb', join(home, 'versions', 'previous'));
    const run = supervise(['1 2']);
    expect(run.launched).toEqual(['0.17.0+aaaaaaaa']);
    expect(run.code).toBe(1);
    expect(current()).toBe('0.17.0+aaaaaaaa');
  });
});

describe.skipIf(!haveBootTools)('the container supervisor boot choice', () => {
  let dir: string;
  let home: string;
  let image: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-supervise-boot-'));
    home = join(dir, 'home');
    image = join(dir, 'opt');
    mkdirSync(join(home, 'versions'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function manifest(path: string, commit?: { sha: string; at: string }, fields: Record<string, string> = {}): void {
    mkdirSync(join(path, ENTRY, '..'), { recursive: true });
    writeFileSync(join(path, ENTRY), '');
    writeFileSync(
      join(path, '.cezar-install.json'),
      JSON.stringify({
        version: '0.17.0',
        source: 'image',
        installedAt: '2026-10-23T00:00:00.000Z',
        ...(commit ? { commit: { ...commit, subject: '', branch: 'brutus' } } : {}),
        ...fields,
      }),
    );
  }
  /** A registry install as `current`: no commit, so it is dated by its publish date or install. */
  function registryCurrent(fields: Record<string, string>): void {
    manifest(join(home, 'versions', '0.16.0'), undefined, { version: '0.16.0', source: 'registry', ...fields });
    symlinkSync('0.16.0', join(home, 'versions', 'current'));
  }

  function boot(): string {
    const result = spawnSync('sh', ['-c', '. "$SCRIPT"; supervise_boot "$HOME_DIR" "$IMAGE_DIR"'], {
      encoding: 'utf8',
      env: { ...process.env, SCRIPT, HOME_DIR: home, IMAGE_DIR: image },
    });
    return result.stdout + result.stderr;
  }
  const current = () => readlinkSync(join(home, 'versions', 'current'));

  it('activates the image when nothing is current', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: '2026-10-20T00:00:00.000Z' });
    boot();
    expect(current()).toBe('0.17.0+image.e5f6a7b8');
    expect(readlinkSync(join(home, 'versions', '0.17.0+image.e5f6a7b8'))).toBe(join(image, '0.17.0+image'));
  });

  it('a rebuild at the same version drops the old build\'s link and starts the new one', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: '2026-10-20T00:00:00.000Z' });
    boot();
    expect(current()).toBe('0.17.0+image.e5f6a7b8');
    // Rebuilt: the same /opt path now holds another commit's install.
    manifest(join(image, '0.17.0+image'), { sha: 'f0e1d2c3b4a5', at: '2026-10-24T00:00:00.000Z' });
    boot();
    expect(existsSync(join(home, 'versions', '0.17.0+image.e5f6a7b8'))).toBe(false);
    expect(current()).toBe('0.17.0+image.f0e1d2c3');
  });

  it('names the image link by source.json when the manifest carries no commit', () => {
    manifest(join(image, '0.17.0+image'));
    writeFileSync(join(image, 'source.json'), JSON.stringify({ commit: 'c0ffee00aabb', branch: 'brutus', remote: '', committedAt: '' }));
    boot();
    expect(current()).toBe('0.17.0+image.c0ffee00');
  });

  it('keeps a current that is newer than the image, and says so', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: '2026-10-20T00:00:00.000Z' });
    manifest(join(home, 'versions', '0.17.0+a1b2c3d4'), { sha: 'a1b2c3d4', at: '2026-10-23T00:00:00.000Z' });
    symlinkSync('0.17.0+a1b2c3d4', join(home, 'versions', 'current'));
    expect(boot()).toContain('newer than the image');
    expect(current()).toBe('0.17.0+a1b2c3d4');
  });

  it('activates an image newer than current, keeping current as previous', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: '2026-10-24T00:00:00.000Z' });
    manifest(join(home, 'versions', '0.17.0+a1b2c3d4'), { sha: 'a1b2c3d4', at: '2026-10-23T00:00:00.000Z' });
    symlinkSync('0.17.0+a1b2c3d4', join(home, 'versions', 'current'));
    boot();
    expect(current()).toBe('0.17.0+image.e5f6a7b8');
    expect(readlinkSync(join(home, 'versions', 'previous'))).toBe('0.17.0+a1b2c3d4');
    expect(readFileSync(join(home, 'versions', '.fresh'), 'utf8').trim()).toBe('0.17.0+image.e5f6a7b8');
  });

  it('keeps current, and says so, when the image commit date does not parse', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: 'not-a-date' });
    manifest(join(home, 'versions', '0.17.0+a1b2c3d4'), { sha: 'a1b2c3d4', at: '2026-10-23T00:00:00.000Z' });
    symlinkSync('0.17.0+a1b2c3d4', join(home, 'versions', 'current'));
    expect(boot()).toContain('does not parse');
    expect(current()).toBe('0.17.0+a1b2c3d4');
  });

  it('keeps current when the image carries no commit', () => {
    manifest(join(image, '0.17.0+image'));
    manifest(join(home, 'versions', '0.17.0+a1b2c3d4'), { sha: 'a1b2c3d4', at: '2026-10-23T00:00:00.000Z' });
    symlinkSync('0.17.0+a1b2c3d4', join(home, 'versions', 'current'));
    expect(boot()).toContain('built without its commit');
    expect(current()).toBe('0.17.0+a1b2c3d4');
  });

  it('activates an image committed after a registry current was installed, and logs both dates', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: '2026-10-24T00:00:00.000Z' });
    registryCurrent({ installedAt: '2026-10-20T00:00:00.000Z' });
    const out = boot();
    expect(current()).toBe('0.17.0+image.e5f6a7b8');
    expect(out).toContain('committed 2026-10-24T00:00:00.000Z');
    expect(out).toContain('installed 2026-10-20T00:00:00.000Z');
  });

  it('dates a registry current by its publish date before its install time', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: '2026-10-24T00:00:00.000Z' });
    registryCurrent({ publishedAt: '2026-10-22T00:00:00.000Z', installedAt: '2026-10-25T00:00:00.000Z' });
    expect(boot()).toContain('published 2026-10-22T00:00:00.000Z');
    expect(current()).toBe('0.17.0+image.e5f6a7b8');
  });

  it('keeps a registry current published after the image commit', () => {
    manifest(join(image, '0.17.0+image'), { sha: 'e5f6a7b8c9d0', at: '2026-10-24T00:00:00.000Z' });
    registryCurrent({ publishedAt: '2026-10-25T00:00:00.000Z', installedAt: '2026-10-25T00:00:00.000Z' });
    expect(boot()).toContain('newer than the image');
    expect(current()).toBe('0.16.0');
  });

  it('keeps a registry current when the image carries no commit date either', () => {
    manifest(join(image, '0.17.0+image'));
    registryCurrent({ installedAt: '2026-10-20T00:00:00.000Z' });
    expect(boot()).toContain('built without its commit');
    expect(current()).toBe('0.16.0');
  });
});

// docs/docker.md: as root, `cezar update` would create a root-owned /data/cezar/source.
describe.skipIf(!haveShell)('the container launcher', () => {
  const LAUNCHER = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../docker/cezar-launcher.sh');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-launcher-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\necho "node $*"\n');
    chmodSync(join(dir, 'bin', 'node'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const launchWith = (extra: NodeJS.ProcessEnv, uid: number, ...args: string[]) => {
    writeFileSync(join(dir, 'bin', 'id'), `#!/bin/sh\necho ${uid}\n`);
    chmodSync(join(dir, 'bin', 'id'), 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, CEZ_HOME: join(dir, 'home'), ...extra };
    return spawnSync('sh', [LAUNCHER, ...args], { encoding: 'utf8', env });
  };
  const launch = (uid: number, ...args: string[]) => launchWith({}, uid, ...args);

  it('refuses update, install, use, link and serve as root, with the -u node hint', () => {
    for (const command of ['update', 'install', 'use', 'link', 'serve']) {
      const run = launch(0, command);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`docker compose exec -u node cezar cezar ${command}`);
      expect(run.stdout).toBe('');
    }
    // The bare command is `serve` too.
    expect(launch(0).stderr).toContain('docker compose exec -u node cezar cezar serve');
  });

  it('finds the command past flags, so flags alone are serve as well', () => {
    for (const args of [['--port', '4322'], ['-p', '4322', '--no-open'], ['--port=4322'], ['--repo', '/projects/x', 'serve'], ['--', 'update']]) {
      const run = launch(0, ...args);
      expect(run.status).toBe(1);
      expect(run.stdout).toBe('');
    }
    expect(launch(0, '--port', '4322').stderr).toContain(`run 'cezar serve' as node`);
    expect(launch(0, '--repo', '/projects/x', 'versions').stdout).toContain('versions');
    expect(launch(0, '--help').stdout).toContain('--help');
  });

  it('takes no env var as leave to run them as root', () => {
    const run = launchWith({ CEZ_ENTRYPOINT: '1', CEZ_SUPERVISED: '1' }, 0, 'serve');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
  });

  it('runs everything else as root, and update as node', () => {
    expect(launch(0, 'versions').stdout).toContain('versions');
    const run = launch(1000, 'update');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(' update');
  });
});

// Why the launcher needs no exemption: the entrypoint, the only root-started path, never execs it
// as root — the supervised server is `node <entry>` as node, anything else goes through setpriv.
describe('the container entrypoint', () => {
  const ENTRYPOINT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../docker/entrypoint.sh');
  it('drops to node before running cezar, on both of its paths', () => {
    const source = readFileSync(ENTRYPOINT, 'utf8');
    const execs = source.split(/\r?\n/).filter((line) => /\bexec\s/.test(line) && !line.trimStart().startsWith('#'));
    expect(execs).toEqual([
      '  run_cezar() { exec setpriv --reuid=node --regid=node --init-groups node "$@"; }',
      'exec setpriv --reuid=node --regid=node --init-groups "$@"',
    ]);
    expect(source).not.toContain('CEZ_ENTRYPOINT');
  });
});

// docker/image-install.sh: a token pasted with CEZ_SOURCE_REMOTE never reaches source.json.
describe.skipIf(!haveBootTools)('the image install', () => {
  const INSTALL = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../docker/image-install.sh');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-image-install-'));
    mkdirSync(join(dir, 'package'));
    writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name: '@open-mercato/cezar', version: '0.17.0' }));
    expect(spawnSync('tar', ['-czf', join(dir, 'cezar.tgz'), '-C', dir, 'package']).status).toBe(0);
    mkdirSync(join(dir, 'bin'));
    // `npm install --prefix <dir> …`: lay the entry down instead of installing.
    writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\nmkdir -p "$3/${ENTRY.replace(/\/index\.js$/, '')}" && touch "$3/${ENTRY}"\n`);
    chmodSync(join(dir, 'bin', 'npm'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['https://ghp_abc123@github.com/x/y.git', 'https://github.com/x/y.git'],
    ['https://github_pat_11AB_cd@github.com/x/y.git', 'https://github.com/x/y.git'],
    ['https://user:token@github.com/x/y.git', 'https://github.com/x/y.git'],
    ['ssh://git@github.com/x/y.git', 'ssh://git@github.com/x/y.git'],
    ['git@github.com:x/y.git', 'git@github.com:x/y.git'],
  ])('records %s as %s', (given, want) => {
    const run = spawnSync('sh', [INSTALL, join(dir, 'cezar.tgz'), join(dir, 'opt')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, CEZ_SOURCE_COMMIT: 'c0ffee00aabb', CEZ_SOURCE_BRANCH: 'brutus', CEZ_SOURCE_REMOTE: given, CEZ_SOURCE_COMMITTED_AT: '2026-10-20T00:00:00Z' },
    });
    expect(run.status, run.stderr).toBe(0);
    const source = readFileSync(join(dir, 'opt', 'source.json'), 'utf8');
    expect(JSON.parse(source).remote).toBe(want);
    expect(source).not.toMatch(/ghp_|github_pat_|token/);
  });
});
