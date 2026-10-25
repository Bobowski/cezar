import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope, type Service, type ServicesState } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'
import { ServicesRoute, serviceStateLabel, serviceTone } from './services'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const service = (over: Partial<Service>): Service => ({
  id: 'api-1', name: 'api', command: 'yarn run dev', cwd: 'app', status: 'stopped', exitCode: null, reason: null,
  startedAt: null, urls: [], topic: null, ...over,
})
const STATE: ServicesState = {
  available: true,
  reason: null,
  services: [service({}), service({ id: 'web-1', name: 'web', status: 'exited', exitCode: 1, startedAt: null })],
  candidates: [
    { name: 'cms: dev', command: 'yarn run dev', cwd: 'app/cms', source: 'app/cms/package.json', detail: 'next dev', primary: true, unavailable: null },
    { name: 'compose', command: 'docker compose -f compose.yml up', cwd: '', source: 'compose.yml', detail: null, primary: true, unavailable: 'docker is not on PATH' },
    { name: 'app: lint', command: 'yarn run lint', cwd: 'app', source: 'app/package.json', detail: null, primary: false, unavailable: null },
  ],
  lastRunning: [],
  topic: 'services:p',
}

function setup(state: ServicesState = STATE) {
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.includes('/health')) return new Response('{}', { status: 503 })
    if (method === 'GET' || /start-all|stop-all|resume/.test(url)) return new Response(JSON.stringify(state), { status: 200 })
    if (method === 'POST' && url.endsWith('/services')) return new Response(JSON.stringify({ id: 'x', name: 'x', command: 'x', cwd: '' }), { status: 201 })
    return new Response(null, { status: 204 })
  }))
  // Radix parts in the sidebar (tooltips on the menu buttons) measure with a ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ShellWithSidebar><ServicesRoute /></ShellWithSidebar>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return calls
}
const sent = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.replace(/^.*\/services/, '/services')}`)

describe('Services page (spec 2026-10-11-project-services §4)', () => {
  it('says what each state means, and marks only a failure as one', () => {
    expect(serviceStateLabel(service({ status: 'running' }))).toBe('Running')
    expect(serviceStateLabel(service({ status: 'exited', exitCode: 2 }))).toBe('Exited with code 2')
    expect(serviceStateLabel(service({ status: 'exited', reason: 'app does not exist in this checkout' }))).toBe('Could not start — app does not exist in this checkout')
    expect(serviceTone(service({ status: 'exited', exitCode: 0 }))).toBe('neutral')
    expect(serviceTone(service({ status: 'exited', exitCode: 2 }))).toBe('danger')
    expect(serviceTone(service({ status: 'running' }))).toBe('success')
  })

  it('lists pins with their state and starts one', async () => {
    const calls = setup()
    await screen.findByRole('button', { name: 'Start api' })
    expect(screen.getByText('Exited with code 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start api' }))
    await waitFor(() => expect(sent(calls)).toEqual(['POST /services/api-1/start']))
  })

  it('offers long-running candidates first, pins one, and disables one whose tool is missing', async () => {
    const calls = setup()
    await screen.findByText('cms: dev')
    expect(screen.queryByText('app: lint')).toBeNull()
    expect((screen.getByRole('button', { name: 'Pin compose' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('docker is not on PATH')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pin cms: dev' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toBe(JSON.stringify({ name: 'cms: dev', command: 'yarn run dev', cwd: 'app/cms' })))
    fireEvent.click(screen.getByRole('button', { name: /Show all scripts/ }))
    expect(screen.getByText('app: lint')).toBeTruthy()
  })

  it('adds a custom command, named after itself when no name is given', async () => {
    const calls = setup()
    await screen.findByRole('button', { name: 'Start api' })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'stripe listen --forward-to localhost:9000' } })
    fireEvent.change(screen.getByLabelText('Directory'), { target: { value: '/app/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toBe(JSON.stringify({ name: 'stripe listen', command: 'stripe listen --forward-to localhost:9000', cwd: 'app' })))
  })

  it('offers Resume after a restart and starts nothing until it is clicked', async () => {
    const calls = setup({ ...STATE, lastRunning: ['api-1', 'web-1'] })
    await screen.findByText('2 services were running when cezar last stopped.')
    expect(sent(calls)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(sent(calls)).toEqual(['POST /services/resume']))
  })

  it('shows the reason and nothing else where services are not allowed', async () => {
    setup({ available: false, reason: 'services are disabled on this cockpit — it is off in hosted mode unless CEZ_TERMINAL=1', services: [], candidates: [], lastRunning: [], topic: 'services:p' })
    expect((await screen.findByRole('note')).textContent).toContain('services are disabled')
    expect(screen.queryByLabelText('Command')).toBeNull()
  })

  it('keeps the lists in the contextual sidebar and the selected service in the main area', async () => {
    setup()
    await screen.findByText('cms: dev')
    const sidebar = document.querySelector('[data-slot="context-sidebar-body"]') as HTMLElement
    expect(sidebar.querySelector('[aria-label="Pinned services"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-slot="services-candidates"]')).not.toBeNull()
    expect(sidebar.querySelector('[aria-label="Command"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-slot="service-log"]')).toBeNull()
    // The first pin is selected: its name, command and state head the main area.
    const detail = document.querySelector('[data-slot="service-detail"]') as HTMLElement
    expect(detail.textContent).toContain('api')
    expect(detail.textContent).toContain('yarn run dev')
    // Picking another one in the sidebar changes what the main area is about.
    fireEvent.click(screen.getByText('web'))
    await waitFor(() => expect(document.querySelector('[data-slot="service-detail"]')?.textContent).toContain('Exited with code 1'))
  })

  it('takes the screen with the selected service and gives it back (cockpit-polish §3.3)', async () => {
    setup()
    await screen.findByText('cms: dev')
    const region = () => document.querySelector<HTMLElement>('[data-fullscreen-region="Scripts"]')!
    expect(region().contains(document.querySelector('[data-slot="service-detail"]'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Full screen Scripts' }))
    expect(region().getAttribute('data-fullscreen')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(region().getAttribute('data-fullscreen')).toBeNull()
  })
})
