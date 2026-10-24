import { useEffect } from 'react'

export interface DocumentTitleParts {
  projectName: string | null
  pageLabel: string | null
  brandName?: string | null
  brandLogoUrl?: string | null
  /** The uploaded favicon (spec 2026-10-24-cockpit-branding). `undefined` = not loaded yet. */
  brandFaviconUrl?: string | null
  brandAppIconUrl?: string | null
}

function titlePart(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The browser-tab grammar, kept pure so loading and fallback states are exhaustive in tests. */
export function documentTitleOf({ projectName, pageLabel, brandName }: DocumentTitleParts): string {
  const project = titlePart(projectName)
  const page = titlePart(pageLabel)
  const brand = titlePart(brandName ?? null) ?? 'cezar'

  if (project && page) return `${project} — ${page} · ${brand}`
  if (project) return `${project} · ${brand}`
  if (page) return `${page} · ${brand}`
  return brand
}

/** The tab icon, in the server's order (`brandingLinks`): favicon, then logo, then app icon, then cezar's. */
export function tabIconOf(parts: Pick<DocumentTitleParts, 'brandFaviconUrl' | 'brandLogoUrl' | 'brandAppIconUrl'>): string {
  return parts.brandFaviconUrl ?? parts.brandLogoUrl ?? parts.brandAppIconUrl ?? '/icon.svg'
}

/** The cockpit's single runtime document-title writer. */
export function useDocumentTitle(parts: DocumentTitleParts): void {
  const title = documentTitleOf(parts)
  useEffect(() => {
    document.title = title
  }, [title])
  const { brandFaviconUrl, brandLogoUrl, brandAppIconUrl } = parts
  useEffect(() => {
    // Nothing known yet: the links the server rendered into the shell stand.
    if (brandFaviconUrl === undefined && brandLogoUrl === undefined) return
    const wanted = tabIconOf({ brandFaviconUrl, brandLogoUrl, brandAppIconUrl })
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')]
    // The server's set (PNG sizes + SVG) already names it; a change replaces the set with one link.
    if (links.some((link) => link.href === new URL(wanted, document.baseURI).href)) return
    let icon = links[0]
    for (const extra of links.slice(1)) extra.remove()
    if (!icon) {
      icon = document.createElement('link')
      icon.rel = 'icon'
      document.head.append(icon)
    }
    icon.href = wanted
    icon.removeAttribute('sizes')
    icon.type = wanted === '/icon.svg' ? 'image/svg+xml' : ''
  }, [brandFaviconUrl, brandLogoUrl, brandAppIconUrl])
}
