import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * cezar's own traces on GitHub (spec 2026-10-23-github-events §6): the shas a run pushed and the
 * comment ids it posted. The automation poller drops a candidate whose source is one of them, so
 * a run that pushes a fix or answers a review never re-triggers itself — whichever GitHub account
 * the box uses. Kept on the run record, capped, newest last.
 */
export const PUSHED_SHAS_CAP = 50;
export const POSTED_COMMENTS_CAP = 100;
/** Bodies of comments cezar posted or was posting (`commentFingerprint`), kept a day: far longer
 *  than any poll or retry, short enough to never shadow a human who later writes the same words. */
export const POSTED_BODIES_CAP = 100;
export const POSTED_BODY_TTL_MS = 24 * 60 * 60_000;

export type PostedCommentBody = { hash: string; at: string };

/** The fields a run record carries for its traces. */
export interface RunTraceFields {
  pushedShas?: string[];
  postedComments?: number[];
  postedCommentBodies?: PostedCommentBody[];
}

const liveBody = (entry: PostedCommentBody, now: number) => now - Date.parse(entry.at) < POSTED_BODY_TTL_MS;

export interface GithubTraces {
  shas: ReadonlySet<string>;
  comments: ReadonlySet<number>;
  /** Fingerprints of comment bodies cezar posted or is posting (`commentFingerprint`): the id is
   *  known only once GitHub answers, and a failed call may never report it at all. */
  bodies?: ReadonlySet<string>;
}

/** A comment body's identity, robust to GitHub's whitespace normalisation and to the poller's own
 *  cap on what it keeps of a body. */
export function commentFingerprint(body: string): string {
  const normalized = body.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1_000);
  return createHash('sha256').update(normalized).digest('hex');
}

/** Whether `candidate` came from cezar's own push or comment — asked when the poll reads it AND
 *  again when it is decided, since a trace can land while a long poll is in flight. */
export function isOwnTrace(
  candidate: { event: string; headSha?: string; comment?: { id: number; body?: string } },
  traces: GithubTraces,
  includeOwnPushes = false,
): boolean {
  if (candidate.comment) {
    return traces.comments.has(candidate.comment.id)
      || (candidate.comment.body !== undefined && !!traces.bodies?.has(commentFingerprint(candidate.comment.body)));
  }
  const sha = candidate.headSha?.toLowerCase();
  if (!sha || !traces.shas.has(sha)) return false;
  if (candidate.event === 'pull_request.synchronize' || candidate.event === 'push') return true;
  return candidate.event === 'check_suite.completed' && !includeOwnPushes;
}

/** `#issuecomment-N` (conversation) and `#discussion_rN` (review) comment ids in `text`. */
export function commentIdsIn(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(/#(?:issuecomment-|discussion_r)(\d{1,20})\b/g)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/** The command a tool item ran, across backends' input shapes. */
function commandOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const command = (input as { command?: unknown; cmd?: unknown }).command ?? (input as { cmd?: unknown }).cmd;
    if (typeof command === 'string') return command;
    if (Array.isArray(command)) return command.filter((part) => typeof part === 'string').join(' ');
  }
  return '';
}

const PUSH_RE = /(?:^|[\s;&|(])git\s+(?:-[cC]\s+\S+\s+|--\S+\s+)*push\b/;
const GH_COMMENT_RE = /\bgh\s+(?:pr|issue)\s+comment\b/;
const GH_API_POST_COMMENT_RE = /\bgh\s+api\b[^\n]*\/comments\b/;
const POST_RE = /(?:-X|--method)[\s=]*POST\b|\s-[fF]\s+body=|--(?:raw-)?field[\s=]+body=/i;

/** A tool call that runs `git push` — recorded when it STARTS too, so the sha is a trace before
 *  GitHub can announce the push. */
export function isPushCommand(input: unknown): boolean {
  return PUSH_RE.test(commandOf(input));
}

const postsComment = (command: string) => GH_COMMENT_RE.test(command) || (GH_API_POST_COMMENT_RE.test(command) && POST_RE.test(command));

/**
 * What one tool call left on GitHub: whether it was a successful `git push` (the caller reads the
 * sha), and the comment ids a `gh … comment` or a POST to a comments endpoint printed — whatever
 * the call's status, since `gh pr comment … && git push` fails AFTER posting. A command that only
 * READS comments posts nothing, so its output is never mined.
 */
export function toolTraces(item: { input?: unknown; output?: string; status?: string }): { pushed: boolean; comments: number[] } {
  const command = commandOf(item.input);
  if (!command) return { pushed: false, comments: [] };
  const completed = item.status === undefined || item.status === 'completed';
  return { pushed: completed && PUSH_RE.test(command), comments: postsComment(command) ? commentIdsIn(item.output ?? '') : [] };
}

const BODY_FILE_MAX = 65_536;
const BACKSLASH = String.fromCharCode(92);

/** The heredoc whose `<<` operator is at `at`: its text and the offset past its delimiter line. */
function heredocAt(command: string, at: number): { body: string; end: number } | undefined {
  const head = /^<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n/.exec(command.slice(at));
  if (!head || command[at + 2] === '<') return undefined;
  const lines: string[] = [];
  let offset = at + head[0].length;
  while (offset <= command.length) {
    const next = command.indexOf('\n', offset);
    const line = command.slice(offset, next < 0 ? command.length : next);
    if (line.trim() === head[2]) return { body: lines.join('\n'), end: next < 0 ? command.length : next + 1 };
    lines.push(line);
    if (next < 0) break;
    offset = next + 1;
  }
  return undefined;
}

function firstHeredoc(command: string, from: number): string | undefined {
  for (let at = command.indexOf('<<', from); at >= 0; at = command.indexOf('<<', at + 2)) {
    const doc = heredocAt(command, at);
    if (doc) return doc.body;
  }
  return undefined;
}

/** One shell word from `start`, its quotes joined; a `$(cat <<'X' … X)` substitution reads as its heredoc. */
function wordAt(command: string, start: number): string | undefined {
  let i = start;
  let value = '';
  let any = false;
  while (i < command.length) {
    const ch = command[i]!;
    const substitution = command.startsWith('"$(cat <<', i) ? 1 : command.startsWith('$(cat <<', i) ? 0 : -1;
    if (substitution >= 0) {
      const doc = heredocAt(command, command.indexOf('<<', i));
      if (!doc) return undefined;
      value += doc.body;
      const close = command.indexOf(')', doc.end);
      i = close < 0 ? command.length : close + 1;
      if (substitution === 1 && command[i] === '"') i += 1;
      any = true;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      value += command.slice(i + 1, end);
      i = end + 1;
      any = true;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        // Inside double quotes a backslash escapes only these four characters.
        if (command[i] === BACKSLASH && ['"', '$', '`', BACKSLASH].includes(command[i + 1] ?? '')) i += 1;
        value += command[i] ?? '';
        i += 1;
      }
      i += 1;
      any = true;
      continue;
    }
    if (/[\s;&|<>()]/.test(ch)) break;
    if (ch === BACKSLASH) i += 1;
    value += command[i] ?? '';
    i += 1;
    any = true;
  }
  return any ? value : undefined;
}

function readBodyFile(path: string, cwd: string | undefined): string | undefined {
  if (!cwd || !path) return undefined;
  try {
    return readFileSync(resolve(cwd, path), 'utf8').slice(0, BODY_FILE_MAX);
  } catch {
    return undefined;
  }
}

/**
 * The body a comment-posting tool call is about to send, read off the command BEFORE it runs so
 * its fingerprint is a trace whatever the call's outcome (spec 2026-10-23-github-events §6).
 * Best-effort: `--body`/`-b`, `--body-file`/`-F` (a file, or `-` with a heredoc), and `gh api`'s
 * `-f`/`--raw-field`/`-F`/`--field body=…` (`@file` too). Anything else is `undefined`.
 */
export function postingCommentBody(input: unknown, cwd?: string): string | undefined {
  const command = commandOf(input);
  if (!command || !postsComment(command)) return undefined;
  const api = !GH_COMMENT_RE.test(command);
  const flags = /(?:^|\s)(--body-file|--body|-b|-F|-f|--field|--raw-field)(?:=|[ \t]+)/g;
  for (const match of command.matchAll(flags)) {
    const flag = match[1]!;
    const word = wordAt(command, match.index + match[0].length);
    if (word === undefined) continue;
    let body: string | undefined;
    if (!api) {
      if (flag === '--body' || flag === '-b') body = word;
      else if (flag === '--body-file' || flag === '-F') body = word === '-' ? firstHeredoc(command, match.index) : readBodyFile(word, cwd);
    } else if (word.startsWith('body=')) {
      const value = word.slice('body='.length);
      const typed = flag === '-F' || flag === '--field';
      if (typed && value === '@-') body = firstHeredoc(command, match.index);
      else body = typed && value.startsWith('@') ? readBodyFile(value.slice(1), cwd) : value;
    }
    if (body?.trim()) return body;
  }
  return undefined;
}

/** The record fields after adding `add`, deduplicated and capped; `undefined` when nothing changed.
 *  `bodies` are fingerprints; adding one refreshes it and drops the expired ones. */
export function mergeTraces(
  run: RunTraceFields,
  add: { shas?: readonly string[]; comments?: readonly number[]; bodies?: readonly string[] },
  now = Date.now(),
): RunTraceFields | undefined {
  const patch: RunTraceFields = {};
  const shas = (add.shas ?? []).map((sha) => sha.trim().toLowerCase()).filter((sha) => /^[0-9a-f]{40,64}$/.test(sha));
  const current = run.pushedShas ?? [];
  const freshShas = shas.filter((sha, index) => !current.includes(sha) && shas.indexOf(sha) === index);
  if (freshShas.length) patch.pushedShas = [...current, ...freshShas].slice(-PUSHED_SHAS_CAP);
  const ids = (add.comments ?? []).filter((id) => Number.isSafeInteger(id) && id > 0);
  const posted = run.postedComments ?? [];
  const freshIds = ids.filter((id, index) => !posted.includes(id) && ids.indexOf(id) === index);
  if (freshIds.length) patch.postedComments = [...posted, ...freshIds].slice(-POSTED_COMMENTS_CAP);
  const live = new Set((run.postedCommentBodies ?? []).filter((entry) => liveBody(entry, now)).map((entry) => entry.hash));
  // A body still kept is not written again: every update of a tool item re-reads the same command.
  const hashes = [...new Set((add.bodies ?? []).filter((hash) => /^[0-9a-f]{64}$/.test(hash) && !live.has(hash)))];
  if (hashes.length) {
    const at = new Date(now).toISOString();
    const kept = (run.postedCommentBodies ?? []).filter((entry) => liveBody(entry, now) && !hashes.includes(entry.hash));
    patch.postedCommentBodies = [...kept, ...hashes.map((hash) => ({ hash, at }))].slice(-POSTED_BODIES_CAP);
  }
  return patch.pushedShas || patch.postedComments || patch.postedCommentBodies ? patch : undefined;
}

/** Every trace across a project's runs — what one poll compares candidates against. */
export function githubTracesOf(runs: Iterable<RunTraceFields>, now = Date.now()): GithubTraces {
  const shas = new Set<string>();
  const comments = new Set<number>();
  const bodies = new Set<string>();
  for (const run of runs) {
    for (const sha of run.pushedShas ?? []) shas.add(sha);
    for (const id of run.postedComments ?? []) comments.add(id);
    for (const entry of run.postedCommentBodies ?? []) if (liveBody(entry, now)) bodies.add(entry.hash);
  }
  return bodies.size ? { shas, comments, bodies } : { shas, comments };
}

/**
 * What a `git push` output says it updated: the new sha of each `old..new` line and the source
 * ref of each `[new branch]`. Tags, rejections and up-to-date refs move no branch head.
 */
export function pushedRefsIn(output: string): { refs: string[]; upToDate: boolean } {
  const refs: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const range = /^\s*\+?\s*[0-9a-f]{7,64}\.{2,3}([0-9a-f]{7,64})\s+\S+\s+->\s+\S+/.exec(line);
    if (range) refs.push(range[1]!);
    const created = /^\s*\*\s+\[new branch\]\s+(\S+)\s+->\s+\S+/.exec(line);
    if (created) refs.push(created[1]!);
  }
  return { refs: [...new Set(refs)], upToDate: /Everything up-to-date/.test(output) };
}

/**
 * A finished `git push` tool call: the shas it really pushed — read off its output, else `HEAD`
 * as the call left it — and the start-time `HEAD` recorded as `provisional`, to drop when it is
 * not one of them (the push failed, pushed nothing, or a `git commit` ran before it).
 */
export async function settlePush(input: {
  provisional?: string;
  item: { status?: string; output?: string };
  resolve: (refs: readonly string[]) => Promise<string[]>;
  head: () => Promise<string | undefined>;
}): Promise<{ add: string[]; drop?: string }> {
  const completed = input.item.status === undefined || input.item.status === 'completed';
  const { refs, upToDate } = pushedRefsIn(input.item.output ?? '');
  let add: string[] = [];
  if (refs.length) add = await input.resolve(refs);
  else if (completed && !upToDate) {
    const sha = await input.head();
    if (sha) add = [sha];
  }
  add = [...new Set(add.map((sha) => sha.toLowerCase()).filter((sha) => /^[0-9a-f]{40,64}$/.test(sha)))];
  const provisional = input.provisional?.toLowerCase();
  return provisional && !add.includes(provisional) ? { add, drop: provisional } : { add };
}

/** Each ref's commit sha in `dir`, skipping what does not resolve — never throws. */
export async function resolveCommits(dir: string, refs: readonly string[]): Promise<string[]> {
  const shas = await Promise.all(refs.slice(0, 10).map((ref) => new Promise<string | undefined>((resolveSha) => {
    execFile('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => {
      const sha = String(stdout ?? '').trim();
      resolveSha(!error && /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : undefined);
    });
  })));
  return shas.filter((sha): sha is string => !!sha);
}

/** `HEAD` of a checkout, or undefined — never throws (a trace is best-effort). */
export function headShaOf(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd: dir, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => {
      const sha = String(stdout ?? '').trim();
      resolve(!error && /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : undefined);
    });
  });
}
