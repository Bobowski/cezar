import { useEffect } from 'react'
import type { BrandingAccentTokens } from '@open-mercato/cezar-api-client'

/**
 * The operator's accent, applied live (spec 2026-10-24-cockpit-branding). The shell arrives with it
 * already stamped by the server (`renderShellHtml`); this keeps `<html>` in step when Settings
 * changes it, using the same custom properties `index.css`'s `[data-brand-accent]` rules read.
 */
const PROPERTIES = [
  ['primary', 'primary'],
  ['primary-foreground', 'primaryForeground'],
  ['primary-strong', 'primaryStrong'],
  ['ring', 'ring'],
] as const

export function applyBrandAccent(tokens: BrandingAccentTokens | null, root: HTMLElement = document.documentElement): void {
  for (const theme of ['dark', 'light'] as const) {
    for (const [name, key] of PROPERTIES) {
      if (tokens) root.style.setProperty(`--brand-${theme}-${name}`, tokens[theme][key])
      else root.style.removeProperty(`--brand-${theme}-${name}`)
    }
  }
  if (tokens) root.setAttribute('data-brand-accent', '')
  else root.removeAttribute('data-brand-accent')
}

/** `undefined` = not loaded yet, so whatever the server stamped stands. */
export function useBrandAccent(tokens: BrandingAccentTokens | null | undefined): void {
  useEffect(() => {
    if (tokens !== undefined) applyBrandAccent(tokens)
  }, [tokens])
}
