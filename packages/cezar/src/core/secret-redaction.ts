/**
 * Redact credentials before they are persisted to a run's NDJSON transcript
 * (#427). Tool-result output is written verbatim to disk and served back over
 * the API, so the moment an agent runs a command whose output contains a
 * secret (`printenv`, `cat ~/.aws/credentials`, …) that secret would land in
 * `.ai/cezar/` — violating the "No secrets in state files" invariant
 * (AGENTS.md / CODE_REVIEW.md).
 *
 * Two complementary strategies:
 *   1. Value-based — the concrete values of the host's own secret-named env
 *      vars (GITHUB_TOKEN, ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, …). If
 *      any of them appears in event text, it is scrubbed.
 *   2. Pattern-based — well-known token shapes (gh*, sk-*, AKIA*, AIza*,
 *      xox*-*) so secrets that never lived in cezar's own env are still caught.
 *
 * Zero-config: redaction is on by default; `CEZ_REDACT_SECRETS=0` opts out.
 */

export const REDACTED = '[REDACTED]';

/**
 * Names that look like a credential — the single source of truth for "is this
 * var a secret?", shared with `agent-env.ts` (#427 review). The two used to
 * carry near-identical but subtly different lists, so a var could be stripped
 * from the child env yet never collected for redaction (or vice versa). One
 * constant, one answer: what we refuse to forward is exactly what we scrub.
 */
export const SECRET_NAME_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|_KEY_|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|_AUTH$|_AUTH_|SESSION|COOKIE|PASSPHRASE)/i;

/** Names matched above whose value is NOT a secret (a socket path, a pid, a
 *  desktop-session id) — collecting them would scrub ordinary paths from the
 *  transcript for no benefit. */
const SECRET_VALUE_NAME_ALLOW: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SESSION_MANAGER',
  'SESSIONNAME',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_CLASS',
  'XDG_SESSION_DESKTOP',
]);

/**
 * Below this length a "secret" value is too common a word to redact safely.
 * Verified over-redaction at the old floor of 8 (#427 review): a dev box with
 * `POSTGRES_PASSWORD=postgres` turned `apt install postgresql-16` into
 * `apt install [REDACTED]ql-16` in the transcript. Real credentials (API keys,
 * PATs, AWS secrets) are 20+ chars, so 12 keeps the catch rate while putting
 * short dictionary words — the whole source of false positives — out of reach.
 * Pattern-based redaction below is unaffected: it matches token *shapes*, not
 * env values, and still catches short-but-real tokens.
 */
export const MIN_SECRET_LEN = 12;

/** Well-known credential shapes, independent of the host env. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / server / user / refresh
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  // A key never follows a letter or digit; `task-scheduling-…` ends in "sk-" and is a word.
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9-_]{20,}/g, // Anthropic
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9-_]{20,}/g, // OpenAI & compatible
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g, // AWS temporary access key id
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /ya29\.[0-9A-Za-z_-]+/g, // Google OAuth access token
  /xox[baprs]-[0-9A-Za-z-]{10,}/g, // Slack
  /glpat-[0-9A-Za-z_-]{20,}/g, // GitLab PAT
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collect the concrete secret values present in `env` (deduped, longest
 *  first so a value that contains another is replaced whole). */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LEN) continue;
    if (SECRET_VALUE_NAME_ALLOW.has(name.toUpperCase())) continue;
    if (SECRET_NAME_RE.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Shorter, a line of a key is too common to be its own (`AB==`); an armor line (`-----END …-----`) every key shares. */
const SECRET_LINE_MIN = 16;

interface MultiLine { whole: RegExp; lines: RegExp | null; body: string[] }
const multiLineCache = new Map<string, MultiLine>();

/**
 * A multi-line value matches with LF or CRLF between its lines, however it was stored (a tty writes
 * CRLF); each of its body lines matches on its own too, for a text that holds only part of it.
 */
function multiLine(value: string): MultiLine {
  let found = multiLineCache.get(value);
  if (found) return found;
  const all = value.split(/\r?\n/);
  const body = [...new Set(all.filter((line) => line.length >= SECRET_LINE_MIN && !/^-----.*-----$/.test(line)))]
    .sort((a, b) => b.length - a.length);
  found = {
    whole: new RegExp(all.map(escapeRegExp).join('\\r?\\n'), 'g'),
    lines: body.length > 0 ? new RegExp(`^(?:${body.map(escapeRegExp).join('|')})$`, 'gm') : null,
    body,
  };
  if (multiLineCache.size >= 32) multiLineCache.clear();
  multiLineCache.set(value, found);
  return found;
}

/**
 * Every `[start, end)` of `text` a multi-line `value` covers: the whole value, each body line of it
 * standing as a line, and the piece of one that `text` starts or ends inside (a `--tail` begun mid-key).
 */
function multiLineSpans(text: string, value: string): Array<[number, number]> {
  const { whole, lines, body } = multiLine(value);
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(whole)) spans.push([match.index, match.index + match[0].length]);
  if (!lines) return spans;
  for (const match of text.matchAll(lines)) spans.push([match.index, match.index + match[0].length]);
  const firstEnd = text.search(/[\r\n]/);
  const first = firstEnd === -1 ? text : text.slice(0, firstEnd);
  if (first.length >= SECRET_LINE_MIN && body.some((line) => line.endsWith(first))) spans.push([0, first.length]);
  const lastStart = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  const last = text.slice(lastStart);
  if (last.length >= SECRET_LINE_MIN && body.some((line) => line.startsWith(last))) spans.push([lastStart, text.length]);
  return spans;
}

/** `text` with each run of overlapping spans replaced by one `[REDACTED]`. */
function replaceSpans(text: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return text;
  let out = '';
  let at = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (start >= at) out += text.slice(at, start) + REDACTED;
    at = Math.max(at, end);
  }
  return out + text.slice(at);
}

/** Replace every known secret value / token shape in `text` with `[REDACTED]`. */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value.includes('\n')) {
      out = replaceSpans(out, multiLineSpans(out, value));
      continue;
    }
    if (!out.includes(value)) continue;
    out = out.split(value).join(REDACTED);
  }
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * `text.slice(from)`, redacted as part of the whole `text`: a secret starting before `from` is still
 * found, and what of it reaches past `from` goes out as `[REDACTED]`.
 */
export function redactSecretsFrom(text: string, secretValues: readonly string[], from: number): string {
  if (from <= 0) return redactSecrets(text, secretValues);
  const reach = Math.max(from, ...secretSpans(text, secretValues).filter(([start]) => start < from).map(([, end]) => end));
  return (reach > from ? REDACTED : '') + redactSecrets(text.slice(reach), secretValues);
}

/** Longer than any token shape needs before it can match at all (`AIza` + 35). */
const TOKEN_HOLD = 64;

/** How much of a stream's tail may still be the start of a secret value or token shape. */
export function redactionHold(secretValues: readonly string[]): number {
  return Math.max(TOKEN_HOLD, ...secretValues.map((value) => value.length));
}

/**
 * Where a stream redacted piece by piece may cut `text` without splitting a secret value or token
 * shape: at most `text.length - hold` (and `limit`), before any match reaching that point. The tail
 * is held back, since a secret starting there may still be arriving.
 */
export function redactionSafeCut(text: string, secretValues: readonly string[], limit = Infinity): number {
  let cut = Math.min(limit, text.length - redactionHold(secretValues));
  if (cut <= 0) return 0;
  // Latest first, so a span the moved cut now reaches is still seen; a token reaching it may still be growing.
  const spans = secretSpans(text, secretValues).sort((a, b) => b[0] - a[0]);
  for (const [start, end] of spans) if (start < cut && end >= cut) cut = start;
  return cut;
}

/** Every `[start, end)` of `text` a secret value or token shape covers, unsorted. */
function secretSpans(text: string, secretValues: readonly string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const value of secretValues) {
    if (value === '') continue;
    if (value.includes('\n')) spans.push(...multiLineSpans(text, value));
    else for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) spans.push([at, at + value.length]);
  }
  for (const re of TOKEN_PATTERNS) for (const match of text.matchAll(re)) spans.push([match.index, match.index + match[0].length]);
  return spans;
}

/** `cut`, moved back to the start of any multi-line secret value it would split — a complete one included. */
export function lineSafeCut(text: string, secretValues: readonly string[], cut: number): number {
  const multiLine = secretValues.filter((value) => value.includes('\n'));
  if (multiLine.length === 0) return cut;
  for (const [start, end] of secretSpans(text, multiLine).sort((a, b) => b[0] - a[0])) if (start < cut && end > cut) cut = start;
  return cut;
}

/**
 * Where `text`'s tail may still be the start of a multi-line secret value (a PEM) — a stream cut at
 * line ends must not cut past it; `text.length` when none. Single-line values never cross a line end.
 * Line ends are compared as LF, so a CRLF stream (and a read ending between CR and LF) is held too.
 */
export function heldSecretStart(text: string, secretValues: readonly string[]): number {
  let held = text.length;
  for (const value of secretValues) {
    if (!value.includes('\n')) continue;
    const plain = value.replace(/\r\n/g, '\n');
    // A CRLF tail is one char longer per line end than the value it may start.
    const reach = plain.length + plain.split('\n').length;
    for (let at = Math.max(0, text.length - reach); at < held; at++) {
      if (text.charCodeAt(at) !== plain.charCodeAt(0)) continue;
      let tail = text.slice(at).replace(/\r\n/g, '\n');
      if (tail.endsWith('\r')) tail = tail.slice(0, -1);
      if (tail.length < plain.length && plain.startsWith(tail)) {
        held = at;
        break;
      }
    }
  }
  return held;
}

/**
 * Deep-copy `value`, redacting every string leaf. Structure/keys are
 * preserved; only string values (and string keys are left untouched — keys are
 * event field names, never secrets) are scrubbed.
 */
export function redactDeep<T>(value: T, secretValues: readonly string[]): T {
  if (typeof value === 'string') {
    return redactSecrets(value, secretValues) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, secretValues)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, secretValues);
    }
    return out as T;
  }
  return value;
}
