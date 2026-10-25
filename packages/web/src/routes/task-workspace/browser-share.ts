import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'

import { MAX_BROWSER_COLUMN_WIDTH, MIN_BROWSER_COLUMN_WIDTH, type UiState } from '@open-mercato/cezar-api-client'
import { putUiState } from '@/api/client'
import { queryKeys, useUiState } from '@/api/queries'

import type { WorkspaceColumn } from './layout-state'

/** A divider drag is a stream of widths; the share is written once it rests. */
export const BROWSER_SHARE_SAVE_DEBOUNCE_MS = 600

/**
 * The project's Browser column share (spec 2026-10-24-cockpit-polish §3.2): what a NEW Browser
 * column opens at (`share`, absent → 45 % in `layout-state`), remembered in the per-repo ui-state
 * from the last divider drag that sized one. Only a drag counts — a layout that merely contains a
 * Browser (an equal split after a reorder) is not a preference.
 */
export function useBrowserColumnShare(): {
  share: number | undefined
  markResized: () => void
  observe: (columns: readonly WorkspaceColumn[] | undefined) => void
} {
  const queryClient = useQueryClient()
  const share = useUiState().data?.browserColumn?.width
  const resized = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const markResized = useCallback(() => {
    resized.current = true
  }, [])
  const observe = useCallback(
    (columns: readonly WorkspaceColumn[] | undefined) => {
      if (!resized.current || !columns || columns.length < 2) return
      const browser = columns.find((column) => column.view === 'browser')
      if (!browser) return
      const width = Math.min(MAX_BROWSER_COLUMN_WIDTH, Math.max(MIN_BROWSER_COLUMN_WIDTH, Math.round(browser.width * 100) / 100))
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        resized.current = false
        queryClient.setQueryData<UiState>(queryKeys.uiState, (prev) => ({ ...prev, browserColumn: { width } }))
        // A lost write forgets a width; the next Browser opens at the old one.
        putUiState({ browserColumn: { width } }).catch(() => {})
      }, BROWSER_SHARE_SAVE_DEBOUNCE_MS)
    },
    [queryClient],
  )
  return { share, markResized, observe }
}
