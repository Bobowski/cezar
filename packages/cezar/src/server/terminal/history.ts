import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TERMINAL_HISTORY_CAP } from '@open-mercato/cezar-contract';
import { z } from 'zod';

import { atomicWriteJson } from '../../workspace/config.ts';

/**
 * The Code terminal's per-project history (spec `.ai/specs/2026-10-24-code-page-terminal.md`
 * §3.3): the lines the user typed at THIS project's shell prompts, newest first, deduped, capped.
 *
 * Read off the keystrokes the input routes already carry — the shell's own history file is per
 * shell, per user and shared across projects. A line counts only when its text is certain (plain
 * typing, backspace, a paste) and the shell sat at its prompt when it was submitted: an arrow key,
 * a Tab or a Ctrl chord leaves the line unknown, and a busy shell is a program reading input — a
 * `sudo` or `ssh` password prompt among them — so neither is kept.
 */

export const HISTORY_CAP = TERMINAL_HISTORY_CAP;
/** Longer than any line worth completing; past it the line is dropped rather than stored. */
const MAX_LINE = 2_000;

const fileSchema = z.object({
  lines: z.array(z.unknown()).catch([]),
}).passthrough().catch({ lines: [] });

/** Bracketed-paste markers: xterm wraps a paste in them when the shell asks, and the text inside
 *  is plain typing for our purposes. */
// eslint-disable-next-line no-control-regex
const PASTE_MARKERS = /\x1b\[20[01]~/g;

/** One session's line as it is being typed. */
export class TypedLine {
  private text = '';
  private known = true;

  /** Feed keystrokes; returns every line SUBMITTED in them whose text is certain. */
  feed(data: string): string[] {
    const submitted: string[] = [];
    const input = data.replace(PASTE_MARKERS, '');
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index]!;
      if (char === '\r' || char === '\n') {
        if (this.known && this.text !== '') submitted.push(this.text);
        this.reset();
      } else if (char === '\x7f' || char === '\b') {
        this.text = [...this.text].slice(0, -1).join('');
      } else if (char === '\x03' || char === '\x15') {
        // Ctrl+C abandons the line; Ctrl+U kills it (the cursor is at its end while it is known).
        this.reset();
      } else if (char === '\x1b') {
        this.known = false;
        index = skipEscape(input, index);
      } else if (char < ' ') {
        // Tab, Ctrl+W, Ctrl+R…: the shell edits the line in ways only it knows.
        this.known = false;
      } else if (this.known) {
        this.text += char;
        if (this.text.length > MAX_LINE) this.known = false;
      }
    }
    return submitted;
  }

  private reset(): void {
    this.text = '';
    this.known = true;
  }
}

/** The index of the last character of the escape sequence starting at `start`. */
function skipEscape(input: string, start: number): number {
  const next = input[start + 1];
  if (next === '[') {
    let index = start + 2;
    while (index < input.length && !/[@-~]/.test(input[index]!)) index += 1;
    return index;
  }
  // SS3 (`ESC O A`, an arrow in application mode) and Alt+key are both two characters plus one.
  if (next === 'O') return Math.min(start + 2, input.length - 1);
  return Math.min(start + 1, input.length - 1);
}

/** `added` (oldest first) folded into `lines` (newest first): deduped, capped. */
export function foldHistory(lines: readonly string[], added: readonly string[], cap = HISTORY_CAP): string[] {
  const out = [...lines];
  for (const line of added) {
    const existing = out.indexOf(line);
    if (existing !== -1) out.splice(existing, 1);
    out.unshift(line);
  }
  return out.slice(0, cap);
}

/** The line as stored, or null when it is not kept: blank, or led by a space (bash's
 *  `ignorespace` convention for "do not remember this one"). */
export function historyLine(raw: string): string | null {
  if (raw.startsWith(' ')) return null;
  const line = raw.trim();
  return line === '' ? null : line;
}

export async function readTerminalHistory(dataDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, 'terminal-history.json'), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // Per-entry salvage: one odd row never costs the rest.
  const lines = fileSchema.parse(parsed).lines.filter((line): line is string => typeof line === 'string' && line.length <= MAX_LINE);
  return foldHistory([], [...new Set(lines)].reverse());
}

/**
 * Every project's history, fed by the input routes. Writes are serialized per data directory and
 * never awaited by a keystroke; a failed write (a read-only checkout) loses that line, nothing more.
 */
export class TerminalHistory {
  private readonly lines = new Map<string, TypedLine>();
  private readonly writes = new Map<string, Promise<void>>();

  /**
   * Keystrokes typed into one session of a project. Resolves once it is decided whether a
   * submitted line is kept — call it BEFORE the keystrokes reach the shell, so `atPrompt` sees the
   * shell as it was when the line was submitted rather than running the command it started.
   */
  async typed(dataDir: string, sessionId: string, data: string, atPrompt: () => Promise<boolean>): Promise<void> {
    let line = this.lines.get(sessionId);
    if (!line) {
      line = new TypedLine();
      this.lines.set(sessionId, line);
    }
    const kept = line.feed(data).map(historyLine).filter((entry): entry is string => entry !== null);
    if (kept.length === 0) return;
    if (!(await atPrompt().catch(() => false))) return;
    this.append(dataDir, kept);
  }

  forget(sessionId: string): void {
    this.lines.delete(sessionId);
  }

  /** Settles once every write queued so far has. A test seam, and the server's shutdown. */
  async flushed(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  private append(dataDir: string, added: string[]): void {
    const previous = this.writes.get(dataDir) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const current = await readTerminalHistory(dataDir);
        await atomicWriteJson(join(dataDir, 'terminal-history.json'), { lines: foldHistory(current, added) });
      })
      .catch(() => {});
    this.writes.set(dataDir, next);
    void next.finally(() => {
      if (this.writes.get(dataDir) === next) this.writes.delete(dataDir);
    });
  }
}
