import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_CAP, TerminalHistory, TypedLine, foldHistory, historyLine, readTerminalHistory } from './history.ts';

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
    await history.typed(dataDir, 's1', 'sudo apt update\r', async () => true);
    // `sudo` is running now: its password prompt reads the next line.
    await history.typed(dataDir, 's1', 'hunter2\r', async () => false);
    await history.flushed();
    expect(await readTerminalHistory(dataDir)).toEqual(['sudo apt update']);
    expect(readFileSync(join(dataDir, 'terminal-history.json'), 'utf8')).not.toContain('hunter2');
  });

  it('never asks whether the shell is idle when nothing certain was submitted', async () => {
    const history = new TerminalHistory();
    let asked = 0;
    await history.typed(dataDir, 's1', 'np', async () => { asked += 1; return true; });
    await history.typed(dataDir, 's1', '\x1b[A\r', async () => { asked += 1; return true; });
    expect(asked).toBe(0);
  });

  it('reads a damaged file as what it can salvage, and a missing one as empty', async () => {
    expect(await readTerminalHistory(dataDir)).toEqual([]);
    writeFileSync(join(dataDir, 'terminal-history.json'), JSON.stringify({ lines: ['ls', 7, 'ls', 'pwd'] }));
    expect(await readTerminalHistory(dataDir)).toEqual(['ls', 'pwd']);
    writeFileSync(join(dataDir, 'terminal-history.json'), '{not json');
    expect(await readTerminalHistory(dataDir)).toEqual([]);
  });
});
