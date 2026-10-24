import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  documentTitleOf,
  type DocumentTitleParts,
  tabIconOf,
  useDocumentTitle,
} from './use-document-title'

describe('documentTitleOf', () => {
  it.each([
    {
      name: 'project and page',
      projectName: 'Storefront',
      pageLabel: 'Tasks',
      expected: 'Storefront — Tasks · cezar',
    },
    {
      name: 'project only',
      projectName: 'Storefront',
      pageLabel: null,
      expected: 'Storefront · cezar',
    },
    {
      name: 'page only',
      projectName: null,
      pageLabel: 'Settings',
      expected: 'Settings · cezar',
    },
    { name: 'neither part', projectName: null, pageLabel: null, expected: 'cezar' },
    { name: 'empty project', projectName: '', pageLabel: 'Tasks', expected: 'Tasks · cezar' },
    { name: 'blank parts', projectName: '  ', pageLabel: '\t', expected: 'cezar' },
  ])('formats $name', ({ projectName, pageLabel, expected }) => {
    expect(documentTitleOf({ projectName, pageLabel })).toBe(expected)
  })

  it('uses the configured workspace name', () => {
    expect(documentTitleOf({ projectName: 'Storefront', pageLabel: 'Tasks', brandName: 'Acme Studio' }))
      .toBe('Storefront — Tasks · Acme Studio')
  })
})

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'cezar'
  })

  it('updates the existing writer when its truthful inputs change', () => {
    const initialProps: DocumentTitleParts = {
      projectName: 'Storefront',
      pageLabel: 'Tasks',
    }
    const { rerender } = renderHook(
      (parts: DocumentTitleParts) => useDocumentTitle(parts),
      { initialProps },
    )

    expect(document.title).toBe('Storefront — Tasks · cezar')
    rerender({ projectName: 'Back office', pageLabel: null })
    expect(document.title).toBe('Back office · cezar')
  })

  it('updates the tab icon to the instance logo and restores the product icon when cleared', () => {
    const { rerender } = renderHook((parts: DocumentTitleParts) => useDocumentTitle(parts), {
      initialProps: { projectName: null, pageLabel: null, brandLogoUrl: '/api/v1/workspace/branding-logo?v=abc' } as DocumentTitleParts,
    })
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!
    expect(icon.href).toContain('/api/v1/workspace/branding-logo?v=abc')
    rerender({ projectName: null, pageLabel: null, brandLogoUrl: null })
    expect(icon.getAttribute('href')).toBe('/icon.svg')
  })

  it('leaves the server-rendered favicon set alone while it names the favicon, and replaces it when that changes', () => {
    document.head.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
    for (const [href, sizes] of [['/api/v1/workspace/branding/favicon-32?v=1', '32x32'], ['/api/v1/workspace/branding/favicon?v=2', '']]) {
      const link = document.createElement('link')
      link.rel = 'icon'
      link.href = href!
      if (sizes) link.setAttribute('sizes', sizes)
      document.head.append(link)
    }
    const icons = () => [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map((link) => link.getAttribute('href'))
    const { rerender } = renderHook((parts: DocumentTitleParts) => useDocumentTitle(parts), {
      // Still loading: nothing is touched, not even by the logo the config already knows.
      initialProps: { projectName: null, pageLabel: null } as DocumentTitleParts,
    })
    expect(icons()).toHaveLength(2)
    rerender({ projectName: null, pageLabel: null, brandLogoUrl: '/logo?v=3', brandFaviconUrl: '/api/v1/workspace/branding/favicon?v=2' })
    expect(icons()).toHaveLength(2)
    rerender({ projectName: null, pageLabel: null, brandLogoUrl: '/logo?v=3', brandFaviconUrl: '/api/v1/workspace/branding/favicon?v=9' })
    expect(icons()).toEqual(['/api/v1/workspace/branding/favicon?v=9'])
    rerender({ projectName: null, pageLabel: null, brandLogoUrl: '/logo?v=3', brandFaviconUrl: null })
    expect(icons()).toEqual(['/logo?v=3'])
  })

  it('orders the tab icon like the server does: favicon, logo, app icon, then cezar\'s', () => {
    expect(tabIconOf({ brandFaviconUrl: '/f', brandLogoUrl: '/l', brandAppIconUrl: '/a' })).toBe('/f')
    expect(tabIconOf({ brandFaviconUrl: null, brandLogoUrl: '/l', brandAppIconUrl: '/a' })).toBe('/l')
    expect(tabIconOf({ brandFaviconUrl: null, brandLogoUrl: null, brandAppIconUrl: '/a' })).toBe('/a')
    expect(tabIconOf({})).toBe('/icon.svg')
  })
})
