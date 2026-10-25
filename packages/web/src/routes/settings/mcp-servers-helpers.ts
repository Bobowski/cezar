import {
  MCP_SERVER_NAME_PATTERN,
  mcpSecretReference,
  mcpServerDefinitionSchema,
  type McpServerDefinition,
} from '@open-mercato/cezar-api-client'

/**
 * Pure helpers behind Settings → MCP servers (spec 2026-10-24-easy-mcp): what Add writes, given
 * what the operator picked. Kept out of the component so the rules are unit-tested on their own.
 */

/** The definition's text values, each mapped by `map`; a value `map` drops (null) removes its entry. */
function mapValues(def: McpServerDefinition, map: (value: string) => string | null): McpServerDefinition {
  const record = (input?: Record<string, string>) => {
    if (!input) return undefined
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
      const next = map(value)
      if (next !== null) out[key] = next
    }
    return Object.keys(out).length ? out : undefined
  }
  const args = def.args?.map(map).filter((arg): arg is string => arg !== null)
  const env = record(def.env)
  const headers = record(def.headers)
  const next: McpServerDefinition = { ...def }
  delete next.args
  delete next.env
  delete next.headers
  return {
    ...next,
    ...(def.command ? { command: map(def.command) ?? def.command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(def.url ? { url: map(def.url) ?? def.url } : {}),
    ...(headers ? { headers } : {}),
  }
}

const referenceRe = (name: string) => new RegExp(`\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`, 'g')

/**
 * A catalog or registry definition made concrete: each key's reference renamed to the secret the
 * operator picked for it, and every value that references a key left unfilled dropped (an optional
 * key the operator skipped). The definition never holds a value — only references.
 */
export function applyKeyChoices(def: McpServerDefinition, choices: Record<string, string | undefined>): McpServerDefinition {
  return mapValues(def, (value) => {
    let out = value
    for (const [key, chosen] of Object.entries(choices)) {
      if (!referenceRe(key).test(out)) continue
      if (!chosen) return null
      out = out.replace(referenceRe(key), mcpSecretReference(chosen))
    }
    return out
  })
}

/** One line saying what a definition launches — shown before Add (spec §5). */
export function launchLine(def: McpServerDefinition): string {
  if (def.command) return [def.command, ...(def.args ?? [])].join(' ')
  return `${def.type ?? 'http'} ${def.url ?? ''}`
}

/**
 * Pasted JSON as one named definition. Accepts the `.mcp.json` file shape (`{ mcpServers: {…} }`),
 * a one-entry `{ name: definition }`, or a bare definition (named by `fallbackName`).
 */
export function parsePastedDefinition(text: string, fallbackName: string): { name: string; definition: McpServerDefinition } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { error: `not valid JSON: ${(error as Error).message}` }
  }
  let name = fallbackName.trim()
  let candidate: unknown = raw
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  if (isObject(raw) && isObject(raw.mcpServers)) candidate = raw.mcpServers
  if (isObject(candidate) && !('command' in candidate) && !('url' in candidate)) {
    const entries = Object.entries(candidate)
    if (entries.length !== 1) return { error: 'paste one server — a definition, or one { "name": { … } } entry' }
    const [entryName, entry] = entries[0]!
    if (!name) name = entryName
    candidate = entry
  }
  if (!name) return { error: 'give the server a name' }
  if (!MCP_SERVER_NAME_PATTERN.test(name)) return { error: 'a name is 1–64 letters, digits, "_" or "-"' }
  const parsed = mcpServerDefinitionSchema.safeParse(candidate)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { error: issue ? `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'not a server definition' }
  }
  return { name, definition: parsed.data }
}
