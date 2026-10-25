import type { RunRecord } from '@open-mercato/cezar-api-client'

/**
 * The cockpit chat on the client (spec 2026-10-24-cockpit-chat): a chat is a run with
 * `kind: 'chat'`. It lives under Chat, never in the Tasks lists, counts or badges.
 */

export function isChatRun(run: Pick<RunRecord, 'kind'>): boolean {
  return run.kind === 'chat'
}

/** The project's chats, newest first; the first unarchived one is the pinned chat (spec §3). */
export function projectChats<R extends Pick<RunRecord, 'kind' | 'createdAt' | 'archived'>>(runs: readonly R[]): { pinned: R | undefined; previous: R[] } {
  const chats = runs.filter(isChatRun).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const pinned = chats.find((chat) => !chat.archived)
  return { pinned, previous: chats.filter((chat) => chat !== pinned) }
}

/** The tasks a chat started — the chips in its header. */
export function chatTasks<R extends Pick<RunRecord, 'createdBy'>>(runs: readonly R[], chatId: string): R[] {
  return runs.filter((run) => run.createdBy === `chat:${chatId}`)
}

/** The chats the cockpit knows: `GET /runs?kind=chat`'s answer, overlaid with the run list's live
 *  copies — the SSE `run` patches land there, chats included. */
export function knownChats<R extends Pick<RunRecord, 'id' | 'kind'>>(chats: readonly R[] | undefined, runs: readonly R[] | undefined): R[] {
  const byId = new Map<string, R>()
  for (const chat of chats ?? []) byId.set(chat.id, chat)
  for (const run of runs ?? []) if (isChatRun(run)) byId.set(run.id, run)
  return [...byId.values()]
}
