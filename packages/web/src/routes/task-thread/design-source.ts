/**
 * Where a picked element is written (spec `.ai/specs/2026-10-24-design-mode-third-cut.md` §3.3):
 * the file and line a development build of the framework hangs off the DOM node.
 *
 * The picker reports what the page says, which is usually an ABSOLUTE path on the machine the
 * dev server runs on. Only a path under the task's worktree (or the project checkout) is kept,
 * and only relative to it: no absolute server path reaches a hosted viewer (§5).
 */

export interface DesignSource {
  /** Relative to the worktree, `/`-separated. */
  file: string
  /** 1-based; absent where the framework names only the file (Vue's `__file`). */
  line?: number
}

const FILE_MAX = 500
const RELATIVE_MAX = 300

/** `src/a.tsx:14`, `C:\x\a.tsx:14:3` → file and line. A Windows drive colon is not a line. */
function splitLegacy(raw: string): { file: string; line?: number } {
  const match = /^(.+?):(\d+)(?::\d+)?$/.exec(raw)
  if (match && !/^[A-Za-z]$/.test(match[1]!)) return { file: match[1]!, line: Number(match[2]) }
  return { file: raw }
}

/**
 * A source location out of whatever arrived: the picker's `{ file, line }`, or the `file:line`
 * string a pre-third-cut draft stored. Bounded, and `null` for anything else — the sender is a
 * page cezar does not control.
 */
export function parsePickSource(raw: unknown): DesignSource | null {
  let file: unknown
  let line: unknown
  if (typeof raw === 'string') ({ file, line } = splitLegacy(raw))
  else if (raw !== null && typeof raw === 'object') ({ file, line } = raw as { file?: unknown; line?: unknown })
  if (typeof file !== 'string' || file === '' || file.length > FILE_MAX) return null
  const out: DesignSource = { file }
  if (typeof line === 'number' && Number.isInteger(line) && line > 0 && line < 10_000_000) out.line = line
  return out
}

const normalize = (path: string): string =>
  path
    .replace(/^file:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\\/g, '/')
    // `file:///C:/x` leaves `/C:/x`.
    .replace(/^\/([A-Za-z]:\/)/, '$1')

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path)

/** A relative path that stays inside its root: no `..`, no empty or `.` segment games. */
function cleanRelative(path: string): string | null {
  const segments = path.replace(/^(\.\/)+/, '').split('/')
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) return null
  const out = segments.join('/')
  return out !== '' && out.length <= RELATIVE_MAX ? out : null
}

/**
 * `source` relative to the first of `roots` it lies under, or `null` when it lies under none.
 * A path the framework already gave relative (Svelte's `__svelte_meta`) is kept as it is when it
 * stays inside. Drive-letter paths compare case-insensitively, as Windows does.
 */
export function relativeSource(source: DesignSource, roots: readonly (string | null | undefined)[]): DesignSource | null {
  const file = normalize(source.file)
  let relative: string | null = null
  if (!isAbsolute(file)) relative = cleanRelative(file)
  else {
    for (const raw of roots) {
      if (!raw) continue
      const root = normalize(raw).replace(/\/+$/, '')
      if (root === '' || !isAbsolute(root)) continue
      const drive = /^[A-Za-z]:\//.test(root)
      const head = file.slice(0, root.length + 1)
      if ((drive ? head.toLowerCase() : head) !== `${drive ? root.toLowerCase() : root}/`) continue
      relative = cleanRelative(file.slice(root.length + 1))
      if (relative !== null) break
    }
  }
  if (relative === null) return null
  return source.line === undefined ? { file: relative } : { file: relative, line: source.line }
}

/** `src/a.tsx:14`, or the file alone. */
export function formatSource(source: DesignSource): string {
  return source.line === undefined ? source.file : `${source.file}:${source.line}`
}
