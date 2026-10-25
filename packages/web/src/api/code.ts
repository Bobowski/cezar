import {
  queryScope,
  type ChangesPayload, type CodeSearchResult, type CodeWatch, type RepoTree, type RunFileDeleteResponse, type RunFileRename,
  type RunFileWriteResponse, type TerminalCreateInput, type TerminalOutput, type TerminalSession, type TerminalState, type WorktreeEntry,
  type DiscoveredCommandsResponse, type ProjectDetectedUrlsResponse, type TerminalHistoryResponse,
} from '@open-mercato/cezar-api-client'

import {
  cez, createRunFile, createRunTerminal, deleteRunFile, getRepoChanges, getRepoFile, getRepoTree, getRunChanges, getRunFile,
  getRunTerminal, putRunFile, readRunTerminal, renameRunFile, repoFileRawUrl, resizeRunTerminal, runFileRawUrl, stopRunTerminal,
  unwrap, writeRunTerminal, type ReadOptions,
} from './client'

/**
 * The Code page's transport (spec 2026-10-11-code-page §5): one set of calls over a CHECKOUT,
 * which is the main one or a task's worktree. The page never branches on which — it holds a
 * `CodeTree` and these do.
 */
export type CodeTree = { kind: 'main' } | { kind: 'run'; runId: string }

export const treeKey = (tree: CodeTree): string => (tree.kind === 'main' ? 'main' : tree.runId)

const repo = () => cez.api.v1.p[':projectId'].repo
const run = () => cez.api.v1.p[':projectId'].runs[':id']
const scope = () => ({ projectId: queryScope() })
const init = (opts?: ReadOptions) => ({ init: { signal: opts?.signal } })

export async function getCodeTree(tree: CodeTree, opts?: ReadOptions): Promise<RepoTree> {
  if (tree.kind === 'main') return getRepoTree(opts)
  return unwrap(await run().tree.$get({ param: { ...scope(), id: tree.runId } }, init(opts)), `/runs/${tree.runId}/tree`)
}

export function getCodeChanges(tree: CodeTree, opts?: ReadOptions): Promise<ChangesPayload> {
  return tree.kind === 'main' ? getRepoChanges(opts) : getRunChanges(tree.runId, opts)
}

export function getCodeFile(tree: CodeTree, path: string, opts?: ReadOptions): Promise<WorktreeEntry> {
  return tree.kind === 'main' ? getRepoFile(path, opts) : getRunFile(tree.runId, path, opts)
}

export const codeFileRawUrl = (tree: CodeTree, path: string): string =>
  tree.kind === 'main' ? repoFileRawUrl(path) : runFileRawUrl(tree.runId, path)

export async function saveCodeFile(tree: CodeTree, path: string, content: string, baseHash: string): Promise<RunFileWriteResponse> {
  if (tree.kind === 'run') return putRunFile(tree.runId, path, { content, baseHash })
  return unwrap(await repo().files.$put({ param: scope(), query: { path }, json: { content, baseHash } }), '/repo/files')
}

export async function createCodeFile(tree: CodeTree, path: string): Promise<RunFileWriteResponse> {
  if (tree.kind === 'run') return createRunFile(tree.runId, path, '')
  return unwrap(await repo().files.$post({ param: scope(), query: { path }, json: { content: '' } }), '/repo/files')
}

export async function deleteCodeFile(tree: CodeTree, path: string): Promise<RunFileDeleteResponse> {
  if (tree.kind === 'run') return deleteRunFile(tree.runId, path)
  return unwrap(await repo().files.$delete({ param: scope(), query: { path } }), '/repo/files')
}

export async function renameCodeFile(tree: CodeTree, body: RunFileRename): Promise<RunFileRename> {
  if (tree.kind === 'run') return renameRunFile(tree.runId, body)
  return unwrap(await repo().files.rename.$post({ param: scope(), json: body }), '/repo/files/rename')
}

export interface CodeSearchOptions {
  regex: boolean
  caseSensitive: boolean
  glob: string
}

export async function searchCode(tree: CodeTree, q: string, options: CodeSearchOptions, opts?: ReadOptions): Promise<CodeSearchResult> {
  const query = {
    q,
    ...(options.regex ? { regex: '1' as const } : {}),
    ...(options.caseSensitive ? { case: '1' as const } : {}),
    ...(options.glob.trim() ? { glob: options.glob.trim() } : {}),
  }
  if (tree.kind === 'main') return unwrap(await repo().search.$get({ param: scope(), query }, init(opts)), '/repo/search')
  return unwrap(await run().search.$get({ param: { ...scope(), id: tree.runId }, query }, init(opts)), `/runs/${tree.runId}/search`)
}

export async function getCodeWatch(tree: CodeTree, opts?: ReadOptions, stamp = false): Promise<CodeWatch> {
  const query = { ...(tree.kind === 'main' ? {} : { tree: tree.runId }), ...(stamp ? { stamp: '1' as const } : {}) }
  return unwrap(await repo().watch.$get({ param: scope(), query }, init(opts)), '/repo/watch')
}

// ---- terminals of the checkout: the project's own, or the task's ------------------------------

export async function getCodeTerminal(tree: CodeTree): Promise<TerminalState> {
  if (tree.kind === 'run') return getRunTerminal(tree.runId)
  return unwrap(await repo().terminal.$get({ param: scope() }), '/repo/terminal')
}

export async function createCodeTerminal(tree: CodeTree, body: TerminalCreateInput): Promise<TerminalSession> {
  if (tree.kind === 'run') return createRunTerminal(tree.runId, body)
  return unwrap(await repo().terminal.$post({ param: scope(), json: body }), '/repo/terminal')
}

export async function readCodeTerminal(tree: CodeTree, sessionId: string, cursor: number): Promise<TerminalOutput> {
  if (tree.kind === 'run') return readRunTerminal(tree.runId, sessionId, cursor)
  return unwrap(
    await repo().terminal[':sessionId'].output.$get({ param: { ...scope(), sessionId }, query: { cursor: String(cursor) } }),
    '/repo/terminal/output',
  )
}

export async function writeCodeTerminal(tree: CodeTree, sessionId: string, data: string): Promise<void> {
  if (tree.kind === 'run') return writeRunTerminal(tree.runId, sessionId, data)
  await unwrap(await repo().terminal[':sessionId'].input.$post({ param: { ...scope(), sessionId }, json: { data } }), '/repo/terminal/input')
}

export async function resizeCodeTerminal(tree: CodeTree, sessionId: string, cols: number, rows: number): Promise<void> {
  if (tree.kind === 'run') return resizeRunTerminal(tree.runId, sessionId, cols, rows)
  await unwrap(await repo().terminal[':sessionId'].resize.$post({ param: { ...scope(), sessionId }, json: { cols, rows } }), '/repo/terminal/resize')
}

export async function stopCodeTerminal(tree: CodeTree, sessionId: string): Promise<void> {
  if (tree.kind === 'run') return stopRunTerminal(tree.runId, sessionId)
  await unwrap(await repo().terminal[':sessionId'].$delete({ param: { ...scope(), sessionId } }), '/repo/terminal')
}

// ---- the project terminals' strips and history (spec 2026-10-24-code-page-terminal §4) ---------

export async function getProjectTerminalUrls(): Promise<ProjectDetectedUrlsResponse> {
  return unwrap(await repo().terminal.urls.$get({ param: scope() }), '/repo/terminal/urls')
}

export async function getProjectTerminalCommands(): Promise<DiscoveredCommandsResponse> {
  return unwrap(await repo().terminal.commands.$get({ param: scope() }), '/repo/terminal/commands')
}

export async function getProjectTerminalHistory(): Promise<TerminalHistoryResponse> {
  return unwrap(await repo().terminal.history.$get({ param: scope() }), '/repo/terminal/history')
}
