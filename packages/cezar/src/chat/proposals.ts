import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chatLivePath, chatMayWrite, chatProposalPath, type ChatProposal } from '@open-mercato/cezar-contract';
import { commitIndex, ignoredPaths, repoIndex, stagePaths, unstagePaths, type GitOk } from '../server/repo-git.ts';

/**
 * A chat's proposals (spec 2026-10-24-cockpit-chat §3): everything a chat writes lands in
 * `.ai/cezar/proposals/<chatId>/`, mirroring `.ai/cezar/`. No loader reads it — workflows, the
 * automations store, personas and `mcp.json` all read their own live paths — so nothing a chat
 * writes runs until the owner applies it. Apply copies into place and commits the repo files.
 */

const AUTOMATIONS = '.ai/cezar/automations.json';
const DIFF_CELLS = 4_000_000;
const DIFF_CAP = 200_000;

export function proposalRootDir(dataDir: string, chatId: string): string {
  return join(dataDir, 'proposals', chatId);
}

/** Absolute path of a live repo-relative path's proposal. */
function proposalFile(dataDir: string, chatId: string, livePath: string): string {
  const mirrored = chatProposalPath(chatId, livePath);
  if (!mirrored) throw new Error(`${livePath} is not cezar configuration a chat may propose`);
  return join(dataDir, 'proposals', chatId, ...mirrored.split('/').slice(4));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Every live path a chat has a proposal for, sorted. */
export function proposalPaths(dataDir: string, chatId: string): string[] {
  const root = proposalRootDir(dataDir, chatId);
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), next);
      else if (entry.isFile()) {
        const live = chatLivePath(chatId, `.ai/cezar/proposals/${chatId}/${next}`);
        if (live) found.push(live);
      }
    }
  };
  walk(root, '');
  return found.sort();
}

export function readProposal(dataDir: string, chatId: string, livePath: string): string | undefined {
  return readText(proposalFile(dataDir, chatId, livePath));
}

export function writeProposal(dataDir: string, chatId: string, livePath: string, content: string): string {
  const path = proposalFile(dataDir, chatId, livePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Remove proposals (all of the chat's when `livePaths` is absent); answers what was removed. */
export function discardProposals(dataDir: string, chatId: string, livePaths?: readonly string[]): string[] {
  const existing = proposalPaths(dataDir, chatId);
  const chosen = livePaths ? existing.filter((path) => livePaths.includes(path)) : existing;
  for (const live of chosen) {
    const file = proposalFile(dataDir, chatId, live);
    rmSync(file, { force: true });
    pruneEmpty(dirname(file), proposalRootDir(dataDir, chatId));
  }
  if (proposalPaths(dataDir, chatId).length === 0) rmSync(proposalRootDir(dataDir, chatId), { recursive: true, force: true });
  return chosen;
}

function pruneEmpty(dir: string, stop: string): void {
  let current = dir;
  while (current.startsWith(stop) && current !== stop) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

type AutomationsFile = { automations?: unknown[]; [key: string]: unknown };

function parseAutomations(text: string | undefined): AutomationsFile | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AutomationsFile) : undefined;
  } catch {
    return undefined;
  }
}

type Row = { id?: unknown; enabled?: unknown; [key: string]: unknown };
const rowsOf = (file: AutomationsFile | undefined): Row[] =>
  (Array.isArray(file?.automations) ? file.automations : []).filter((row): row is Row => Boolean(row) && typeof row === 'object');
const withoutEnabled = ({ enabled: _enabled, ...rest }: Row) => JSON.stringify(rest);

/**
 * `automations.json` as it would be applied: a proposal never arms anything. An automation keeps
 * `enabled: true` only when the live file has it enabled with the same definition; anything new or
 * changed is applied paused, and the owner switches it on.
 */
export function disarmAutomations(proposed: string, live: string | undefined): string {
  const file = parseAutomations(proposed);
  if (!file) return proposed;
  const liveRows = new Map(rowsOf(parseAutomations(live)).map((row) => [row.id, row] as const));
  const automations = rowsOf(file).map((row) => {
    if (row.enabled !== true) return row;
    const current = liveRows.get(row.id);
    const unchanged = current?.enabled === true && withoutEnabled(current) === withoutEnabled(row);
    return unchanged ? row : { ...row, enabled: false };
  });
  return `${JSON.stringify({ ...file, automations }, null, 2)}\n`;
}

/** Upsert one automation into the chat's proposed `automations.json` (based on the live file). */
export function proposeAutomation(dataDir: string, chatId: string, definition: Row & { id: string }): void {
  const live = readText(join(dataDir, 'automations.json'));
  const base = parseAutomations(readProposal(dataDir, chatId, AUTOMATIONS)) ?? parseAutomations(live) ?? { version: 1, automations: [] };
  const rows = rowsOf(base).filter((row) => row.id !== definition.id);
  writeProposal(dataDir, chatId, AUTOMATIONS, `${JSON.stringify({ ...base, automations: [...rows, { ...definition, enabled: false }] }, null, 2)}\n`);
}

/** One automation as the chat sees it: its own proposal of it when it has one, else the live one. */
export function proposedAutomation(dataDir: string, chatId: string, id: string): Row | undefined {
  return rowsOf(parseAutomations(readProposal(dataDir, chatId, AUTOMATIONS))).find((row) => row.id === id);
}

/** The content a proposal would put in place (`automations.json` disarmed). */
function appliedContent(root: string, livePath: string, proposed: string): string {
  return livePath === AUTOMATIONS ? disarmAutomations(proposed, readText(join(root, livePath))) : proposed;
}

/** The chat's proposals as its Changes panel shows them: each live path with its diff. */
export function listProposals(root: string, dataDir: string, chatId: string): ChatProposal[] {
  return proposalPaths(dataDir, chatId).map((path) => {
    const live = readText(join(root, path));
    const next = appliedContent(root, path, readProposal(dataDir, chatId, path) ?? '');
    const status = live === undefined ? 'added' : live === next ? 'unchanged' : 'modified';
    return { path, status, diff: unifiedDiff(path, live, next) };
  });
}

/**
 * Apply a chat's proposals on the checkout: copy them into place, stage the repo files among them
 * (an ignored file such as `automations.json` is local state and only goes live), commit, and drop
 * what was applied. Refused while anything else is staged, so the commit carries nothing of the
 * owner's own; a failed commit puts the live files back.
 */
export async function applyProposals(
  root: string,
  dataDir: string,
  chatId: string,
  input: { paths?: readonly string[]; message?: string },
): Promise<GitOk<{ applied: string[]; sha?: string }>> {
  const all = proposalPaths(dataDir, chatId);
  const unknown = (input.paths ?? []).filter((path) => !all.includes(path));
  if (unknown.length) return { ok: false, error: `no proposal for ${unknown.join(', ')}` };
  const chosen = input.paths ? all.filter((path) => input.paths!.includes(path)) : all;
  if (chosen.length === 0) return { ok: false, error: 'this chat proposes nothing' };
  if (!chosen.every(chatMayWrite)) return { ok: false, error: 'a proposal outside the cezar configuration' };
  const index = await repoIndex(root);
  if (!index.ok) return index;
  if (index.index.staged.length) return { ok: false, error: 'other files are staged in the checkout — commit or unstage them first' };

  const previous = new Map<string, string | undefined>();
  const changed: string[] = [];
  for (const path of chosen) {
    const before = readText(join(root, path));
    const next = appliedContent(root, path, readProposal(dataDir, chatId, path) ?? '');
    previous.set(path, before);
    if (before === next) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), next, 'utf8');
    changed.push(path);
  }
  const restore = () => {
    for (const path of changed) {
      const before = previous.get(path);
      if (before === undefined) rmSync(join(root, path), { force: true });
      else writeFileSync(join(root, path), before, 'utf8');
    }
  };

  const ignored = await ignoredPaths(root, changed);
  const committable = changed.filter((path) => !ignored.has(path));
  let sha: string | undefined;
  if (committable.length) {
    const staged = await stagePaths(root, { paths: committable });
    const committed = staged.ok
      ? await commitIndex(root, { message: input.message?.trim() || proposalCommitMessage(committable) })
      : staged;
    if (!committed.ok) {
      await unstagePaths(root, { paths: committable });
      restore();
      return committed;
    }
    sha = 'sha' in committed ? committed.sha : undefined;
  }
  discardProposals(dataDir, chatId, chosen);
  return { ok: true, applied: chosen, ...(sha ? { sha } : {}) };
}

export function proposalCommitMessage(paths: readonly string[]): string {
  const names = paths.map((path) => path.replace(/^\.ai\/cezar\//, ''));
  const shown = names.slice(0, 3).join(', ');
  return `cezar: update ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
}

/** A unified diff of two texts (3 lines of context), small enough for config files. */
export function unifiedDiff(path: string, before: string | undefined, after: string): string {
  const a = before === undefined ? [] : splitLines(before);
  const b = splitLines(after);
  const header = `--- ${before === undefined ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n`;
  if (a.length * b.length > DIFF_CELLS) return `${header}@@ too large to diff here @@\n`;
  const ops = diffOps(a, b);
  const context = 3;
  const hunks: Array<[number, number]> = [];
  ops.forEach((op, index) => {
    if (op.op === ' ') return;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length, index + 1 + context);
    const last = hunks.at(-1);
    if (last && from <= last[1]) last[1] = to;
    else hunks.push([from, to]);
  });
  const out: string[] = [];
  for (const [from, to] of hunks) {
    const prior = ops.slice(0, from);
    const slice = ops.slice(from, to);
    const aStart = prior.filter((op) => op.op !== '+').length;
    const bStart = prior.filter((op) => op.op !== '-').length;
    const aLen = slice.filter((op) => op.op !== '+').length;
    const bLen = slice.filter((op) => op.op !== '-').length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const op of slice) out.push(`${op.op}${op.line}`);
  }
  const text = `${header}${out.join('\n')}${out.length ? '\n' : ''}`;
  return text.length > DIFF_CAP ? `${text.slice(0, DIFF_CAP)}\n… (diff truncated)\n` : text;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Array<{ op: ' ' | '-' | '+'; line: string }> {
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ op: '-', line: a[i]! });
      i += 1;
    } else {
      ops.push({ op: '+', line: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ op: '-', line: a[i++]! });
  while (j < m) ops.push({ op: '+', line: b[j++]! });
  return ops;
}

