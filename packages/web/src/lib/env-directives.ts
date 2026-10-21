import { removeLine, setVariable, type EnvLine } from '@/lib/dotenv-lines'

/**
 * `#cezar KEY=source` directives as the variables view edits them (spec 2026-10-21-env-references).
 * A directive is the line right above its `KEY=` assignment; the server renders the assignment from
 * it on save. Here a row's value IS the directive's source while it holds a reference, and goes back
 * to a plain value the moment it no longer does.
 */
const DIRECTIVE = /^#cezar\s+(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/

export const hasReference = (source: string): boolean => /(^|[^\\])\$\{\{/.test(source)

export function isDirectiveLine(line: EnvLine): boolean {
  return line.kind === 'other' && DIRECTIVE.test(line.raw.trimEnd())
}

/** The directive owning the assignment at `index`, if the line above is one for the same key. */
export function directiveFor(lines: EnvLine[], index: number): { index: number; source: string } | null {
  const line = lines[index]
  const above = lines[index - 1]
  if (!line || line.kind !== 'var' || !above || above.kind !== 'other') return null
  const match = DIRECTIVE.exec(above.raw.trimEnd())
  return match && match[1] === line.key ? { index: index - 1, source: match[2] ?? '' } : null
}

/**
 * Set what the row at `index` holds. With a reference in it, the source goes into a directive
 * above the line (created when missing) and the value stays until the server renders it; without
 * one, the directive goes and the source becomes the plain value.
 */
export function setSource(lines: EnvLine[], index: number, key: string, source: string): EnvLine[] {
  const directive = directiveFor(lines, index)
  if (hasReference(source)) {
    const raw = `#cezar ${key}=${source}`
    if (directive) {
      if (lines[directive.index]?.raw === raw) return lines
      const next = [...lines]
      next[directive.index] = { kind: 'other', raw }
      return next
    }
    return [...lines.slice(0, index), { kind: 'other', raw }, ...lines.slice(index)]
  }
  if (directive) {
    const without = removeLine(lines, directive.index)
    return setVariable(without, index - 1, key, source)
  }
  return setVariable(lines, index, key, source)
}

/** Remove the variable at `index` and the directive that renders it. */
export function removeVariable(lines: EnvLine[], index: number): EnvLine[] {
  const directive = directiveFor(lines, index)
  const without = removeLine(lines, index)
  return directive ? removeLine(without, directive.index) : without
}

/** Rename keeps the directive in step, so it still owns the line. */
export function renameVariable(lines: EnvLine[], index: number, key: string): EnvLine[] {
  const directive = directiveFor(lines, index)
  const line = lines[index]
  if (!line || line.kind !== 'var') return lines
  const renamed = setVariable(lines, index, key, line.value)
  if (!directive) return renamed
  const next = [...renamed]
  next[directive.index] = { kind: 'other', raw: `#cezar ${key}=${directive.source}` }
  return next
}

/** The next free `task.port(k, …)` offset in the text — two services asking for one port is a mistake. */
export function nextPortOffset(text: string): number {
  const used = new Set([...text.matchAll(/task\.port\(\s*(\d{1,2})\s*,/g)].map((match) => Number(match[1])))
  for (let k = 0; k < 100; k += 1) if (!used.has(k)) return k
  return 0
}

