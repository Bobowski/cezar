import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import {
  queryScope,
  type RepoCommitInput,
  type RepoCommitResponse,
  type RepoCompare,
  type RepoDiscard,
  type RepoGitActionResponse,
  type RepoGraph,
  type RepoGraphFilter,
  type RepoIndex,
  type RepoIndexChange,
  type RepoMessageResponse,
  type RepoRemotes,
  type RepoStashList,
  type RepoStashPush,
} from '@open-mercato/cezar-api-client'

import { cez, unwrap, type ReadOptions } from './client'
import { getCodeWatch } from './code'
import { queryKeys } from './queries'
import { subscribeTopic } from './ws'

/**
 * The Git page's Source-Control calls (spec 2026-10-24-git-view): the graph, the index, branch
 * and history actions, stashes and remotes, all on the project's main checkout. Every mutation's
 * failure is a 409 whose ApiError carries git's own words.
 */

const repo = () => cez.api.v1.p[':projectId'].repo
const scope = () => ({ projectId: queryScope() })
const init = (opts?: ReadOptions) => ({ init: { signal: opts?.signal } })

/** Under `queryKeys.repo`, so every mutation's invalidation of `repo` refreshes them too. */
export const repoGitKeys = {
  graph: (filter: RepoGraphFilter) => [...queryKeys.repo, 'graph', filter] as const,
  index: () => [...queryKeys.repo, 'index'] as const,
  compare: (ref: string) => [...queryKeys.repo, 'compare', ref] as const,
  stash: () => [...queryKeys.repo, 'stash'] as const,
  remotes: () => [...queryKeys.repo, 'remotes'] as const,
}

export const GRAPH_PAGE = 200

export async function getRepoGraph(input: { filter: RepoGraphFilter; after?: string }, opts?: ReadOptions): Promise<RepoGraph> {
  return unwrap(
    await repo().graph.$get(
      { param: scope(), query: { filter: input.filter, limit: String(GRAPH_PAGE), ...(input.after ? { after: input.after } : {}) } },
      init(opts),
    ),
    '/repo/graph',
  )
}

export async function getRepoIndex(opts?: ReadOptions): Promise<RepoIndex> {
  return unwrap(await repo().status.$get({ param: scope() }, init(opts)), '/repo/status')
}

export async function getRepoCompare(ref: string, opts?: ReadOptions): Promise<RepoCompare> {
  return unwrap(await repo().compare.$get({ param: scope(), query: { ref } }, init(opts)), '/repo/compare')
}

export async function getRepoStashes(opts?: ReadOptions): Promise<RepoStashList> {
  return unwrap(await repo().stash.$get({ param: scope() }, init(opts)), '/repo/stash')
}

export async function getRepoRemotes(opts?: ReadOptions): Promise<RepoRemotes> {
  return unwrap(await repo().remotes.$get({ param: scope() }, init(opts)), '/repo/remotes')
}

export type BranchAction = 'checkout' | 'merge' | 'rebase'

export async function runBranchAction(name: string, action: BranchAction): Promise<RepoGitActionResponse> {
  const branch = repo().branch[':name']
  const param = { param: { ...scope(), name: encodeURIComponent(name) } }
  const res =
    action === 'checkout'
      ? await branch.checkout.$post(param)
      : action === 'merge'
        ? await branch.merge.$post(param)
        : await branch.rebase.$post(param)
  return unwrap(res, `/repo/branch/${action}`)
}

export async function deleteBranch(name: string, options: { remote?: boolean; force?: boolean }): Promise<RepoGitActionResponse> {
  return unwrap(
    await repo().branch[':name'].delete.$post({
      param: { ...scope(), name: encodeURIComponent(name) },
      query: { ...(options.remote ? { remote: '1' as const } : {}), ...(options.force ? { force: '1' as const } : {}) },
    }),
    '/repo/branch/delete',
  )
}

export async function renameBranch(name: string, to: string): Promise<RepoGitActionResponse> {
  return unwrap(
    await repo().branch[':name'].rename.$post({ param: { ...scope(), name: encodeURIComponent(name) }, json: { to } }),
    '/repo/branch/rename',
  )
}

export async function pushBranchTo(name: string, remote: string): Promise<RepoGitActionResponse> {
  return unwrap(
    await repo().branch[':name'].push.$post({ param: { ...scope(), name: encodeURIComponent(name) }, json: { remote } }),
    '/repo/branch/push',
  )
}

export async function cherryPickCommit(sha: string): Promise<RepoGitActionResponse> {
  return unwrap(await repo().commit[':sha']['cherry-pick'].$post({ param: { ...scope(), sha } }), '/repo/commit/cherry-pick')
}

export async function runOperation(step: 'abort' | 'continue'): Promise<RepoGitActionResponse> {
  const res = step === 'abort' ? await repo().merge.abort.$post({ param: scope() }) : await repo().merge.continue.$post({ param: scope() })
  return unwrap(res, `/repo/merge/${step}`)
}

export type IndexStep = 'stage' | 'unstage'

export async function changeIndex(step: IndexStep, change: RepoIndexChange): Promise<RepoIndex> {
  const body = { param: scope(), json: change }
  const res = step === 'stage' ? await repo().stage.$post(body) : await repo().unstage.$post(body)
  return unwrap(res, `/repo/${step}`)
}

/** Only from the confirm dialog: the server refuses a discard without `confirm: true`. */
export async function discardChange(change: RepoDiscard): Promise<RepoIndex> {
  return unwrap(await repo().discard.$post({ param: scope(), json: change }), '/repo/discard')
}

export async function commitIndex(input: RepoCommitInput): Promise<RepoCommitResponse> {
  return unwrap(await repo().commit.$post({ param: scope(), json: input }), '/repo/commit')
}

export async function pushStash(input: RepoStashPush): Promise<RepoMessageResponse> {
  return unwrap(await repo().stash.$post({ param: scope(), json: input }), '/repo/stash')
}

export async function popStash(n: number): Promise<RepoGitActionResponse> {
  return unwrap(await repo().stash[':n'].pop.$post({ param: { ...scope(), n: String(n) } }), '/repo/stash/pop')
}

export async function fetchRemote(name: string): Promise<RepoMessageResponse> {
  return unwrap(
    await repo().remotes[':name'].fetch.$post({ param: { ...scope(), name: encodeURIComponent(name) } }),
    '/repo/remotes/fetch',
  )
}

// ---- hooks -------------------------------------------------------------------------------------

export function useRepoGraph(filter: RepoGraphFilter) {
  return useInfiniteQuery({
    queryKey: repoGitKeys.graph(filter),
    queryFn: ({ signal, pageParam }) => getRepoGraph({ filter, after: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    retry: false,
    refetchOnWindowFocus: true,
  })
}

/** The index changes under the user's editor and terminal, so it follows the checkout's bell
 *  (`/repo/watch`) where the host has one, and focus everywhere. */
export function useRepoIndex() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: repoGitKeys.index(),
    queryFn: ({ signal }) => getRepoIndex({ signal }),
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
  const watch = useQuery({
    queryKey: [...queryKeys.repo, 'watch-topic'],
    queryFn: ({ signal }) => getCodeWatch({ kind: 'main' }, { signal }),
    staleTime: Infinity,
    retry: false,
  })
  const topic = watch.data?.topic
  useEffect(() => {
    if (!topic) return
    return subscribeTopic(topic, () => void queryClient.invalidateQueries({ queryKey: repoGitKeys.index() }), () => {})
  }, [queryClient, topic])
  return query
}

export function useRepoCompare(ref: string | null) {
  return useQuery({
    queryKey: repoGitKeys.compare(ref ?? ''),
    queryFn: ({ signal }) => getRepoCompare(ref as string, { signal }),
    enabled: Boolean(ref),
    retry: false,
  })
}

export function useRepoStashes() {
  return useQuery({ queryKey: repoGitKeys.stash(), queryFn: ({ signal }) => getRepoStashes({ signal }), retry: false })
}

export function useRepoRemotes() {
  return useQuery({ queryKey: repoGitKeys.remotes(), queryFn: ({ signal }) => getRepoRemotes({ signal }), retry: false })
}

/** One git action on the checkout. Success refreshes everything under `repo` (and the health
 *  chip's branch); a 409 reaches `onError` with git's own words. */
export function useRepoGitAction<I, O>(run: (input: I) => Promise<O>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repo }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]),
  })
}
