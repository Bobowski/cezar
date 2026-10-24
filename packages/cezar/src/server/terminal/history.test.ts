import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_CAP, PROMPT_CHECK_TIMEOUT_MS, TerminalHistory, TypedLine, foldHistory, historyLine, readTerminalHistory } from './history.ts';

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
    expect(Date.now() - started).toBeLessThan(PROMPT_CHECK_TIMEOUT_MS + 500);
    expect(await readTerminalHistory(dataDir)).toEqual([]);
  });

  it('reads a damaged file as what it can salvage, and a missing one as empty', async () => {
    expect(await readTerminalHistory(dataDir)).toEqual([]);
    writeFileSync(join(dataDir, 'terminal-history.json'), JSON.stringify({ lines: ['ls', 7, 'ls', 'pwd'] }));
    expect(await readTerminalHistory(dataDir)).toEqual(['ls', 'pwd']);
    writeFileSync(join(dataDir, 'terminal-history.json'), '{not json');
    expect(await readTerminalHistory(dataDir)).toEqual([]);
  });
});
