import type { AutomationsResponse, TrackerAssociation } from '@open-mercato/cezar-api-client'

/**
 * Which enabled automations a move INTO a status will fire, by vendor status id (spec
 * 2026-10-11-tracker-ticket-context § Phase 6). A move the user makes by hand is a real
 * transition: the poller sees it like any other, so the surface says so before the drop.
 *
 * Computed from the automation definitions the cockpit already has. Only automations bound to
 * this very source and scope count, and only those that name their target statuses: one with no
 * `targetStatusIds` fires on every status change, which is reported under `ANY_STATUS`.
 */
export const ANY_STATUS = '*'

export function automationsByTargetStatus(
  automations: AutomationsResponse['automations'] | undefined,
  association: TrackerAssociation,
): Map<string, string[]> {
  const byStatus = new Map<string, string[]>()
  for (const automation of automations ?? []) {
    const trigger = automation.trackerTrigger
    if (!automation.enabled || automation.kind !== 'tracker' || !trigger?.events.includes('issue.status_changed')) continue
    const bound = trigger.association
    if (bound.kind !== association.kind || bound.source.id !== association.source.id || bound.externalId !== association.externalId) continue
    for (const statusId of trigger.targetStatusIds?.length ? trigger.targetStatusIds : [ANY_STATUS]) {
      const names = byStatus.get(statusId)
      if (names) names.push(automation.name)
      else byStatus.set(statusId, [automation.name])
    }
  }
  return byStatus
}

/** The line a drop target or a menu item shows, or null when the move starts nothing. */
export function automationHint(byStatus: ReadonlyMap<string, string[]>, statusId: string): string | null {
  const names = [...(byStatus.get(statusId) ?? []), ...(byStatus.get(ANY_STATUS) ?? [])]
  if (names.length === 0) return null
  return `Starts ${names.length === 1 ? 'automation' : 'automations'}: ${names.join(', ')}`
}
