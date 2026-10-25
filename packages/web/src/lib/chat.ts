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

/** More diff lines than a reviewer reads collapsed; the server's own caps mark the rest. */
const LONG_DIFF_LINES = 400

/** A proposal whose diff the owner must open before Apply (spec §3): one the server could not
 *  diff or truncated, or one too long to have been read collapsed. */
export function proposalOversized(diff: string): boolean {
  return diff.includes('@@ too large to diff here @@') || diff.includes('… (diff truncated)') || diff.split('\n').length > LONG_DIFF_LINES
}

/** What a proposed workflow adds that runs or leaves the machine unattended: every `command`
 *  (step or check node) and every push, PR or webhook node, as the added diff lines read. */
export function workflowRisks(path: string, diff: string): string[] {
  if (!path.startsWith('.ai/cezar/workflows/')) return []
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())
    .filter((line) => /(^|[\s{,"'])command["']?\s*:/.test(line) || /\b(?:git\.push|pr\.create|notify\.webhook)\b/.test(line))
}
