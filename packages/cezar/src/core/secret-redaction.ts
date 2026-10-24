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

/** A multi-line value matches with LF or CRLF between its lines, however it was stored (a tty writes CRLF). */
function multiLinePattern(value: string): RegExp | null {
  if (!value.includes('\n')) return null;
  return new RegExp(value.split(/\r?\n/).map(escapeRegExp).join('\\r?\\n'), 'g');
}

/** Replace every known secret value / token shape in `text` with `[REDACTED]`. */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const value of secretValues) {
    const lines = multiLinePattern(value);
    if (lines) {
      out = out.replace(lines, REDACTED);
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
    const lines = multiLinePattern(value);
    if (lines) for (const match of text.matchAll(lines)) spans.push([match.index, match.index + match[0].length]);
    else for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) spans.push([at, at + value.length]);
  }
  for (const re of TOKEN_PATTERNS) for (const match of text.matchAll(re)) spans.push([match.index, match.index + match[0].length]);
  return spans;
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
