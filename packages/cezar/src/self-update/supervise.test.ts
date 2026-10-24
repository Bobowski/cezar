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

  function manifest(path: string, commit?: { sha: string; at: string }): void {
    mkdirSync(join(path, ENTRY, '..'), { recursive: true });
    writeFileSync(join(path, ENTRY), '');
    writeFileSync(
      join(path, '.cezar-install.json'),
      JSON.stringify({ version: '0.17.0', source: 'image', installedAt: '2026-10-23T00:00:00.000Z', ...(commit ? { commit: { ...commit, subject: '', branch: 'brutus' } } : {}) }),
    );
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
  const launch = (uid: number, ...args: string[]) => {
    writeFileSync(join(dir, 'bin', 'id'), `#!/bin/sh\necho ${uid}\n`);
    chmodSync(join(dir, 'bin', 'id'), 0o755);
    return spawnSync('sh', [LAUNCHER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, CEZ_HOME: join(dir, 'home') },
    });
  };

  it('refuses update, install, use and link as root, with the -u node hint', () => {
    for (const command of ['update', 'install', 'use', 'link']) {
      const run = launch(0, command);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`docker compose exec -u node cezar cezar ${command}`);
      expect(run.stdout).toBe('');
    }
  });

  it('runs everything else as root, and update as node', () => {
    expect(launch(0, 'versions').stdout).toContain('versions');
    const run = launch(1000, 'update');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(' update');
  });
});
