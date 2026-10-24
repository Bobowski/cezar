import { describe, expect, it } from 'vitest'

import { applyBrandAccent } from './brand-accent'

const TOKENS = {
  dark: { primary: '#9d94f5', primaryForeground: '#10190a', primaryStrong: '#b4adf7', ring: '#9d94f5' },
  light: { primary: '#7c3aed', primaryForeground: '#ffffff', primaryStrong: '#6d2ee0', ring: '#7c3aed' },
}

describe('applyBrandAccent', () => {
  it('stamps the custom properties index.css reads, and takes them all back', () => {
    const root = document.createElement('html')
    applyBrandAccent(TOKENS, root)
    expect(root.hasAttribute('data-brand-accent')).toBe(true)
    expect(root.style.getPropertyValue('--brand-dark-primary')).toBe('#9d94f5')
    expect(root.style.getPropertyValue('--brand-light-primary-strong')).toBe('#6d2ee0')
    expect(root.style.getPropertyValue('--brand-light-ring')).toBe('#7c3aed')
    applyBrandAccent(null, root)
    expect(root.hasAttribute('data-brand-accent')).toBe(false)
    expect(root.getAttribute('style') ?? '').toBe('')
  })
})
