import { vi } from 'vitest'

/** The phone the jsdom suites render at (spec 2026-10-24-mobile-cockpit §8): an iPhone's width. */
export const PHONE_WIDTH = 375

/**
 * A viewport of `width`: `window.innerWidth` plus a `matchMedia` answering min/max-width queries
 * against it — exactly what `use-mobile.ts` and `useIsDesktop` read. jsdom has no layout, so this
 * is a width, not a reflow; undo with `vi.unstubAllGlobals()`.
 */
export function stubViewport(width: number = PHONE_WIDTH): void {
  ;(window as { innerWidth: number }).innerWidth = width
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query)
    const max = /\(max-width:\s*(\d+)px\)/.exec(query)
    const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : query.includes('hover: none')
    return {
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }
  })
}

export function resetViewport(): void {
  ;(window as { innerWidth: number }).innerWidth = 1024
}
