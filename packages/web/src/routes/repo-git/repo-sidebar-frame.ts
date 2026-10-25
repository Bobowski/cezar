import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import {
  DEFAULT_REPO_SIDEBAR_WIDTH,
  MAX_REPO_SIDEBAR_WIDTH,
  MIN_REPO_SIDEBAR_WIDTH,
  type RepoLayout,
  type UiState,
} from '@open-mercato/cezar-api-client'
import { putUiState } from '@/api/client'
import { queryKeys, useUiState } from '@/api/queries'
import type { ContextSidebarFrame } from '@/components/context-sidebar'

/**
 * The Git sidebar's frame (spec 2026-10-24-cockpit-polish §3.1): width and fold, per project, in
 * the per-repo ui-state's `repo` block. Its own module, outside the Git chunk, because the
 * route's loading fallback fills the same column and must not pop it to another width.
 */

/** A width as the ui-state schema accepts it, or the default. */
export function clampRepoSidebarWidth(raw: unknown): number {
  const width = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(width)) return DEFAULT_REPO_SIDEBAR_WIDTH
  return Math.min(MAX_REPO_SIDEBAR_WIDTH, Math.max(MIN_REPO_SIDEBAR_WIDTH, Math.round(width)))
}

/** The stored layout, salvaged field by field; absent → the shell's own 18rem, open. */
export function repoLayoutOf(state: UiState | undefined): RepoLayout {
  const stored = state?.repo
  return {
    width: clampRepoSidebarWidth(stored?.width),
    collapsed: stored?.collapsed === true,
  }
}

/** How long a drag must rest before its width is written — a drag is a stream of widths. */
export const REPO_WIDTH_SAVE_DEBOUNCE_MS = 400

/**
 * The cache is patched at once so the column follows the pointer; the server write waits for the
 * drag to rest. Memoised on the values: the shell re-reads the frame whenever its identity changes.
 */
export function useRepoSidebarFrame(): ContextSidebarFrame {
  const queryClient = useQueryClient()
  const uiState = useUiState()
  const { width, collapsed } = repoLayoutOf(uiState.data)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<RepoLayout | null>(null)
  // Leaving mid-drag still keeps the width: the pending write goes out now rather than never.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current) putUiState({ repo: pending.current }).catch(() => {})
    },
    [],
  )

  const write = useCallback(
    (next: RepoLayout, delay: number) => {
      queryClient.setQueryData<UiState>(queryKeys.uiState, (prev) => ({ ...prev, repo: next }))
      if (timer.current) clearTimeout(timer.current)
      pending.current = next
      timer.current = setTimeout(() => {
        timer.current = null
        pending.current = null
        // A lost write only forgets a width; the column keeps working from the cache.
        putUiState({ repo: next }).catch(() => {})
      }, delay)
    },
    [queryClient],
  )
  const onWidthChange = useCallback(
    (next: number) => write({ width: clampRepoSidebarWidth(next), collapsed: false }, REPO_WIDTH_SAVE_DEBOUNCE_MS),
    [write],
  )
  const onCollapsedChange = useCallback((next: boolean) => write({ width, collapsed: next }, 0), [width, write])

  return useMemo(
    () => ({
      width,
      collapsed,
      onWidthChange,
      onCollapsedChange,
      minWidth: MIN_REPO_SIDEBAR_WIDTH,
      maxWidth: MAX_REPO_SIDEBAR_WIDTH,
      defaultWidth: DEFAULT_REPO_SIDEBAR_WIDTH,
    }),
    [collapsed, onCollapsedChange, onWidthChange, width],
  )
}
