import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TERMINAL_HISTORY_CAP } from '@open-mercato/cezar-contract';
import { z } from 'zod';

import { SECRET_NAME_RE, redactSecrets } from '../../core/secret-redaction.ts';
import { atomicWriteJson } from '../../workspace/config.ts';
import { FRESH_SNAPSHOT_TIMEOUT_MS } from './foreground.ts';

/** The Code terminal's per-project history, read off the input routes' keystrokes: what is kept,
 *  when, and how it is redacted is spec 2026-10-24-code-page-terminal §9. */

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

/** What one chunk of keystrokes did to the line, in order: a line got its first word, one was
 *  submitted (`text` null when only the shell knows what it said), or a Ctrl+C/Ctrl+Z — which
 *  may end a program — abandoned it. */
export type LineEvent = { kind: 'begin' } | { kind: 'submit'; text: string | null } | { kind: 'abandon' };

/** One session's line as it is being typed. */
export class TypedLine {
  private text = '';
  private known = true;
  private begun = false;

  /** Feed keystrokes; returns every line SUBMITTED in them whose text is certain. */
  feed(data: string): string[] {
    return this.events(data).flatMap((event) => (event.kind === 'submit' && event.text !== null && event.text !== '' ? [event.text] : []));
  }

  events(data: string): LineEvent[] {
    const out: LineEvent[] = [];
    const input = data.replace(PASTE_MARKERS, '');
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index]!;
      if (char === '\r' || char === '\n') {
        out.push({ kind: 'submit', text: this.known ? this.text : null });
        this.reset();
      } else if (char === '\x7f' || char === '\b') {
        this.text = [...this.text].slice(0, -1).join('');
      } else if (char === '\x03' || char === '\x15' || char === '\x1a') {
        // Ctrl+C abandons the line (or a program), Ctrl+U kills it, Ctrl+Z suspends a program:
        // what follows is a new line, owed a prompt check of its own.
        if (char !== '\x15') out.push({ kind: 'abandon' });
        this.reset();
      } else if (char === '\x1b') {
        this.known = false;
        index = skipEscape(input, index);
      } else if (char < ' ') {
        // Tab, Ctrl+W, Ctrl+R…: the shell edits the line in ways only it knows.
        this.known = false;
      } else if (this.known) {
        // A line begins with its first word: a bare Enter, a Ctrl+C or a space-led line (never
        // kept) is owed no prompt check, so it spawns no `ps`.
        if (!this.begun && char !== ' ' && !this.text.startsWith(' ')) {
          this.begun = true;
          out.push({ kind: 'begin' });
        }
        this.text += char;
        if (this.text.length > MAX_LINE) this.known = false;
      }
    }
    return out;
  }

  private reset(): void {
    this.text = '';
    this.known = true;
    this.begun = false;
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
export function historyLine(raw: string, secrets: readonly string[] = []): string | null {
  if (raw.startsWith(' ')) return null;
  const line = raw.trim();
  return line === '' ? null : redactHistoryLine(line, secrets);
}

/** `line` with every credential it may carry masked (spec 2026-10-24-code-page-terminal §9): shapes as `***`,
 *  `secrets` (host env, live runs, stored secrets) and token shapes as `[REDACTED]`. Idempotent. */
export function redactHistoryLine(line: string, secrets: readonly string[] = []): string {
  if (loneBlob(line)) return '***';
  // URL userinfo first: `https://x-access-token:…@` is no header.
  // A query parameter before assignments: `'…&key=x'` is no shell assignment, and its quote stays.
  let out = redactAssignments(line.replace(QUERY_PARAM, (whole, lead: string, name: string) => (secretName(name) ? `${lead}${name}=***` : whole)))
    .replace(URL_USERINFO, (whole, scheme: string, info: string) =>
      /^https?:\/\/$/i.test(scheme) || info.includes(':') ? `${scheme}***@` : whole)
    .replace(FROM_LITERAL, (whole, lead: string, flag: string, key: string) =>
      (secretName(key) || /key/i.test(key) ? `${lead}${flag}${key}=***` : whole))
    .replace(SECRET_FLAG_EQ, (whole, lead: string, flag: string) => (secretFlag(flag) ? `${lead}${flag}=***` : whole))
    .replace(SECRET_FLAG_SPACED, '$1$2$3***')
    .replace(USER_PASSWORD_FLAG, '$1$2$3$4:***')
    .replace(GLUED_USER_PASSWORD, '$1-u$2:***')
    .replace(SECRET_HEADER, '$1$2$3***');
  out = out.split(SEPARATOR).map(redactClientPassword).join('');
  if (STDIN_SECRET_FLAG.test(out) || SUDO_STDIN.test(out)) {
    out = out.replace(HERE_STRING, '<<< ***').replace(ECHOED, '$1$2$3 ***');
  }
  return redactSecrets(out, secrets);
}

/** A line that is one 32+ character hex or base64 word — a token pasted at the prompt, no command.
 *  Base64 must mix digits and both cases, so a long hyphenated script name is not one. */
function loneBlob(line: string): boolean {
  const word = line.trim();
  if (word.length < 32 || /\s/.test(word)) return false;
  if (/^[0-9a-f]+$/i.test(word)) return true;
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(word) && /\d/.test(word) && /[a-z]/.test(word) && /[A-Z]/.test(word);
}

/** A shell word: quoted (closed or not), or up to the next separator or quote. */
const WORD = String.raw`(?:"(?:[^"\\]|\\.)*"?|'[^']*'?|[^\s;&|)\`"']+)`;
const SECRET_FLAG_EQ = new RegExp(String.raw`(^|\s)(--?[A-Za-z][A-Za-z0-9_-]*)=${WORD}`, 'g');
const secretName = (raw: string): boolean => {
  const name = raw.replace(/[-.]/g, '_');
  return SECRET_NAME_RE.test(name) || SECRET_NAME_PART.test(name);
};
const secretFlag = (flag: string): boolean => secretName(flag.replace(/^-+/, ''));
/** `?access_token=…`, `&key=…`: a secret-named query parameter. */
const QUERY_PARAM = /([?&])([A-Za-z0-9_.-]+)=[^&\s#"']+/g;
/** `kubectl create secret --from-literal=password=…`: the key names the secret. */
const FROM_LITERAL = new RegExp(String.raw`(^|\s)(--from-literal(?:=|\s+))([A-Za-z0-9_.-]+)=${WORD}`, 'g');
/** `--password hunter2`: only names that end in the secret itself, and never a redirect or flag after them. */
const SECRET_FLAG_SPACED = new RegExp(String.raw`(^|\s)(--(?:[A-Za-z0-9]+-)*(?:password|passwd|token|secret|api-?key))(\s+)(?![-<>|&;])${WORD}`, 'gi');
const USER_PASSWORD_FLAG = /(^|\s)(-u|--user)(\s+|=)([^\s:"']+):[^\s"']+/g;
/** curl's glued `-uadmin:hunter2`. */
const GLUED_USER_PASSWORD = /(^|\s)-u([^\s:"'-][^\s:"']*):[^\s"']+/g;
const SECRET_HEADER = /\b((?:proxy-)?authorization|cookie|private-token|api-?key|x-[a-z0-9-]*(?:token|key|secret|auth)[a-z0-9-]*)(\s*:\s*)((?:bearer|basic|token|digest|bot)\s+)?[^\s"']+/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@"']*)@/gi;
/** A flag that reads the secret from stdin: what the line feeds it is the secret. */
const STDIN_SECRET_FLAG = /(^|\s)(?:--[A-Za-z0-9-]*(?:token|password|passwd|secret)[A-Za-z0-9-]*|--stdin)(?=\s|$)/i;
/** `sudo -S` (or `-kS`) reads the password from stdin. Case matters: `-s` is a shell. */
const SUDO_STDIN = /(^|[\s|;&(])sudo\s+(?:[^|;&]*\s)?-[A-Za-z]*S[A-Za-z]*(?=\s|$)/;
const HERE_STRING = new RegExp(String.raw`<<<\s*${WORD}`, 'g');
const ECHOED = new RegExp(String.raw`(^|[\s(])(echo|printf)((?:\s+-[A-Za-z]+)*)\s+${WORD}`, 'g');
/** Clients whose `-p` glues the password on (`mysql -phunter2`); `-p` alone makes them ask. */
const GLUED_PASSWORD = new Set(['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlshow', 'mysqlcheck', 'mariadb', 'mariadb-dump', 'sshpass']);
const GLUED_PASSWORD_FLAG = new RegExp(String.raw`(\s)-p(?=[^\s])${WORD}`, 'g');
/** `-p hunter2`, `-a hunter2`: a password for any command but those `NO_SHORT_SECRET` names. */
const SPACED_SHORT_SECRET = new RegExp(String.raw`(\s)(-[pa])(\s+)(?![-<>|&;])${WORD}`, 'g');
/** A port, a pid or a mapping (`5433`, `8080:80`, `53/udp`): what `-p` means far more often. */
const PORT_SHAPE = /^\d[\d.:-]*(?:\/(?:tcp|udp))?$/;
/** A glued value that reads as the rest of a single-dash flag: `-print`, `-parallel=4`, `-pthread`. */
const FLAG_TAIL = /^[a-z][a-z-]*(?:=.*)?$/;

/** Registry clients whose `login -p` takes the password; `-p` is a port or a publish elsewhere. */
const LOGIN_PASSWORD = new Set(['docker', 'podman', 'nerdctl', 'buildah', 'skopeo', 'helm', 'oras']);
/** Redis clients: `-a` is the password, `-p` the port. */
const REDIS_CLIENTS = new Set(['redis-cli', 'valkey-cli', 'keydb-cli']);
/** sshpass options that take a value; its first other word starts the command it runs. */
const SSHPASS_VALUE_FLAGS = new Set(['-p', '-f', '-d', '-P']);
/** Commands whose `-p`/`-a` is a parents, all, append, pid, port or prompt flag — never a password. */
const NO_SHORT_SECRET = new Set([
  'mkdir', 'cp', 'mv', 'ls', 'ln', 'install', 'rsync', 'tar', 'unzip', 'ps', 'kill', 'pkill', 'pgrep', 'lsof', 'ssh', 'nc',
  'grep', 'rg', 'git', 'tee', 'touch', 'df', 'du', 'sort', 'uname', 'read', 'xargs', 'node', 'npx', 'perl', 'patch', 'ping',
  'nmap', 'pytest', 'cargo', 'kubectl', 'docker-compose',
]);
/** Verbs whose first positional argument is the secret, or names it: `vault login s.abc`. */
const SECRET_VERBS: readonly (readonly string[])[] = [['vault', 'login'], ['vault', 'auth'], ['wrangler', 'secret', 'put']];
/** Wrappers that run their next word as the command. */
const COMMAND_PREFIX = new Set(['sudo', 'exec', 'npx', 'bunx']);
const SEPARATOR = /(\|\|?|&&?|;)/;
/** Flags whose quoted value is a command line: `rsync -e "sshpass -p … ssh"`, `bash -c '…'`. */
const SUBCOMMAND_FLAG = /^(?:-e|-c|--rsh=?|--command=?)$/;
/** Commands whose quoted arguments are a command line they run. */
const COMMAND_RUNNERS = new Set(['ssh', 'sh', 'bash', 'zsh', 'dash', 'eval']);

type Token = { text: string; start: number };

/** The segment's words but its assignments, and the index of its command among them. */
function commandTokens(segment: string): { tokens: Token[]; at: number } {
  const tokens = [...segment.matchAll(new RegExp(WORD, 'g'))]
    .map((match) => ({ text: match[0], start: match.index }))
    .filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text));
  let at = 0;
  while (COMMAND_PREFIX.has(tokens[at]?.text ?? '') && tokens[at + 1] && !tokens[at + 1]!.text.startsWith('-')) at += 1;
  return { tokens, at };
}

function redactClientPassword(segment: string): string {
  return redactCommandPassword(redactSubcommands(segment));
}

/** Every quoted command line the segment runs, with the client rules applied inside its quotes. */
function redactSubcommands(segment: string): string {
  const { tokens, at } = commandTokens(segment);
  const runner = COMMAND_RUNNERS.has(baseName(tokens[at]?.text ?? ''));
  let out = segment;
  for (let index = tokens.length - 1; index > at; index -= 1) {
    const { text, start } = tokens[index]!;
    const quote = text[0];
    if ((quote !== '"' && quote !== "'") || !(runner || SUBCOMMAND_FLAG.test(tokens[index - 1]!.text))) continue;
    const closed = text.length > 1 && text.endsWith(quote);
    const inner = text.slice(1, closed ? -1 : undefined).split(SEPARATOR).map(redactClientPassword).join('');
    out = `${out.slice(0, start)}${quote}${inner}${closed ? quote : ''}${out.slice(start + text.length)}`;
  }
  return out;
}

function redactCommandPassword(segment: string): string {
  const { tokens, at } = commandTokens(segment);
  if (!tokens[at]) return segment;
  const command = baseName(tokens[at]!.text);
  if (command === 'sshpass') {
    let index = at + 1;
    while (tokens[index]?.text.startsWith('-')) index += SSHPASS_VALUE_FLAGS.has(tokens[index]!.text) ? 2 : 1;
    const inner = tokens[index];
    if (inner) return redactClientPassword(segment.slice(0, inner.start)) + redactClientPassword(segment.slice(inner.start));
  }
  const words = tokens.map((token) => token.text);
  let out = segment;
  const verb = SECRET_VERBS.find((parts) => parts.every((part, index) => (index === 0 ? command : words[at + index]) === part));
  const positional = verb && tokens.slice(at + verb.length).find((token) => !token.text.startsWith('-'));
  if (positional) out = `${out.slice(0, positional.start)}***${out.slice(positional.start + positional.text.length)}`;
  const generic = LOGIN_PASSWORD.has(command) ? words.includes('login') : !NO_SHORT_SECRET.has(command);
  if (!generic) return out;
  // The client's own password flag is masked whatever its value looks like: `-p 123456` is no port there.
  const own = passwordFlag(command);
  out = out.replace(GLUED_PASSWORD_FLAG, (whole: string, lead: string) => {
    const value = whole.slice(lead.length + 2);
    if (value === '***') return whole;
    return own !== '-p' && (PORT_SHAPE.test(value) || FLAG_TAIL.test(value)) ? whole : `${lead}-p***`;
  });
  return out.replace(SPACED_SHORT_SECRET, (whole: string, lead: string, flag: string, gap: string) =>
    (flag !== own && PORT_SHAPE.test(whole.slice(lead.length + flag.length + gap.length)) ? whole : `${lead}${flag}${gap}***`));
}

/** The short flag that is `command`'s password, when it has one; a `login` verb was checked by the caller. */
function passwordFlag(command: string): '-p' | '-a' | null {
  if (GLUED_PASSWORD.has(command) || LOGIN_PASSWORD.has(command)) return '-p';
  return REDIS_CLIENTS.has(command) ? '-a' : null;
}

/** Short names the shared credential heuristic leaves out: `DB_PASS`, `KEY`, `SMTP_PWD`, sshpass's `SSHPASS`. */
const SECRET_NAME_PART = /(^|_)(PASS|PWD|KEY|PIN)(_|$)|^SSHPASS$/i;
/** `NAME=` wherever a name can start inside a word — after a separator, a quote, another `=`, a
 *  `/` or a `:` (`//reg/:_authToken=…`, `-d "password=…"`); its value is the shell word after it. */
const ASSIGNMENT = /(^|[\s;&|(`=/:"'])([A-Za-z_][A-Za-z0-9_]*)=/g;

/** Where the shell word starting at `start` ends: quotes, `$( … )`, `${ … }` and backticks
 *  (closed or not) are part of it, so `$(cat ~/t)` is one value, not `$(cat`. */
function shellWordEnd(text: string, start: number): number {
  const closers: string[] = [];
  let index = start;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') {
      index += 2;
    } else if (char === "'" || char === '`') {
      const close = text.indexOf(char, index + 1);
      index = close === -1 ? text.length : close + 1;
    } else if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      index += 1;
    } else if (char === '$' && (text[index + 1] === '(' || text[index + 1] === '{')) {
      closers.push(text[index + 1] === '(' ? ')' : '}');
      index += 2;
    } else if (closers.length > 0) {
      if (char === '(') closers.push(')');
      else if (char === closers[closers.length - 1]) closers.pop();
      index += 1;
    } else if (/[\s;&|)]/.test(char)) {
      break;
    } else {
      index += 1;
    }
  }
  return Math.min(index, text.length);
}

/** The quote open at `end` in `text`, and where it opened; null outside quotes. */
function openQuote(text: string, end: number): { char: string; at: number } | null {
  let open: { char: string; at: number } | null = null;
  for (let index = 0; index < end; index += 1) {
    const char = text[index]!;
    if (open?.char === "'") {
      if (char === "'") open = null;
    } else if (char === '\\') {
      index += 1;
    } else if (open) {
      if (char === '"') open = null;
    } else if (char === '"' || char === "'") {
      open = { char, at: index };
    }
  }
  return open;
}

/** Where a value inside an open quote ends: at its closing quote, or — when the assignment sits
 *  mid-argument (`-m "rotate API_KEY=old"`) — at the next space too; `&` always ends a form field. */
function quotedValueEnd(text: string, start: number, quote: string, wholeArgument: boolean): number {
  let index = start;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\' && quote === '"') index += 2;
    else if (char === quote || char === '&' || (!wholeArgument && /\s/.test(char))) break;
    else index += 1;
  }
  return Math.min(index, text.length);
}

/** `line` with the value of every secret-named assignment replaced by `***`; a quoted value
 *  keeps its closing quote. */
export function redactAssignments(line: string): string {
  const head = new RegExp(ASSIGNMENT.source, 'g');
  let out = '';
  let copied = 0;
  for (let match = head.exec(line); match !== null; match = head.exec(line)) {
    const name = match[2]!;
    const start = match.index + match[0].length;
    const nameStart = match.index + match[1]!.length;
    const quote = openQuote(line, nameStart);
    const end = quote === null ? shellWordEnd(line, start) : quotedValueEnd(line, start, quote.char, quote.at === nameStart - 1);
    const value = line.slice(start, end);
    // Already masked — `'…&key=***'` from a query, whose quote is the URL's, not this value's.
    if (value === '' || /^\*\*\*(?=$|["'])/.test(value) || !(SECRET_NAME_RE.test(name) || SECRET_NAME_PART.test(name))) continue;
    out += `${line.slice(copied, start)}***`;
    copied = end;
    head.lastIndex = end;
  }
  return out + line.slice(copied);
}

/** The stored lines, redacted again on the way out: a line kept before a rule existed is served under it. */
export async function readTerminalHistory(dataDir: string, secrets: readonly string[] = []): Promise<string[]> {
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
  const lines = fileSchema.parse(parsed).lines
    .filter((line): line is string => typeof line === 'string' && line.length <= MAX_LINE)
    .map((line) => redactHistoryLine(line, secrets));
  return foldHistory([], [...new Set(lines)].reverse());
}

/** A prompt check slower than this keeps nothing. Each `ps` is cut at 300 ms from its own start
 *  (`FRESH_SNAPSHOT_TIMEOUT_MS`); this caps the wait behind a running one as well (spec §9). */
export const PROMPT_CHECK_CAP_MS = 2 * FRESH_SNAPSHOT_TIMEOUT_MS;

/** The secret values a stored line is scrubbed of, read when the line is decided. */
export type HistorySecrets = () => Promise<readonly string[]>;
const noSecrets: HistorySecrets = async () => [];

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

/** Whether a shell with these children was at its prompt for `line`: none, or each the line's own
 *  command (either of its first two words, as `ps` shows `node /usr/bin/npm run dev`). */
export function atPromptFor(children: readonly string[], line: string): boolean {
  const own = new Set(lineCommands(line).map(baseName));
  return children.every((child) => child.trim().split(/\s+/).slice(0, 2).some((word) => own.has(baseName(word))));
}

/** Programs that read a secret from the terminal. The table sees them run — but a line begun in
 *  the instant before the shell forked one would not, so after one the next prompt must be
 *  confirmed by a check begun once it had time to start. */
const READS_SECRET = new Set(['ssh', 'sudo', 'su', 'doas', 'passwd', 'gpg', 'gpg2', 'ssh-add', 'ssh-keygen']);
/** How long after such a line a check may still be racing the shell's fork. */
export const SECRET_SETTLE_MS = 500;

/** What a submitted line does to the lines after it, as far as its text says. */
function lineEffects(line: string): { replacesShell: boolean; secretNextLine: boolean; readsSecret: boolean } {
  const effects = { replacesShell: false, secretNextLine: false, readsSecret: false };
  for (const segment of line.split(/\|\|?|&&?|;/)) {
    const words = segment.trim().split(/\s+/).filter((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const [first, ...rest] = words;
    if (!first) continue;
    // `exec ssh host` makes the shell's own pid the program: no child shows, ever again.
    // `exec 2>&1` only redirects.
    if (first === 'exec' && rest.some((word) => !/^(\d*[<>]|&)/.test(word))) effects.replacesShell = true;
    // A builtin: the shell itself reads the secret, so no process shows it.
    if (first === 'read' && rest.some((word) => /^-[A-Za-z]*s/.test(word))) effects.secretNextLine = true;
    if (READS_SECRET.has(baseName(first))) effects.readsSecret = true;
  }
  return effects;
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

interface PromptCheck {
  found: Promise<readonly string[] | null>;
  at: number;
}

interface SessionState {
  line: TypedLine;
  /** The prompt check of the line being typed, begun with its first keystroke; null for a line
   *  begun after another in the same chunk, which no prompt can have been shown for. */
  check: PromptCheck | null;
  /** Decisions, in submission order, so lines land in the file in the order they were typed. */
  decided: Promise<void>;
  /** `exec` replaced the shell: nothing typed here is a prompt line again. */
  replaced: boolean;
  /** The last line was `read -s`: the next one is what it read. */
  secretNext: boolean;
  /** Set when a line started a program that reads secrets, until a prompt is confirmed again. */
  guard: { since: number } | null;
}

/** Every project's history. Never awaited by a keystroke; writes are serialized per data
 *  directory, and a failed one (a read-only checkout) loses that line only (spec §9). */
export class TerminalHistory {
  private readonly sessions = new Map<string, SessionState>();
  private readonly writes = new Map<string, Promise<void>>();
  /** Lines still being decided, kept apart from `sessions`: a session that exits leaves them owed. */
  private readonly deciding = new Set<Promise<void>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Keystrokes as they are written to the shell: a line's check starts on its first word, and only
   *  a chunk's first line can have met a prompt (spec §9). */
  typed(dataDir: string, sessionId: string, data: string, children: ShellChildren, secrets: HistorySecrets = noSecrets): void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { line: new TypedLine(), check: null, decided: Promise.resolve(), replaced: false, secretNext: false, guard: null };
      this.sessions.set(sessionId, state);
    }
    // Once this chunk began a line, or ended one, no later line in it can have met a prompt:
    // `\rhunter2\r` finishing an earlier line reaches the shell with the Enter before it.
    let promptPassed = false;
    for (const event of state.line.events(data)) {
      if (event.kind === 'begin') {
        state.check = promptPassed || state.replaced ? null : { found: withTimeout(children(), PROMPT_CHECK_CAP_MS), at: this.now() };
        promptPassed = true;
        continue;
      }
      promptPassed = true;
      if (event.kind === 'abandon') {
        state.check = null;
        continue;
      }
      const check = state.check;
      state.check = null;
      const secret = state.secretNext;
      state.secretNext = false;
      const guard = state.guard;
      if (event.text !== null) {
        // Even a line not kept (led by a space) starts what it starts.
        const effects = lineEffects(event.text);
        if (effects.replacesShell) state.replaced = true;
        if (effects.secretNextLine) state.secretNext = true;
        if (effects.readsSecret) state.guard = { since: this.now() };
      }
      const entry = event.text === null ? null : historyLine(event.text);
      if (entry === null || check === null || secret) continue;
      const self = state;
      state.decided = state.decided.then(async () => {
        const found = await check.found;
        if (found === null || !atPromptFor(found, entry)) return;
        if (guard !== null) {
          // Begun too soon after a `sudo`: the table may not show it yet.
          if (check.at - guard.since < SECRET_SETTLE_MS) return;
          // Confirmed — unless this line, or a later one, started another such program.
          if (self.guard === guard) self.guard = null;
        }
        const values = await secrets().catch(() => [] as readonly string[]);
        this.append(dataDir, [redactHistoryLine(entry, values)], values);
      });
      const decided = state.decided;
      this.deciding.add(decided);
      void decided.catch(() => {}).finally(() => this.deciding.delete(decided));
    }
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Settles once every line typed so far is decided and written — a forgotten session's too. A
   *  test seam, and the server's shutdown. */
  async flushed(): Promise<void> {
    await Promise.allSettled([...this.deciding]);
    await Promise.all(this.writes.values());
  }

  private append(dataDir: string, added: string[], secrets: readonly string[]): void {
    const previous = this.writes.get(dataDir) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const current = await readTerminalHistory(dataDir, secrets);
        await atomicWriteJson(join(dataDir, 'terminal-history.json'), { lines: foldHistory(current, added) });
      })
      .catch(() => {});
    this.writes.set(dataDir, next);
    void next.finally(() => {
      if (this.writes.get(dataDir) === next) this.writes.delete(dataDir);
    });
  }
}
