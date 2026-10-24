import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { getRepoDesignDrafts, putRepoDesignDrafts } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { toast } from '@/components/ui/toaster'
import type { DesignDraftPick } from '@open-mercato/cezar-api-client'

import { parseDesignPick, pickLabel, type NewDesignPick } from '../task-thread/design-picks'
import type { DesignMark } from '../task-workspace/browser-view'
import { DRAFT_NOTES_MAX, NOTE_TEXT_MAX, type NotePick } from '../task-workspace/design-notes'

/**
 * Notes with no task behind them yet (spec `.ai/specs/2026-10-24-design-mode-third-cut.md` §3.2):
 * the Code page's Browser with no task chosen collects them, framed and numbered, in the
 * project's draft store (`/repo/design-drafts`), until **Start task with N notes** hands them to
 * the `/new` composer — or one is started alone.
 */

export interface ProjectDraft {
  key: string
  pick: NotePick
  text: string
}

interface Store {
  /** The project every read and write of this store addresses — never the scope at fire time. */
  scope: string
  /** `undefined` until the stored drafts arrived — before that an add would overwrite them. */
  drafts: ProjectDraft[] | undefined
  version: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | undefined
  chain: Promise<unknown>
  loading: boolean
  /** Bumped by every edit, so a save that lands knows whether it wrote the latest one. */
  edits: number
  /** The last save was refused: the notes on screen are not the stored ones. */
  unsaved: boolean
  failure: string | undefined
}

const stores = new Map<string, Store>()
const storeKey = (projectId: string | null) => projectId ?? ''
/** `'default'` is the server's alias for the boot project — the sentinel `queryScope()` uses. */
const apiScope = (projectId: string | null) => projectId ?? 'default'
function storeFor(projectId: string | null): Store {
  const key = storeKey(projectId)
  let store = stores.get(key)
  if (!store) {
    store = {
      scope: apiScope(projectId),
      drafts: undefined,
      version: 0,
      listeners: new Set(),
      timer: undefined,
      chain: Promise.resolve(),
      loading: false,
      edits: 0,
      unsaved: false,
      failure: undefined,
    }
    stores.set(key, store)
  }
  return store
}

/** Test seam. */
export function resetProjectDesignDrafts(): void {
  for (const store of stores.values()) clearTimeout(store.timer)
  stores.clear()
  pending = null
}

function publish(store: Store): void {
  store.version++
  store.listeners.forEach((listener) => listener())
}

const fromWire = (picks: readonly DesignDraftPick[]): ProjectDraft[] =>
  picks.flatMap((raw) => {
    const pick = parseDesignPick(raw)
    if (!pick || pick.mark === undefined) return []
    return [{ key: pick.mark, pick: { ...pick, mark: pick.mark }, text: raw.note.slice(0, NOTE_TEXT_MAX) }]
  })

const toWire = (drafts: readonly ProjectDraft[]): DesignDraftPick[] =>
  drafts.map((draft) => {
    const { source, ...pick } = draft.pick
    return { ...pick, ...(source ? { source } : {}), note: draft.text }
  })

function save(store: Store): void {
  clearTimeout(store.timer)
  store.timer = undefined
  const picks = toWire(store.drafts ?? [])
  const edit = store.edits
  store.chain = store.chain
    .catch(() => {})
    .then(() => putRepoDesignDrafts({ picks }, store.scope))
    .then(
      () => {
        if (store.edits !== edit || !store.unsaved) return
        store.unsaved = false
        store.failure = undefined
        publish(store)
      },
      (error: unknown) => {
        // The server's `{ error }` (e.g. a note over 100,000 characters), once per distinct refusal.
        const message = error instanceof Error && error.message ? error.message : 'the server refused them'
        if (!store.unsaved || store.failure !== message) toast(`Notes not saved: ${message}`, { tone: 'danger' })
        store.unsaved = true
        store.failure = message
        publish(store)
      },
    )
}

function persist(store: Store, delayMs: number): void {
  store.edits++
  clearTimeout(store.timer)
  store.timer = setTimeout(() => save(store), delayMs)
}

const pathOf = (url: string): string | undefined => {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

export interface ProjectDesignDrafts {
  drafts: ProjectDraft[]
  marks: DesignMark[]
  /** The last save failed; the notes stay on screen but are not stored. */
  unsaved: boolean
  draft: (key: string) => ProjectDraft | undefined
  add: (pick: NewDesignPick) => boolean
  setText: (key: string, text: string) => void
  discard: (key: string) => void
  /** Drop the drafts a started task took with it. */
  consume: (keys: readonly string[]) => void
}

export function useProjectDesignDrafts(): ProjectDesignDrafts {
  const { projectId } = useProjectScope()
  const store = storeFor(projectId)
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    },
    [store],
  )
  useSyncExternalStore(subscribe, () => store.version)

  // Leaving the project (or the page) writes a still-debounced edit now, to its own project.
  useEffect(() => () => { if (store.timer !== undefined) save(store) }, [store])

  useEffect(() => {
    if (store.drafts !== undefined || store.loading) return
    store.loading = true
    getRepoDesignDrafts(store.scope)
      .then((answer) => { store.drafts ??= fromWire(answer.picks) })
      // A cockpit that cannot read them still collects new ones, in memory.
      .catch(() => { store.drafts ??= [] })
      .finally(() => {
        store.loading = false
        publish(store)
      })
  }, [store])

  const add = useCallback(
    (pick: NewDesignPick): boolean => {
      if (store.drafts === undefined) {
        toast('Still loading — click the element again in a moment.')
        return false
      }
      if (pick.mark === undefined) return false
      if (store.drafts.some((draft) => draft.key === pick.mark)) return true
      if (store.drafts.length >= DRAFT_NOTES_MAX) {
        toast(`${DRAFT_NOTES_MAX} notes are already collected — start a task with them first.`, { tone: 'danger' })
        return false
      }
      store.drafts = [...store.drafts, { key: pick.mark, pick: { ...pick, mark: pick.mark }, text: '' }]
      publish(store)
      persist(store, 0)
      return true
    },
    [store],
  )
  const setText = useCallback(
    (key: string, text: string) => {
      if (!store.drafts?.some((draft) => draft.key === key)) return
      store.drafts = store.drafts.map((draft) => (draft.key === key ? { ...draft, text: text.slice(0, NOTE_TEXT_MAX) } : draft))
      publish(store)
      persist(store, 500)
    },
    [store],
  )
  const consume = useCallback(
    (keys: readonly string[]) => {
      if (!store.drafts) return
      const gone = new Set(keys)
      store.drafts = store.drafts.filter((draft) => !gone.has(draft.key))
      publish(store)
      persist(store, 0)
    },
    [store],
  )
  const discard = useCallback((key: string) => consume([key]), [consume])

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `store.version` is the store's change signal
  const drafts = useMemo(() => store.drafts ?? [], [store, store.version])
  const marks = useMemo<DesignMark[]>(
    () =>
      // Numbered in the order the task will list them (§3.2).
      drafts.map((draft, index) => ({
        key: draft.key,
        n: index + 1,
        selector: draft.pick.selector,
        path: pathOf(draft.pick.url),
        label: pickLabel(draft.pick),
        draft: true,
      })),
    [drafts],
  )
  const draft = useCallback((key: string) => drafts.find((each) => each.key === key), [drafts])
  return { drafts, marks, unsaved: store.unsaved, draft, add, setText, discard, consume }
}

/**
 * The hand-off to `/new` (§3.2): which drafts the composer's task text was built from, so that
 * starting the task consumes exactly those. Memory-only — a reload of `/new` keeps the text (the
 * composer's own draft) and merely leaves the notes collected.
 */
let pending: { scope: string; keys: string[] } | null = null

export function setPendingDesignStart(projectId: string | null, keys: readonly string[]): void {
  pending = { scope: storeKey(projectId), keys: [...keys] }
}

export function takePendingDesignStart(projectId: string | null): string[] {
  if (pending === null || pending.scope !== storeKey(projectId)) return []
  const { keys } = pending
  pending = null
  return keys
}

/** The task started: drop the drafts it took, whether or not the Code page is mounted. */
export async function consumeProjectDesignDrafts(projectId: string | null, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  const store = storeFor(projectId)
  const gone = new Set(keys)
  if (store.drafts !== undefined) {
    store.drafts = store.drafts.filter((draft) => !gone.has(draft.key))
    publish(store)
    clearTimeout(store.timer)
    store.timer = undefined
    const picks = toWire(store.drafts)
    await (store.chain = store.chain.catch(() => {}).then(() => putRepoDesignDrafts({ picks }, store.scope)))
    return
  }
  const answer = await getRepoDesignDrafts(store.scope)
  await putRepoDesignDrafts({ picks: answer.picks.filter((pick) => !gone.has(pick.mark ?? '')) }, store.scope)
}
