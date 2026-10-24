import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

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

/**
 * What one finished tool call left on GitHub: whether it was a `git push` (the caller reads the
 * sha), and the comment ids a `gh … comment` or a POST to a comments endpoint printed. A command
 * that only READS comments posts nothing, so its output is never mined.
 */
export function toolTraces(item: { input?: unknown; output?: string; status?: string }): { pushed: boolean; comments: number[] } {
  if (item.status !== undefined && item.status !== 'completed') return { pushed: false, comments: [] };
  const command = commandOf(item.input);
  if (!command) return { pushed: false, comments: [] };
  const posts = GH_COMMENT_RE.test(command) || (GH_API_POST_COMMENT_RE.test(command) && POST_RE.test(command));
  return { pushed: PUSH_RE.test(command), comments: posts ? commentIdsIn(item.output ?? '') : [] };
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
  const hashes = [...new Set((add.bodies ?? []).filter((hash) => /^[0-9a-f]{64}$/.test(hash)))];
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

/** `HEAD` of a checkout, or undefined — never throws (a trace is best-effort). */
export function headShaOf(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd: dir, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => {
      const sha = String(stdout ?? '').trim();
      resolve(!error && /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : undefined);
    });
  });
}
