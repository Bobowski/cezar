/**
 * A `.env` file as lines the Environment editor can change one variable at a time
 * (spec 2026-10-12-project-env-files). The text stays the source of truth: a line nobody edits is
 * written back byte for byte, comments, blanks, `export ` and quoting included.
 */

export type EnvLine =
  | { kind: 'var'; key: string; value: string; raw: string }
  | { kind: 'other'; raw: string }

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/

const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/

function decodeDouble(body: string): string {
  return body.replace(/\\([\\"nrt$])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c))
}

/** The value of `rest` (everything after `=`), and how many extra lines a quoted value spans. */
function readValue(rest: string, following: string[]): { value: string; extra: number } {
  const text = rest.trimStart()
  const quote = text[0]
  if (quote === '"' || quote === "'" || quote === '`') {
    // A closing quote on this line, or on a later one (a multi-line double-quoted value).
    const close = (s: string, from: number) => {
      for (let i = from; i < s.length; i += 1) {
        if (s[i] === '\\' && quote === '"') { i += 1; continue }
        if (s[i] === quote) return i
      }
      return -1
    }
    let body = text.slice(1)
    let end = close(body, 0)
    let extra = 0
    while (end === -1 && extra < following.length) {
      body += `\n${following[extra]}`
      extra += 1
      end = close(body, 0)
    }
    if (end === -1) return { value: text, extra: 0 } // unterminated: show it as written
    const inner = body.slice(0, end)
    return { value: quote === '"' ? decodeDouble(inner) : inner, extra }
  }
  // Unquoted: a ` #` starts a comment.
  const hash = text.search(/\s#/)
  return { value: (hash === -1 ? text : text.slice(0, hash)).trimEnd(), extra: 0 }
}

export function parseEnv(text: string): EnvLine[] {
  const source = text.split(/\r?\n/)
  if (source.length > 0 && source[source.length - 1] === '') source.pop()
  const lines: EnvLine[] = []
  for (let i = 0; i < source.length; i += 1) {
    const line = source[i]!
    const match = ASSIGNMENT.exec(line)
    if (!match) { lines.push({ kind: 'other', raw: line }); continue }
    const { value, extra } = readValue(match[3]!, source.slice(i + 1))
    const raw = [line, ...source.slice(i + 1, i + 1 + extra)].join('\n')
    lines.push({ kind: 'var', key: match[2]!, value, raw })
    i += extra
  }
  return lines
}

/** `KEY=value`, quoted only when the value would not survive unquoted. */
export function formatAssignment(key: string, value: string): string {
  if (value === '' || /^[^\s"'`#\\$]+$/.test(value)) return `${key}=${value}`
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\$/g, '\\$')
  return `${key}="${escaped}"`
}

export function serializeEnv(lines: EnvLine[]): string {
  return lines.length === 0 ? '' : `${lines.map((line) => line.raw).join('\n')}\n`
}

/** Replace one variable line, keeping its `export ` prefix. */
export function setVariable(lines: EnvLine[], index: number, key: string, value: string): EnvLine[] {
  const line = lines[index]
  if (!line || line.kind !== 'var') return lines
  if (line.key === key && line.value === value) return lines
  const prefix = /^\s*export\s+/.exec(line.raw)?.[0] ?? ''
  const next = [...lines]
  next[index] = { kind: 'var', key, value, raw: `${prefix}${formatAssignment(key, value)}` }
  return next
}

export function addVariable(lines: EnvLine[], key: string, value: string): EnvLine[] {
  return [...lines, { kind: 'var', key, value, raw: formatAssignment(key, value) }]
}

export function removeLine(lines: EnvLine[], index: number): EnvLine[] {
  return lines.filter((_, i) => i !== index)
}

/** Keys that appear more than once — the last one wins for most loaders, so it is worth a flag. */
export function duplicateKeys(lines: EnvLine[]): Set<string> {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const line of lines) {
    if (line.kind !== 'var') continue
    if (seen.has(line.key)) dupes.add(line.key)
    seen.add(line.key)
  }
  return dupes
}
