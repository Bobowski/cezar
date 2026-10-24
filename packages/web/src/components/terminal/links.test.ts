import { describe, expect, it } from 'vitest'

import { findBareAddresses, findSchemedLinks, linkTarget } from './links'
import { gatewayHref } from './gateway'
import { tunnelCommand, tunnelPorts } from './tunnel'

const texts = (found: Array<{ text: string }>) => found.map((link) => link.text)

describe('terminal links (spec 2026-10-24-code-page-terminal §3.2)', () => {
  it('finds schemed URLs, leaving a sentence\'s punctuation behind', () => {
    expect(texts(findSchemedLinks('  ➜  Local:   http://localhost:5173/'))).toEqual(['http://localhost:5173/'])
    expect(texts(findSchemedLinks('see https://vitejs.dev/config. Or (http://127.0.0.1:8000/api).'))).toEqual([
      'https://vitejs.dev/config',
      'http://127.0.0.1:8000/api',
    ])
    expect(texts(findSchemedLinks('IPv6: http://[::1]:4000/x'))).toEqual(['http://[::1]:4000/x'])
  })

  it('finds a loopback address printed without a scheme, and not inside a schemed one', () => {
    expect(texts(findBareAddresses('ready on localhost:3000'))).toEqual(['localhost:3000'])
    expect(texts(findBareAddresses('listening on 0.0.0.0:9000/app, 127.0.0.1:8000.'))).toEqual(['0.0.0.0:9000/app', '127.0.0.1:8000'])
    expect(texts(findBareAddresses('bound [::1]:4000'))).toEqual(['[::1]:4000'])
    expect(findBareAddresses('http://localhost:3000')).toEqual([])
    expect(findBareAddresses('git@localhost:22 and mylocalhost:3000')).toEqual([])
    // A port is what makes it an address worth opening.
    expect(findBareAddresses('localhost is up')).toEqual([])
  })

  it('opens loopback and gateway addresses in the Code Browser, anything else in a new window', () => {
    const cockpit = { hostname: 'agents.example.dev', port: '' }
    expect(linkTarget('localhost:3000', cockpit)).toEqual({ kind: 'browser', url: 'http://localhost:3000/' })
    expect(linkTarget('0.0.0.0:5173/admin', cockpit)).toEqual({ kind: 'browser', url: 'http://localhost:5173/admin' })
    expect(linkTarget('http://[::1]:4000', cockpit)).toEqual({ kind: 'browser', url: 'http://[::1]:4000/' })
    expect(linkTarget('https://agents.example.dev:8503/', cockpit)).toEqual({ kind: 'browser', url: 'https://agents.example.dev:8503/' })
    // The cockpit itself is not its own app.
    expect(linkTarget('https://agents.example.dev/p/x', cockpit)?.kind).toBe('external')
    expect(linkTarget('https://docs.npmjs.com/cli', cockpit)).toEqual({ kind: 'external', url: 'https://docs.npmjs.com/cli' })
    expect(linkTarget('javascript:void(0)', cockpit)).toBeNull()
  })
})

describe('gateway and tunnel (spec §3.4)', () => {
  it('loads a gateway page with its one-load ticket, path kept', () => {
    expect(gatewayHref('http://localhost:3570/products?page=2', { origin: 'https://agents.example.dev:8503', ticket: 'abc', ticketParam: 'cezar_ticket' }))
      .toBe('https://agents.example.dev:8503/products?page=2&cezar_ticket=abc')
  })

  it('forwards every loopback port on its own number, and nothing when there is nothing to tunnel', () => {
    const ports = tunnelPorts(['http://localhost:9000/app', 'http://localhost:3570', 'http://localhost:9000', 'https://example.com:8443'])
    expect(ports).toEqual([3570, 9000])
    expect(tunnelCommand(ports, 'agents.example.dev', 'kinel')).toBe('ssh -N -L 3570:localhost:3570 -L 9000:localhost:9000 kinel@agents.example.dev')
    expect(tunnelCommand(ports, 'agents.example.dev')).toBe('ssh -N -L 3570:localhost:3570 -L 9000:localhost:9000 agents.example.dev')
    expect(tunnelCommand([], 'agents.example.dev', 'kinel')).toBeNull()
    // A cockpit opened at localhost is on this machine already.
    expect(tunnelCommand(ports, 'localhost', 'kinel')).toBeNull()
  })
})
