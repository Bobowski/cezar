import type { TrackerItem, TrackerStatusCategory } from '@open-mercato/cezar-api-client'

export type TrackerGroup = {
  statusId: string
  status: string
  category: TrackerStatusCategory
  items: TrackerItem[]
}

/** Workflow order for list groups and board columns; `other` is whatever the contract cannot place. */
const CATEGORY_ORDER: readonly TrackerStatusCategory[] = ['backlog', 'unstarted', 'started', 'done', 'canceled', 'other']

/**
 * Groups LOADED items by vendor status id (names are not unique and can be renamed), ordered by
 * workflow category and, inside one category, by first appearance so a refresh does not reshuffle
 * columns. It describes the pages on screen, never the vendor's backlog: a status with no loaded
 * item has no group.
 */
export function groupByStatus(items: readonly TrackerItem[]): TrackerGroup[] {
  const groups = new Map<string, TrackerGroup>()
  for (const item of items) {
    const group = groups.get(item.statusId)
    if (group) group.items.push(item)
    else groups.set(item.statusId, { statusId: item.statusId, status: item.status, category: item.statusCategory, items: [item] })
  }
  return [...groups.values()]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.group.category) - CATEGORY_ORDER.indexOf(b.group.category) || a.index - b.index)
    .map(({ group }) => group)
}
