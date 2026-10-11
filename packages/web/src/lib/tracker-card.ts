/**
 * What a board card says beyond its key and title: one line of the description, who has the
 * ticket, how urgent the vendor says it is. Pure helpers, so the card stays markup.
 */

/** The first line of a ticket's description that says something, as plain text. */
export function ticketExcerpt(body: string, max = 140): string {
  for (const raw of body.split('\n')) {
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their text
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, '') // heading, quote and list markers
      .replace(/[*_~`]+/g, '') // emphasis and code marks
      .replace(/\s+/g, ' ')
      .trim()
    // A rule or a table divider is structure, not a sentence.
    if (!line || /^[-=|: ]+$/.test(line)) continue
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
  }
  return ''
}

export type PriorityLevel = 'urgent' | 'high' | 'medium' | 'low' | 'other'

/**
 * Jira and Linear name priorities differently (Highest/High/Medium/Low/Lowest; Urgent/High/
 * Medium/Low) and a Jira site can rename them. Known names get a level; anything else is shown
 * as written, with no urgency implied.
 */
export function priorityLevel(priority: string): PriorityLevel {
  switch (priority.trim().toLowerCase()) {
    case 'urgent': case 'highest': case 'critical': case 'blocker': return 'urgent'
    case 'high': case 'major': return 'high'
    case 'medium': case 'normal': return 'medium'
    case 'low': case 'lowest': case 'minor': case 'trivial': return 'low'
    default: return 'other'
  }
}

/** Up to two initials for an avatar: "Ada Lovelace" → "AL", "grace" → "G". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]!][0] ?? ''
  const last = words.length > 1 ? [...words[words.length - 1]!][0] ?? '' : ''
  return (first + last).toUpperCase()
}
