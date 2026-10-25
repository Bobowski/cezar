import { chatMayWrite, type RunRecord } from '@open-mercato/cezar-api-client'

/**
 * The cockpit chat on the client (spec 2026-10-24-cockpit-chat): a chat is a run with
 * `kind: 'chat'`. It lives under Chat, never in the Tasks lists, counts or badges.
 */

/** The directory the chat's files sit in; only `CHAT_WRITABLE` under it is the chat's (spec §5). */
export const CHAT_DIR = '.ai/cezar/'

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

/** Whether a checkout path is the chat's to show, commit and revert — the same list it may write. */
export function inChatDir(path: string): boolean {
  return chatMayWrite(path)
}

/** The commit message the chat panel proposes for the files it commits. */
export function chatCommitMessage(paths: readonly string[]): string {
  const names = paths.map((path) => path.slice(CHAT_DIR.length))
  const shown = names.slice(0, 3).join(', ')
  return `cezar: update ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
}
