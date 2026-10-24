import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freshSnapshotReader } from './foreground.ts';
import { HISTORY_CAP, PROMPT_CHECK_CAP_MS, TerminalHistory, TypedLine, foldHistory, historyLine, readTerminalHistory } from './history.ts';

describe('TypedLine (spec 2026-10-24-code-page-terminal §3.3)', () => {
  it('submits plain typing, with backspace applied, one keystroke at a time', () => {
    const line = new TypedLine();
    const submitted = ['n', 'p', 'm', ' ', 'r', 'u', 'x', '\x7f', 'n', '\r'].flatMap((key) => line.feed(key));
    expect(submitted).toEqual(['npm run']);
  });

  it('takes a paste, bracketed or not, and every line of a multi-line one', () => {
    expect(new TypedLine().feed('\x1b[200~git status\x1b[201~\r')).toEqual(['git status']);
    expect(new TypedLine().feed('make build\rmake test\r')).toEqual(['make build', 'make test']);
  });

  it('drops a line whose text only the shell knows: arrows, Tab, Ctrl chords', () => {
    expect(new TypedLine().feed('\x1b[A\r')).toEqual([]);
    expect(new TypedLine().feed('git ch\tmain\r')).toEqual([]);
    expect(new TypedLine().feed('ls\x1bOD -la\r')).toEqual([]);
    expect(new TypedLine().feed('ls\x17pwd\r')).toEqual([]);
  });

  it('starts clean after Enter, Ctrl+C and Ctrl+U', () => {
    const line = new TypedLine();
    expect(line.feed('\x1b[Aoops\r')).toEqual([]);
    expect(line.feed('ls\r')).toEqual(['ls']);
    expect(line.feed('rm -rf build\x03')).toEqual([]);
    expect(line.feed('pwd\r')).toEqual(['pwd']);
    expect(line.feed('typo\x15make\r')).toEqual(['make']);
  });
});

describe('history folding', () => {
  it('keeps the newest first, deduped, at most the cap', () => {
    expect(foldHistory(['b', 'a'], ['a', 'c'])).toEqual(['c', 'a', 'b']);
    const many = Array.from({ length: HISTORY_CAP + 20 }, (_, index) => `cmd ${index}`);
    const folded = foldHistory([], many);
    expect(folded).toHaveLength(HISTORY_CAP);
    expect(folded[0]).toBe(`cmd ${HISTORY_CAP + 19}`);
  });

  it('skips blank lines and the ones led by a space', () => {
    expect(historyLine('  ')).toBeNull();
    expect(historyLine(' export TOKEN=secret')).toBeNull();
    expect(historyLine('npm test  ')).toBe('npm test');
  });

  it('stores a secret-named assignment with its value as ***', () => {
    expect(historyLine('export GITHUB_TOKEN=ghp_abc123')).toBe('export GITHUB_TOKEN=***');
    expect(historyLine('DB_PASS="a b c" npm run migrate')).toBe('DB_PASS=*** npm run migrate');
    expect(historyLine("FOO=1 OPENAI_API_KEY='sk-x' make && SECRET=y ./run")).toBe('FOO=1 OPENAI_API_KEY=*** make && SECRET=*** ./run');
    expect(historyLine('export KEY=abc PASSWORD=hunter2')).toBe('export KEY=*** PASSWORD=***');
    // Ordinary names, and a secret-looking word that is not an assignment, stay as typed.
    expect(historyLine('PORT=3000 NODE_ENV=dev npm run dev')).toBe('PORT=3000 NODE_ENV=dev npm run dev');
    expect(historyLine('grep -r TOKEN src')).toBe('grep -r TOKEN src');
  });

  it('masks a secret-named assignment\'s whole value: a substitution, an expansion, a quoted run', () => {
    expect(historyLine('export GITHUB_TOKEN=$(cat ~/t)')).toBe('export GITHUB_TOKEN=***');
    expect(historyLine('TOKEN=$(cat ~/t) && make')).toBe('TOKEN=*** && make');
    expect(historyLine('TOKEN="$(gh auth token)" npm publish')).toBe('TOKEN=*** npm publish');
    expect(historyLine('API_KEY=`cat key file` make')).toBe('API_KEY=*** make');
    expect(historyLine('TOKEN=${VAULT_TOKEN:-dev token} ./run')).toBe('TOKEN=*** ./run');
    expect(historyLine('SECRET=a"b c"d ./x')).toBe('SECRET=*** ./x');
    expect(historyLine('(make; TOKEN=abc)')).toBe('(make; TOKEN=***)');
    expect(historyLine('export TOKEN=$(vault read -field=x a) PASSWORD=b')).toBe('export TOKEN=*** PASSWORD=***');
  });

  it('stores no credential a flag, a header, a URL or a token shape carries', () => {
    const pat = 'ghp_' + 'a'.repeat(36);
    expect(historyLine(`curl -H "Authorization: Bearer ${pat}" https://api.github.com/user`))
      .toBe('curl -H "Authorization: Bearer ***" https://api.github.com/user');
    expect(historyLine(`gh auth login --with-token <<< ${pat}`)).toBe('gh auth login --with-token <<< ***');
    expect(historyLine('docker login --password-stdin <<< "hunter2 x"')).toBe('docker login --password-stdin <<< ***');
    expect(historyLine('echo hunter2 | docker login -u me --password-stdin')).toBe('echo *** | docker login -u me --password-stdin');
    expect(historyLine('psql --password=hunter2 --token hunter3 -h db')).toBe('psql --password=*** --token *** -h db');
    expect(historyLine('mysql -u root -phunter2 shop && mysqldump -p"a b" shop')).toBe('mysql -u root -p*** shop && mysqldump -p*** shop');
    expect(historyLine('curl -u admin:hunter2 http://x')).toBe('curl -u admin:*** http://x');
    expect(historyLine('git clone https://x-access-token:tok3n@github.com/o/r.git')).toBe('git clone https://***@github.com/o/r.git');
    expect(historyLine('psql postgres://app:hunter2@db:5432/app')).toBe('psql postgres://***@db:5432/app');
    expect(historyLine(`npm config set //registry/:_authToken sk-${'b'.repeat(24)}`)).toBe('npm config set //registry/:_authToken [REDACTED]');
    expect(historyLine('deploy s3cret-value-from-env', ['s3cret-value-from-env'])).toBe('deploy [REDACTED]');
    // What carries no credential stays as typed: a bare `-p` (mysql asks), a port, an ssh user.
    expect(historyLine('mysql -u root -p')).toBe('mysql -u root -p');
    expect(historyLine('psql -p 5433 -h db')).toBe('psql -p 5433 -h db');
    expect(historyLine('git clone ssh://git@github.com/o/r.git')).toBe('git clone ssh://git@github.com/o/r.git');
    expect(historyLine('gh auth login --with-token < token.txt')).toBe('gh auth login --with-token < token.txt');
  });

  it('stores no password a spaced short flag carries, for the clients that take one', () => {
    expect(historyLine('sshpass -p hunter2 ssh me@host')).toBe('sshpass -p *** ssh me@host');
    expect(historyLine('docker login -u me -p hunter2 registry.io')).toBe('docker login -u me -p *** registry.io');
    expect(historyLine('podman login -p "a b" quay.io')).toBe('podman login -p *** quay.io');
    expect(historyLine('redis-cli -h cache -a hunter2 ping')).toBe('redis-cli -h cache -a *** ping');
    expect(historyLine('mysql -u root -p hunter2 shop')).toBe('mysql -u root -p *** shop');
    expect(historyLine('sudo mysql -p hunter2')).toBe('sudo mysql -p ***');
    expect(historyLine('mysql --password hunter2 shop')).toBe('mysql --password *** shop');
    expect(historyLine('vault login --token hunter2')).toBe('vault login --token ***');
    // `-p` is a port, a publish or a parent flag everywhere else.
    expect(historyLine('docker run -p 8080:80 nginx')).toBe('docker run -p 8080:80 nginx');
    expect(historyLine('mkdir -p build/out')).toBe('mkdir -p build/out');
    expect(historyLine('redis-cli -h cache ping')).toBe('redis-cli -h cache ping');
  });

  it('stores no password curl\'s -u carries, glued or spaced', () => {
    expect(historyLine('curl -uadmin:hunter2 http://x')).toBe('curl -uadmin:*** http://x');
    expect(historyLine('curl -u admin:hunter2 http://x')).toBe('curl -u admin:*** http://x');
    expect(historyLine('curl --user=admin:hunter2 http://x')).toBe('curl --user=admin:*** http://x');
    expect(historyLine('curl -u admin http://x')).toBe('curl -u admin http://x');
  });

  it('stores no password echoed into sudo -S or a --stdin flag', () => {
    expect(historyLine('echo hunter2 | sudo -S apt update')).toBe('echo *** | sudo -S apt update');
    expect(historyLine("printf 'hunter2\\n' | sudo -k -S true")).toBe('printf *** | sudo -k -S true');
    expect(historyLine('echo hunter2 | sudo -kS ls')).toBe('echo *** | sudo -kS ls');
    expect(historyLine('echo hunter2 | passwd --stdin me')).toBe('echo *** | passwd --stdin me');
    // Without a reader of the password, an echo is an echo.
    expect(historyLine('echo hello | sudo tee /etc/motd')).toBe('echo hello | sudo tee /etc/motd');
    expect(historyLine('echo hello | sudo -s')).toBe('echo hello | sudo -s');
  });

  it('stores no token a vendor header carries', () => {
    expect(historyLine('curl -H "PRIVATE-TOKEN: glpat-abc123" https://gitlab.com/api'))
      .toBe('curl -H "PRIVATE-TOKEN: ***" https://gitlab.com/api');
    expect(historyLine("curl -H 'X-Api-Key: abc123' https://x")).toBe("curl -H 'X-Api-Key: ***' https://x");
    expect(historyLine('curl -H X-Auth-Token:abc123 https://x')).toBe('curl -H X-Auth-Token:*** https://x');
    expect(historyLine('curl -H "Content-Type: application/json" https://x')).toBe('curl -H "Content-Type: application/json" https://x');
  });

  it('stores no token a URL query carries', () => {
    expect(historyLine('curl "https://api.x.io/v1?access_token=abc123&page=2"')).toBe('curl "https://api.x.io/v1?access_token=***&page=2"');
    expect(historyLine('curl https://x.io/a?page=2&token=abc123')).toBe('curl https://x.io/a?page=2&token=***');
    expect(historyLine("wget 'https://maps.x.com/api?q=a&key=AIzaabc'")).toBe("wget 'https://maps.x.com/api?q=a&key=***'");
    expect(historyLine('curl https://x.io/a?page=2&sort=name')).toBe('curl https://x.io/a?page=2&sort=name');
  });

  it('stores no secret kubectl --from-literal carries', () => {
    expect(historyLine('kubectl create secret generic db --from-literal=password=hunter2'))
      .toBe('kubectl create secret generic db --from-literal=password=***');
    expect(historyLine('kubectl create secret generic s --from-literal=api-key=abc --from-literal=user=app'))
      .toBe('kubectl create secret generic s --from-literal=api-key=*** --from-literal=user=app');
    expect(historyLine('kubectl create secret generic s --from-literal sshKey="a b"')).toBe('kubectl create secret generic s --from-literal sshKey=***');
  });
});

describe('TerminalHistory', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-term-history-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('writes what was typed at the prompt and nothing a busy shell was reading', async () => {
    const history = new TerminalHistory();
    history.typed(dataDir, 's1', 'sudo apt update\r', async () => []);
    // `sudo` is running now: its password prompt reads the next line.
    history.typed(dataDir, 's1', 'hunter2\r', async () => ['sudo apt update']);
    await history.flushed();
    expect(await readTerminalHistory(dataDir)).toEqual(['sudo apt update']);
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toContain('hunter2');
  });

  it('asks once per line, on its first word', async () => {
    const history = new TerminalHistory();
    let asked = 0;
    const children = async () => { asked += 1; return []; };
    for (const key of ['n', 'p', 'm', '\r']) history.typed(dataDir, 's1', key, children);
    // A recalled line is unknown text: nothing to keep, nothing to ask.
    history.typed(dataDir, 's1', '\x1b[A\r', children);
    await history.flushed();
    expect(asked).toBe(1);
    expect(await readTerminalHistory(dataDir)).toEqual(['npm']);
  });

  it('spawns no check for a bare Enter, a Ctrl+C or a line led by a space', async () => {
    const history = new TerminalHistory();
    let asked = 0;
    const children = async () => { asked += 1; return []; };
    for (let index = 0; index < 30; index += 1) history.typed(dataDir, 's1', '\r', children);
    for (const key of ['\x03', '\x15', '\x1a', '  \r', ' export TOKEN=x\r']) history.typed(dataDir, 's1', key, children);
    await history.flushed();
    expect(asked).toBe(0);
    expect(await readTerminalHistory(dataDir)).toEqual([]);
  });

  it('reads the line\'s own command, forked while the table was read, as the prompt', async () => {
    const history = new TerminalHistory();
    history.typed(dataDir, 's1', 'npm run dev\r', async () => ['node /usr/local/bin/npm run dev']);
    history.typed(dataDir, 's1', 'ls | wc -l\r', async () => ['ls', '/usr/bin/wc -l']);
    history.typed(dataDir, 's1', 'make\r', async () => ['vim notes.md']);
    await history.flushed();
    expect(await readTerminalHistory(dataDir)).toEqual(['ls | wc -l', 'npm run dev']);
  });

  it('keeps only the first line of a paste: the shell could show no prompt for the rest', async () => {
    let now = 0;
    const history = new TerminalHistory(() => now);
    history.typed(dataDir, 's1', 'ssh host\rpassw0rd\r', async () => []);
    now = 5_000;
    history.typed(dataDir, 's1', 'make build\rmake test\r', async () => []);
    await history.flushed();
    expect(await readTerminalHistory(dataDir)).toEqual(['make build', 'ssh host']);
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toContain('passw0rd');
  });

  it('never writes the value of a secret-named assignment to the file', async () => {
    const history = new TerminalHistory();
    history.typed(dataDir, 's1', 'export STRIPE_SECRET_KEY=sk_live_abc\r', async () => []);
    await history.flushed();
    expect(await readTerminalHistory(dataDir)).toEqual(['export STRIPE_SECRET_KEY=***']);
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toContain('sk_live_abc');
  });

  it('checks no line begun after an Enter or Ctrl+C in the same chunk, even one that ends an earlier line', async () => {
    let now = 0;
    const history = new TerminalHistory(() => now);
    let asked = 0;
    const children = async () => { asked += 1; return []; };
    history.typed(dataDir, 's1', 'mysql -u root -p', children);
    // The Enter and the password typed ahead of the prompt arrive as one chunk.
    history.typed(dataDir, 's1', '\rhunter2\r', children);
    now = 5_000;
    history.typed(dataDir, 's1', 'npm run dev', children);
    history.typed(dataDir, 's1', '\x03s3cret\r', children);
    await history.flushed();
    expect(asked).toBe(2);
    expect(await readTerminalHistory(dataDir)).toEqual(['mysql -u root -p']);
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toMatch(/hunter2|s3cret/);
  });

  it('keeps nothing after `exec`, which replaced the shell, and not the line `read -s` read', async () => {
    const history = new TerminalHistory();
    // `exec ssh`: the shell IS ssh now, so its table shows no child while the password is typed.
    history.typed(dataDir, 's1', 'exec ssh host\r', async () => []);
    history.typed(dataDir, 's1', 'passw0rd\r', async () => []);
    history.typed(dataDir, 's1', 'ls\r', async () => []);
    history.typed(dataDir, 's2', 'read -rsp "token: " TOKEN\r', async () => []);
    history.typed(dataDir, 's2', 's3cret\r', async () => []);
    history.typed(dataDir, 's2', 'echo done\r', async () => []);
    await history.flushed();
    expect(await readTerminalHistory(dataDir)).toEqual(['echo done', 'read -rsp "token: " TOKEN', 'exec ssh host']);
  });

  it('after ssh, sudo, su, passwd or gpg keeps nothing until a prompt is confirmed again', async () => {
    let now = 0;
    const history = new TerminalHistory(() => now);
    history.typed(dataDir, 's1', 'sudo -v\r', async () => []);
    // Typed ahead, before the shell had forked `sudo`: the table shows nothing yet.
    now = 20;
    history.typed(dataDir, 's1', 'hunter2\r', async () => []);
    // A check that cannot answer confirms nothing either.
    now = 2_000;
    history.typed(dataDir, 's1', 'make\r', async () => null);
    now = 3_000;
    history.typed(dataDir, 's1', 'git status\r', async () => []);
    history.typed(dataDir, 's1', 'ls\r', async () => []);
    await history.flushed();
    expect(await readTerminalHistory(dataDir)).toEqual(['ls', 'git status', 'sudo -v']);
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toContain('hunter2');
  });

  it('keeps nothing whose check timed out or could not read the table', async () => {
    const history = new TerminalHistory();
    history.typed(dataDir, 's1', 'ls\r', () => new Promise(() => {}));
    history.typed(dataDir, 's1', 'pwd\r', async () => null);
    const started = Date.now();
    await history.flushed();
    expect(Date.now() - started).toBeLessThan(PROMPT_CHECK_CAP_MS + 500);
    expect(await readTerminalHistory(dataDir)).toEqual([]);
  });

  it('scrubs a stored line of the host\'s and the project\'s secret values before writing it', async () => {
    const history = new TerminalHistory();
    const secrets = async () => ['project-stored-secret-1'];
    history.typed(dataDir, 's1', 'deploy --from project-stored-secret-1\r', async () => [], secrets);
    history.typed(dataDir, 's1', `curl -H "Authorization: Bearer ${'ghp_' + 'c'.repeat(36)}" x\r`, async () => [], secrets);
    await history.flushed();
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toMatch(/project-stored-secret-1|ghp_c/);
    expect(await readTerminalHistory(dataDir)).toEqual(['curl -H "Authorization: Bearer ***" x', 'deploy --from [REDACTED]']);
  });

  it('serves a line stored before redaction redacted, and rewrites it on the next write', async () => {
    const pat = 'ghp_' + 'd'.repeat(36);
    writeFileSync(join(dataDir, 'terminal-history.json'), JSON.stringify({ lines: [
      `curl -H "Authorization: Bearer ${pat}" x`, 'mysql -phunter2', 'mysql -p***', 'run old-env-secret-value',
    ] }));
    expect(await readTerminalHistory(dataDir, ['old-env-secret-value'])).toEqual([
      'curl -H "Authorization: Bearer ***" x', 'mysql -p***', 'run [REDACTED]',
    ]);
    const history = new TerminalHistory();
    history.typed(dataDir, 's1', 'ls\r', async () => [], async () => ['old-env-secret-value']);
    await history.flushed();
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toMatch(/ghp_d|hunter2|old-env-secret-value/);
  });

  it('times a queued check from when its read starts, not from the ask, within an overall cap', async () => {
    // Each `ps` takes 250 ms; the second session's read waits behind the first one's.
    const reader = freshSnapshotReader(() => new Promise((resolve) => setTimeout(() => resolve([]), 250)));
    const history = new TerminalHistory();
    const children = async () => ((await reader()) === null ? null : []);
    history.typed(dataDir, 's1', 'ls\r', children);
    history.typed(dataDir, 's2', 'pwd\r', children);
    // A check that never answers still lets go by the cap.
    history.typed(dataDir, 's3', 'make\r', () => new Promise(() => {}));
    const started = Date.now();
    await history.flushed();
    expect(Date.now() - started).toBeLessThan(PROMPT_CHECK_CAP_MS + 300);
    expect(await readTerminalHistory(dataDir)).toEqual(['pwd', 'ls']);
  });

  it('reads a damaged file as what it can salvage, and a missing one as empty', async () => {
    expect(await readTerminalHistory(dataDir)).toEqual([]);
    writeFileSync(join(dataDir, 'terminal-history.json'), JSON.stringify({ lines: ['ls', 7, 'ls', 'pwd'] }));
    expect(await readTerminalHistory(dataDir)).toEqual(['ls', 'pwd']);
    writeFileSync(join(dataDir, 'terminal-history.json'), '{not json');
    expect(await readTerminalHistory(dataDir)).toEqual([]);
  });
});
