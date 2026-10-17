import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope, type DockerState } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'
import { DockerRoute } from './docker-view'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const DOCKER: DockerState = {
  available: true,
  reason: null,
  topic: 'docker',
  stacks: [
    {
      name: 'shop-a', dir: '/srv/shop-a', project: { id: 'a', name: 'Shop A' }, mine: true,
      containers: [{ id: 'a'.repeat(12), name: 'shop-a-redis-1', service: 'redis', image: 'redis:7', running: false, status: 'Exited (0)', ports: [] }],
    },
    {
      name: 'shop-b', dir: '/srv/shop-b', project: { id: 'b', name: 'Shop B' }, mine: false,
      containers: [{ id: 'b'.repeat(12), name: 'shop-b-postgres-1', service: 'postgres', image: 'postgres:16', running: true, status: 'Up 2 hours', ports: [{ host: 5432, container: 5432, protocol: 'tcp' }] }],
    },
  ],
  conflicts: [{ port: 5432, service: 'db', file: 'compose.yml', stack: 'shop-b', container: 'shop-b-postgres-1' }],
}
const SERVICES = { available: true, reason: null, services: [], candidates: [], lastRunning: [], topic: 'services:p' }

function setup(docker: DockerState = DOCKER, entry = '/docker') {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    if (url.includes('/health')) return new Response('{}', { status: 503 })
    if (method !== 'GET') { calls.push(`${method} ${url.replace(/^.*\/docker/, '/docker')}`); return new Response(null, { status: 204 }) }
    return new Response(JSON.stringify(url.includes('/docker') ? docker : SERVICES), { status: 200 })
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <ShellWithSidebar><DockerRoute /></ShellWithSidebar>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}

describe('Docker page (spec 2026-10-13-docker-view)', () => {
  it('shows every stack with its owner, and which port this project cannot have', async () => {
    setup()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('A port this project needs is taken')
    expect(alert.textContent).toContain('shop-b-postgres-1')
    const cards = [...document.querySelectorAll('[data-slot="docker-stack"]')]
    expect(cards.map((card) => card.getAttribute('data-stack'))).toEqual(['shop-a', 'shop-b'])
    expect(cards[0]?.textContent).toContain('This project')
    expect(cards[1]?.textContent).toContain('Shop B')
    expect(cards[1]?.textContent).toContain('5432')
  })

  it('stops the stack that holds the port, and starts a single container', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop shop-b' }))
    await waitFor(() => expect(calls).toEqual(['POST /docker/stacks/shop-b/stop']))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Start shop-a-redis-1' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Start shop-a-redis-1' }))
    await waitFor(() => expect(calls[1]).toBe(`POST /docker/containers/${'a'.repeat(12)}/start`))
  })

  it('narrows to one stack from the sidebar', async () => {
    setup()
    await screen.findByRole('alert')
    const sidebar = document.querySelector('[data-slot="context-sidebar-body"]') as HTMLElement
    fireEvent.click(sidebar.querySelector('[aria-label="Docker stacks"]')!.querySelectorAll('button')[2]!)
    await waitFor(() => expect([...document.querySelectorAll('[data-slot="docker-stack"]')].map((card) => card.getAttribute('data-stack'))).toEqual(['shop-b']))
  })

  it('says why when Docker cannot be read', async () => {
    setup({ available: false, reason: 'Docker is installed, but its daemon is not running', stacks: [], conflicts: [], topic: 'docker' })
    expect((await screen.findByRole('note')).textContent).toBe('Docker is installed, but its daemon is not running')
  })

})
