import { describe, expect, it } from 'vitest'

import { appAddress, keepableAddress, pageSuggestions, pageTitle, type CockpitLocation } from './code-pages'

const LOCAL: CockpitLocation = { protocol: 'http:', hostname: '127.0.0.1', port: '4800' }
const HOSTED: CockpitLocation = { protocol: 'https:', hostname: 'cez.example.com', port: '' }

describe('Code page addresses (spec 2026-10-24-code-page-browser-tabs §3 Scope)', () => {
  it('accepts loopback addresses, reading 0.0.0.0 as localhost', () => {
    expect(appAddress('http://localhost:3000/admin', LOCAL)).toEqual({ ok: true, url: 'http://localhost:3000/admin' })
    expect(appAddress('http://127.0.0.1:5173/', LOCAL)).toEqual({ ok: true, url: 'http://127.0.0.1:5173/' })
    expect(appAddress('http://[::1]:8080/', LOCAL)).toEqual({ ok: true, url: 'http://[::1]:8080/' })
    expect(appAddress('http://shop.localhost:3000/', LOCAL)).toEqual({ ok: true, url: 'http://shop.localhost:3000/' })
    expect(appAddress('http://0.0.0.0:3000/x', LOCAL)).toEqual({ ok: true, url: 'http://localhost:3000/x' })
  })

  it('rejects external sites, other schemes and the cockpit itself', () => {
    expect(appAddress('https://example.com/', LOCAL)).toEqual({ ok: false, reason: 'external' })
    expect(appAddress('http://127.0.0.1.example.com/', LOCAL)).toEqual({ ok: false, reason: 'external' })
    expect(appAddress('http://printer.local/', LOCAL)).toEqual({ ok: false, reason: 'external' })
    expect(appAddress('file:///etc/passwd', LOCAL)).toEqual({ ok: false, reason: 'external' })
    expect(appAddress('http://127.0.0.1:4800/p/default/code', LOCAL)).toEqual({ ok: false, reason: 'cockpit' })
    expect(appAddress('https://cez.example.com/', HOSTED)).toEqual({ ok: false, reason: 'cockpit' })
  })

  it('knows the cockpit under every loopback name for its host, on its port', () => {
    for (const url of ['http://localhost:4800/', 'http://[::1]:4800/', 'http://127.0.0.1:4800/', 'http://127.1:4800/', 'http://[::ffff:127.0.0.1]:4800/', 'http://0.0.0.0:4800/', 'http://shop.localhost:4800/']) {
      expect(appAddress(url, LOCAL)).toEqual({ ok: false, reason: 'cockpit' })
    }
    expect(appAddress('http://127.0.0.1:4800/', { protocol: 'http:', hostname: 'localhost', port: '4800' })).toEqual({ ok: false, reason: 'cockpit' })
    expect(appAddress('http://127.0.0.1:4800/', { protocol: 'http:', hostname: '[::1]', port: '4800' })).toEqual({ ok: false, reason: 'cockpit' })
    // Another port on loopback is the app, not the cockpit.
    expect(appAddress('http://localhost:4801/', LOCAL)).toEqual({ ok: true, url: 'http://localhost:4801/' })
  })

  it('accepts a gateway address on a hosted cockpit only: its own scheme and host, another port', () => {
    expect(appAddress('https://cez.example.com:8502/admin', HOSTED)).toEqual({ ok: true, url: 'https://cez.example.com:8502/admin' })
    expect(appAddress('http://cez.example.com:8502/', HOSTED)).toEqual({ ok: false, reason: 'external' })
    expect(appAddress('https://other.example.com:8502/', HOSTED)).toEqual({ ok: false, reason: 'external' })
    // A local cockpit has no gateway: 127.0.0.1 on another port is simply loopback.
    expect(appAddress('http://127.0.0.1:8502/', LOCAL)).toEqual({ ok: true, url: 'http://127.0.0.1:8502/' })
  })

  it('keeps only loopback addresses across a reload — never a gateway port or a blank', () => {
    expect(keepableAddress('http://localhost:3000/')).toBe(true)
    expect(keepableAddress('https://cez.example.com:8502/')).toBe(false)
    expect(keepableAddress('https://example.com/')).toBe(false)
    expect(keepableAddress('')).toBe(false)
    expect(keepableAddress(`http://localhost:3000/${'a'.repeat(2000)}`)).toBe(false)
  })

  it('titles a page by host:port and path, with the gateway port on a hosted cockpit', () => {
    expect(pageTitle('http://localhost:3000/')).toBe('localhost:3000')
    expect(pageTitle('http://localhost:3000/admin/orders')).toBe('localhost:3000/admin/orders')
    expect(pageTitle('http://localhost:3000/admin', 'https://cez.example.com:8502')).toBe('localhost:3000/admin → :8502')
    expect(pageTitle('')).toBe('Browser')
  })

  it('suggests detected addresses the bar would accept, each once', () => {
    expect(pageSuggestions(['http://localhost:3000/', 'http://0.0.0.0:3000/', 'https://example.com/', 'http://127.0.0.1:9000/'], LOCAL))
      .toEqual(['http://localhost:3000/', 'http://127.0.0.1:9000/'])
  })
})
