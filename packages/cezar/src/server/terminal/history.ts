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
 * typing, backspace, a paste) and the shell sat at its prompt when it was begun: an arrow key,
 * a Tab or a Ctrl chord leaves the line unknown, and a busy shell is a program reading input — a
 * `sudo` or `ssh` password prompt among them — so neither is kept.
 *
 * "At its prompt" is a process-table read started on the line's FIRST keystroke and never awaited
 * by any keystroke: the shell has no child then, or only the line's own command (one chunk can
 * carry a whole line, and the shell forks it while `ps` starts). An answer later than
 * `PROMPT_CHECK_TIMEOUT_MS` keeps nothing.
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

/** What one chunk of keystrokes did to the line, in order: a line began, or one was submitted
 *  (`text` null when only the shell knows what it said). */
export type LineEvent = { kind: 'begin' } | { kind: 'submit'; text: string | null };

/** One session's line as it is being typed. */
export class TypedLine {
  private text = '';
  private known = true;
  private started = false;

  /** Feed keystrokes; returns every line SUBMITTED in them whose text is certain. */
  feed(data: string): string[] {
    return this.events(data).flatMap((event) => (event.kind === 'submit' && event.text !== null && event.text !== '' ? [event.text] : []));
  }

  events(data: string): LineEvent[] {
    const out: LineEvent[] = [];
    const input = data.replace(PASTE_MARKERS, '');
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index]!;
      if (!this.started) {
        this.started = true;
        out.push({ kind: 'begin' });
      }
      if (char === '\r' || char === '\n') {
        out.push({ kind: 'submit', text: this.known ? this.text : null });
        this.reset();
      } else if (char === '\x7f' || char === '\b') {
        this.text = [...this.text].slice(0, -1).join('');
      } else if (char === '\x03' || char === '\x15' || char === '\x1a') {
        // Ctrl+C abandons the line (or a program), Ctrl+U kills it, Ctrl+Z suspends a program:
        // what follows is a new line, owed a prompt check of its own.
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
    return out;
  }

  private reset(): void {
    this.text = '';
    this.known = true;
    this.started = false;
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

/** A prompt check slower than this keeps nothing: the keystroke never waited for it, and a late
 *  answer may describe a shell that has moved on. */
export const PROMPT_CHECK_TIMEOUT_MS = 300;

/** The commands of the shell's direct children right now, or null when the table is unreadable. */
export type ShellChildren = () => Promise<readonly string[] | null>;

/** The first word of each command in `line`: `a | b && FOO=1 c` → `a`, `b`, `c`. */
function lineCommands(line: string): string[] {
  return line.split(/\|\|?|&&?|;/).flatMap((segment) => {
    const words = segment.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    return words[0] ? [words[0]] : [];
  });
}

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/**
 * Whether a shell with these children was at its prompt for `line`: none, or each one the line's
 * own command — `ps` reads `node /usr/bin/npm run dev` for `npm run dev`, so either of its first
 * two words may be the name.
 */
export function atPromptFor(children: readonly string[], line: string): boolean {
  const own = new Set(lineCommands(line).map(baseName));
  return children.every((child) => child.trim().split(/\s+/).slice(0, 2).some((word) => own.has(baseName(word))));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

interface SessionState {
  line: TypedLine;
  /** The prompt check of the line being typed, begun with its first keystroke. */
  check: Promise<readonly string[] | null> | null;
  /** Decisions, in submission order, so lines land in the file in the order they were typed. */
  decided: Promise<void>;
}

/**
 * Every project's history, fed by the input routes. Nothing here is awaited by a keystroke: the
 * check runs beside the write, and writes are serialized per data directory; a failed write (a
 * read-only checkout) loses that line, nothing more.
 */
export class TerminalHistory {
  private readonly sessions = new Map<string, SessionState>();
  private readonly writes = new Map<string, Promise<void>>();

  /**
   * Keystrokes typed into one session of a project. Call it as they are written to the shell: a
   * line's check starts here, with its first keystroke, so it sees the shell as the line found it.
   */
  typed(dataDir: string, sessionId: string, data: string, children: ShellChildren): void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { line: new TypedLine(), check: null, decided: Promise.resolve() };
      this.sessions.set(sessionId, state);
    }
    for (const event of state.line.events(data)) {
      if (event.kind === 'begin') {
        state.check = withTimeout(children(), PROMPT_CHECK_TIMEOUT_MS);
        continue;
      }
      const check = state.check;
      state.check = null;
      const entry = event.text === null ? null : historyLine(event.text);
      if (entry === null || check === null) continue;
      state.decided = state.decided.then(async () => {
        const found = await check;
        if (found !== null && atPromptFor(found, entry)) this.append(dataDir, [entry]);
      });
    }
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Settles once every line typed so far is decided and written. A test seam, and the server's shutdown. */
  async flushed(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((state) => state.decided));
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
