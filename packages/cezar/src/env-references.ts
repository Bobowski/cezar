import { ENV_KEY_PATTERN, formatAssignment, parseEnv, serializeEnv, type EnvLine } from '@open-mercato/cezar-contract';
import { PORT_BLOCK_SIZE, PORT_BLOCK_START } from './task-slot.ts';

/**
 * `${{ … }}` references in env files, rendered per checkout (spec
 * `.ai/specs/2026-10-21-env-references.md`).
 *
 * A reference lives in the file itself, as a `#cezar KEY=source` directive above the assignment it
 * renders, so an app only ever reads a comment and a plain value and cezar keeps no store of its
 * own. Rendering replaces exactly the assignment under each directive; every other byte stays.
 * Pure: the caller reads and writes the files. Ports come from the slot's block (task-slot.ts),
 * so a rendered file and the agent's CEZ_TASK_PORT_BASE always agree.
 */

export interface EnvRenderContext {
  /** The project's main checkout. */
  projectRoot: string;
  /** The checkout being rendered: the project root itself, or a task worktree. */
  worktreePath: string;
  /** The task's slot; absent in the main checkout and for a task that has none. */
  slot?: number;
  runId?: string;
}

export type EnvReference =
  | { kind: 'task.port'; offset: number; fallback: number }
  | { kind: 'task.slot' | 'task.suffix' | 'task.id' | 'worktree.path' | 'project.root' }
  | { kind: 'var'; key: string }
  | { kind: 'file'; path: string; key: string };

type Piece = string | EnvReference;

export class EnvReferenceError extends Error {
  constructor(message: string, readonly path: string, readonly line?: number) {
    super(line === undefined ? `${path}: ${message}` : `${path}, line ${line}: ${message}`);
    this.name = 'EnvReferenceError';
  }
}

export const DIRECTIVE_PREFIX = '#cezar ';
const DIRECTIVE = /^#cezar\s+(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/;
const PATH_REF = /^((?:[A-Za-z0-9_.-]+\/)*\.env(?:\.[A-Za-z0-9_-]+)?):([A-Za-z_][A-Za-z0-9_.-]*)$/;
const PORT_REF = /^task\.port\(\s*(\d{1,2})\s*,\s*(\d{1,5})\s*\)$/;
const SIMPLE = new Set(['task.slot', 'task.suffix', 'task.id', 'worktree.path', 'project.root']);

function parseReference(body: string): EnvReference | string {
  const text = body.trim();
  const port = PORT_REF.exec(text);
  if (port) {
    const offset = Number(port[1]);
    const fallback = Number(port[2]);
    if (fallback < 1 || fallback > 65535) return `task.port's default must be a port (1–65535), not ${fallback}`;
    return { kind: 'task.port', offset, fallback };
  }
  if (text.startsWith('task.port')) return 'write task.port(k, default) — k from 0 to 99, default the port used outside a task';
  if (SIMPLE.has(text)) return { kind: text as 'task.slot' };
  const file = PATH_REF.exec(text);
  if (file) return { kind: 'file', path: file[1] as string, key: file[2] as string };
  if (ENV_KEY_PATTERN.test(text) && !text.includes('.')) return { kind: 'var', key: text };
  return `unknown reference ${JSON.stringify(text)} — available: task.port(k, default), task.slot, task.suffix, task.id, worktree.path, project.root, VAR, path/to/.env:VAR`;
}

/** A directive's source as literal text and references. `\${{` is a literal `${{`. */
export function parseSource(source: string): { pieces: Piece[] } | { error: string } {
  const pieces: Piece[] = [];
  let literal = '';
  for (let i = 0; i < source.length;) {
    if (source.startsWith('\\${{', i)) { literal += '${{'; i += 4; continue; }
    if (source.startsWith('${{', i)) {
      const end = source.indexOf('}}', i + 3);
      if (end < 0) return { error: `close the reference at position ${i + 1} with }}` };
      const ref = parseReference(source.slice(i + 3, end));
      if (typeof ref === 'string') return { error: ref };
      if (literal) pieces.push(literal);
      literal = '';
      pieces.push(ref);
      i = end + 2;
      continue;
    }
    literal += source[i];
    i += 1;
  }
  if (literal) pieces.push(literal);
  return { pieces };
}

export interface Directive { key: string; source: string; pieces: Piece[]; line: number }

/** The `#cezar` directives of a file, in order. A malformed one is an error with its line. */
export function readDirectives(path: string, text: string): Directive[] {
  const directives: Directive[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.startsWith('#cezar')) return;
    const match = DIRECTIVE.exec(raw.trimEnd());
    if (!match) throw new EnvReferenceError('a directive is "#cezar KEY=value with ${{ references }}"', path, index + 1);
    const [, key, source] = match as unknown as [string, string, string];
    if (seen.has(key)) throw new EnvReferenceError(`${key} has two #cezar directives`, path, index + 1);
    seen.add(key);
    const parsed = parseSource(source);
    if ('error' in parsed) throw new EnvReferenceError(parsed.error, path, index + 1);
    directives.push({ key, source, pieces: parsed.pieces, line: index + 1 });
  });
  return directives;
}

export const hasDirectives = (text: string): boolean => /^#cezar\s/m.test(text);

/**
 * Bring the main checkout's directives into a task's copy of the file, for "Re-render in this
 * task" (spec §4). Only directive lines move — each lands right above its key's assignment, or
 * at the end for the render to fill — so every value the task changed by hand stays.
 */
export function adoptDirectives(path: string, mainText: string, taskText: string): string {
  let lines = parseEnv(taskText);
  for (const directive of readDirectives(path, mainText)) {
    const raw = `${DIRECTIVE_PREFIX}${directive.key}=${directive.source}`;
    const own = lines.findIndex((line) => line.kind === 'other' && DIRECTIVE.exec(line.raw.trimEnd())?.[1] === directive.key);
    if (own >= 0) lines = lines.filter((_, index) => index !== own);
    const at = lines.findIndex((line) => line.kind === 'var' && line.key === directive.key);
    const directiveLine: EnvLine = { kind: 'other', raw };
    // A key the task lacks gets its assignment from the render that follows (renderLines).
    lines = at >= 0 ? [...lines.slice(0, at), directiveLine, ...lines.slice(at)] : [...lines, directiveLine];
  }
  return serializeEnv(lines);
}

function simpleValue(ref: EnvReference, context: EnvRenderContext): string {
  const inTask = context.slot !== undefined;
  switch (ref.kind) {
    case 'task.port': return String(inTask ? PORT_BLOCK_START + context.slot! * PORT_BLOCK_SIZE + ref.offset : ref.fallback);
    case 'task.slot': return inTask ? String(context.slot) : '';
    case 'task.suffix': return inTask ? `_${context.slot}` : '';
    case 'task.id': return inTask ? (context.runId ?? '') : '';
    case 'worktree.path': return context.worktreePath;
    case 'project.root': return context.projectRoot;
    default: throw new Error(`not a simple reference: ${ref.kind}`);
  }
}

/**
 * Render every file of a checkout. `files` maps a repo-relative env file path to its text in THIS
 * checkout; a `path:VAR` reference may name any of them. Returns the new text of each file whose
 * directives changed something. Throws `EnvReferenceError` on an unknown variable or a cycle.
 */
export function renderEnvFiles(files: ReadonlyMap<string, string>, context: EnvRenderContext): Map<string, string> {
  const parsed = new Map<string, { lines: EnvLine[]; directives: Map<string, Directive>; plain: Map<string, string> }>();
  for (const [path, text] of files) {
    const lines = parseEnv(text);
    const plain = new Map<string, string>();
    for (const line of lines) if (line.kind === 'var') plain.set(line.key, line.value);
    parsed.set(path, { lines, directives: new Map(readDirectives(path, text).map((d) => [d.key, d])), plain });
  }

  const values = new Map<string, string>();
  const visiting: string[] = [];
  const valueOf = (path: string, key: string): string => {
    const id = `${path}:${key}`;
    const known = values.get(id);
    if (known !== undefined) return known;
    if (visiting.includes(id)) throw new EnvReferenceError(`a reference cycle: ${[...visiting.slice(visiting.indexOf(id)), id].join(' → ')}`, path);
    const file = parsed.get(path);
    if (!file) throw new EnvReferenceError(`no env file ${path} in this project`, visiting.at(-1)?.split(':')[0] ?? path);
    const directive = file.directives.get(key);
    let value: string;
    if (!directive) {
      const plainValue = file.plain.get(key);
      if (plainValue === undefined) throw new EnvReferenceError(`${key} is not set in ${path}`, visiting.at(-1)?.split(':')[0] ?? path);
      value = plainValue;
    } else {
      visiting.push(id);
      value = directive.pieces.map((piece) => {
        if (typeof piece === 'string') return piece;
        if (piece.kind === 'var') return valueOf(path, piece.key);
        if (piece.kind === 'file') return valueOf(piece.path, piece.key);
        return simpleValue(piece, context);
      }).join('');
      visiting.pop();
      if (value.includes('\n')) throw new EnvReferenceError(`${key} renders to more than one line`, path, directive.line);
    }
    values.set(id, value);
    return value;
  };

  const changed = new Map<string, string>();
  for (const [path, file] of parsed) {
    if (file.directives.size === 0) continue;
    const next = renderLines(path, file.lines, (key) => valueOf(path, key));
    const text = serializeEnv(next);
    if (text !== files.get(path)) changed.set(path, text);
  }
  return changed;
}

/**
 * Replace the assignment under each directive. A directive with no assignment of its key right
 * below gets one inserted there, unless the key is assigned elsewhere in the file — then it is
 * an error, because which line the directive owns would be a guess.
 */
function renderLines(path: string, lines: EnvLine[], valueOf: (key: string) => string): EnvLine[] {
  const out: EnvLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    out.push(line);
    if (line.kind !== 'other') continue;
    const match = DIRECTIVE.exec(line.raw.trimEnd());
    if (!match) continue;
    const key = match[1] as string;
    const value = valueOf(key);
    const next = lines[i + 1];
    if (next?.kind === 'var' && next.key === key) {
      const prefix = /^\s*export\s+/.exec(next.raw)?.[0] ?? '';
      out.push({ kind: 'var', key, value, raw: `${prefix}${formatAssignment(key, value)}` });
      i += 1;
      continue;
    }
    if (lines.some((other) => other.kind === 'var' && other.key === key)) {
      throw new EnvReferenceError(`the #cezar directive for ${key} must sit right above its ${key}= line`, path);
    }
    out.push({ kind: 'var', key, value, raw: formatAssignment(key, value) });
  }
  return out;
}
