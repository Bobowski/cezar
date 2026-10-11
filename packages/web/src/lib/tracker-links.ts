import type { ApiRun, RunStatus, TrackerAssociation } from '@open-mercato/cezar-api-client'

/** The fields of a run the tracker surface shows beside a ticket. */
export type TicketRun = Pick<ApiRun, 'id' | 'title' | 'titleSummary' | 'task' | 'status' | 'createdAt' | 'archived'>

const ACTIVE: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting'])

/**
 * The project's runs by the ticket they are linked to, newest first. Computed from run records
 * the cockpit already holds — no vendor request, so it works with the tracker unreachable.
 *
 * Matched on provider + source + item id, NOT on scope or connection: a ticket moved between
 * Jira projects, or read with a rotated token, is still the same ticket.
 */
export function runsByTicket(runs: readonly ApiRun[], association: TrackerAssociation): Map<string, ApiRun[]> {
  const byTicket = new Map<string, ApiRun[]>()
  for (const run of runs) {
    for (const link of run.trackerLinks ?? []) {
      if (link.provider !== association.kind || link.sourceId !== association.source.id) continue
      const list = byTicket.get(link.itemId)
      if (list) { if (!list.includes(run)) list.push(run) } else byTicket.set(link.itemId, [run])
    }
  }
  for (const list of byTicket.values()) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return byTicket
}

/** What a row says about its ticket's tasks: one is working, one waits for review, or all are over. */
export function ticketActivity(runs: readonly TicketRun[] | undefined): { status: RunStatus; label: string } | null {
  if (!runs?.length) return null
  const working = runs.find(run => ACTIVE.has(run.status))
  if (working) return { status: working.status, label: runs.length === 1 ? 'An agent is working on this' : `An agent is working on this · ${runs.length} tasks` }
  const review = runs.find(run => run.status === 'review')
  if (review) return { status: 'review', label: 'A task for this issue needs review' }
  return { status: runs[0]!.status, label: runs.length === 1 ? '1 finished task' : `${runs.length} finished tasks` }
}

/** True while any task for the ticket is queued, running or waiting on the user. */
export function hasActiveRun(runs: readonly TicketRun[] | undefined): boolean {
  return !!runs?.some(run => ACTIVE.has(run.status))
}
