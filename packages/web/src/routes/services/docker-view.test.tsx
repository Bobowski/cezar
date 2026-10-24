import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  setApiScope, type DockerDisk, type DockerImages, type DockerReclaimPlan, type DockerState, type DockerVolumes,
} from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ShellWithSidebar } from '@/test/shell-with-sidebar'
import type { TerminalIo, TerminalPaneSession } from '@/routes/task-workspace/terminal-pane'
import { DockerRoute } from './docker-view'

// The emulator is not what is under test: a pane that reads once and prints what it got.
vi.mock('@/routes/task-workspace/terminal-pane', () => ({
  TerminalPane: ({ io, session }: { io: TerminalIo; session: TerminalPaneSession }) => {
    const [text, setText] = useState('')
    useEffect(() => { void io.read(0).then((read) => setText(read.data)) }, [io])
    return <pre data-slot="fake-terminal" data-session={session.id}>{text}</pre>
  },
}))

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const A = 'a'.repeat(12)
const B = 'b'.repeat(12)
const DOCKER: DockerState = {
  available: true,
  reason: null,
  topic: 'docker',
  stacks: [
    {
      name: 'shop-a', dir: '/srv/shop-a', project: { id: 'a', name: 'Shop A' }, mine: true, dirState: 'exists', task: null, volumes: [],
      containers: [{ id: A, name: 'shop-a-redis-1', service: 'redis', image: 'redis:7', running: false, status: 'Exited (0)', ports: [] }],
    },
    {
      name: 'shop-b', dir: '/srv/shop-a/.ai/cezar/worktrees/r1', project: { id: 'b', name: 'Shop B' }, mine: false, dirState: 'exists',
      task: { id: 'r1', title: 'ffp-570', status: 'running', active: true }, volumes: ['shop-b_pg'],
      containers: [{ id: B, name: 'shop-b-postgres-1', service: 'postgres', image: 'postgres:16', running: true, status: 'Up 2 hours', ports: [{ host: 5432, container: 5432, protocol: 'tcp' }] }],
    },
  ],
  conflicts: [{ port: 5432, service: 'db', file: 'compose.yml', stack: 'shop-b', container: 'shop-b-postgres-1' }],
}
const IMAGES: DockerImages = {
  available: true, reason: null,
  images: [
    { id: '1a'.repeat(32), tags: ['postgres:16'], sizeBytes: 649e6, created: '2025-11-12', dangling: false, usedBy: [{ id: B, name: 'shop-b-postgres-1', running: true }] },
    { id: '3c'.repeat(32), tags: [], sizeBytes: 120e6, created: '2025-11-19', dangling: true, usedBy: [] },
  ],
}
const VOLUMES: DockerVolumes = {
  available: true, reason: null,
  volumes: [
    { name: 'shop-b_pg', driver: 'local', sizeBytes: 48e6, stack: 'shop-b', project: { id: 'b', name: 'Shop B' }, mine: false, usedBy: [{ id: B, name: 'shop-b-postgres-1', running: true }] },
    { name: 'ffp-3900_pg', driver: 'local', sizeBytes: 330e6, stack: 'ffp-3900', project: null, mine: false, usedBy: [] },
    { name: 'scratch', driver: 'local', sizeBytes: 0, stack: null, project: null, mine: false, usedBy: [] },
    { name: 'unsized', driver: 'local', sizeBytes: null, stack: null, project: null, mine: false, usedBy: [] },
  ],
}
const DISK: DockerDisk = {
  available: true, reason: null, totalBytes: 41e9, reclaimableBytes: 12e9, warning: true,
  dataRoot: { path: '/var/lib/docker', sizeBytes: 100e9, freeBytes: 10e9, usedPct: 90 },
  entries: [
    { kind: 'images', count: 5, active: 3, totalBytes: 20e9, reclaimableBytes: 2e9 },
    { kind: 'containers', count: 6, active: 4, totalBytes: 1e9, reclaimableBytes: 0 },
    { kind: 'volumes', count: 6, active: 3, totalBytes: 10e9, reclaimableBytes: 4e9 },
    { kind: 'build-cache', count: 21, active: 0, totalBytes: 10e9, reclaimableBytes: 6e9 },
  ],
}
const PLAN: DockerReclaimPlan = {
  available: true, reason: null, totalBytes: 7.4e9,
  items: [
    { step: { kind: 'dangling-images' }, label: '1 dangling image', detail: null, bytes: 120e6 },
    { step: { kind: 'build-cache' }, label: 'Build cache', detail: null, bytes: 6e9 },
    { step: { kind: 'stack', name: 'ffp-4100' }, label: 'Stack ffp-4100 — /srv/x is gone', detail: '2 containers · volumes ffp-4100_pg', bytes: 1.28e9 },
  ],
}
const SERVICES = { available: true, reason: null, services: [], candidates: [], lastRunning: [], topic: 'services:p' }
const HEALTH = { version: 't', repoRoot: '/srv', repo: { root: '/srv', branch: 'main' }, checks: [], defaultRunner: 'claude', capabilities: { terminal: true } }

function setup(docker: DockerState = DOCKER, entry = '/docker') {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    const path = url.replace(/^.*?\/docker/, '/docker')
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/health')) return ok(HEALTH)
    if (url.includes('/docker/reclaim/plan')) return ok(PLAN)
    if (method !== 'GET') {
      calls.push(`${method} ${path}${init?.body ? ` ${String(init.body)}` : ''}`)
      if (url.includes('/docker/reclaim')) return ok({ freedBytes: 6.12e9, log: ['1 dangling image: done', 'Build cache: done'] })
      if (url.includes('/repo/terminal')) return ok({ id: 's1', runId: '', cwd: '/srv', shell: 'bash', cols: 80, rows: 24, startedAt: '', exitCode: null, label: 'bash', busy: false, topic: 'terminal:s1' })
      return url.includes('/start') || url.includes('/stop') ? new Response(null, { status: 204 }) : ok({ ok: true })
    }
    if (url.includes('/logs')) {
      calls.push(`GET ${path}`)
      return ok({ data: 'boot\nready\n', cursor: 11, truncated: false, following: true, topic: `docker-logs:${A}` })
    }
    if (url.includes('/docker/images')) return ok(IMAGES)
    if (url.includes('/docker/volumes')) return ok(VOLUMES)
    if (url.includes('/docker/disk')) return ok(DISK)
    return ok(url.includes('/docker') ? docker : SERVICES)
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
const confirmDialog = () => screen.findByRole('alertdialog')

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
    expect(cards[1]?.textContent).toContain('task ffp-570')
    expect(cards[1]?.textContent).toContain('5432')
  })

  it('stops the stack that holds the port, and starts a single container', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop shop-b' }))
    await waitFor(() => expect(calls).toEqual(['POST /docker/stacks/shop-b/stop']))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Start shop-a-redis-1' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Start shop-a-redis-1' }))
    await waitFor(() => expect(calls[1]).toBe(`POST /docker/containers/${A}/start`))
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

describe('Docker management (spec 2026-10-23-docker-management)', () => {
  it('downs a stack after a confirm that names the running task, with its volumes on the checkbox', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Down shop-b' }))
    const dialog = await confirmDialog()
    expect(within(dialog).getByText('task ffp-570 is running in it')).toBeTruthy()
    expect(dialog.querySelector('[data-slot="docker-confirm-option-names"]')).toBeNull()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    expect(dialog.querySelector('[data-slot="docker-confirm-option-names"]')?.textContent).toBe('shop-b_pg')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Down' }))
    await waitFor(() => expect(calls).toEqual(['POST /docker/stacks/shop-b/down {"volumes":true}']))
  })

  it('force-removes a running container, and says it is running', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove shop-b-postgres-1' }))
    const dialog = await confirmDialog()
    expect(dialog.textContent).toContain('shop-b-postgres-1 is running')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove container' }))
    await waitFor(() => expect(calls).toEqual([`DELETE /docker/containers/${B}?force=1`]))
  })

  it('lists images with who uses them, filters dangling ones, and stops a running user before removing its image', async () => {
    const calls = setup(DOCKER, '/docker?tab=images')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="docker-image"]')).toHaveLength(2))
    fireEvent.click(screen.getByRole('radio', { name: 'Dangling' }))
    await waitFor(() => expect(document.querySelectorAll('[data-slot="docker-image"]')).toHaveLength(1))
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove postgres:16' }))
    const dialog = await confirmDialog()
    expect(dialog.querySelector('[data-slot="docker-confirm-items"]')?.textContent).toContain('shop-b-postgres-1 (running)')
    // Docker refuses `rm -f` of an image a running container uses: the confirm says it is stopped first.
    expect(dialog.textContent).toContain('it is stopped first, then the image is removed')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop and remove image' }))
    await waitFor(() => expect(calls).toEqual([`DELETE /docker/images/${'1a'.repeat(32)}?force=1`]))
  })

  it('removes an unused image without stopping anything', async () => {
    const calls = setup(DOCKER, '/docker?tab=images')
    fireEvent.click(await screen.findByRole('button', { name: `Remove <none> ${'3c'.repeat(6)}` }))
    const dialog = await confirmDialog()
    expect(dialog.textContent).toContain('Nothing uses it.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove image' }))
    await waitFor(() => expect(calls).toEqual([`DELETE /docker/images/${'3c'.repeat(32)}`]))
  })

  it('asks to type the name only for a volume with data and no container', async () => {
    const calls = setup(DOCKER, '/docker?tab=volumes')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete shop-b_pg' }))
    let dialog = await confirmDialog()
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    // Docker refuses a mounted volume even with -f: the confirm says its container goes first.
    expect(dialog.textContent).toContain('the container below is removed first (rm -f), then the volume')
    expect(within(dialog).getByRole('button', { name: 'Remove containers and volume' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Delete scratch' }))
    dialog = await confirmDialog()
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // A size Docker did not report may be data: unknown is never taken for empty.
    fireEvent.click(screen.getByRole('button', { name: 'Delete unsized' }))
    dialog = await confirmDialog()
    expect(within(dialog).queryByRole('textbox')).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Delete ffp-3900_pg' }))
    dialog = await confirmDialog()
    const remove = within(dialog).getByRole('button', { name: 'Delete volume' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'ffp-3900_pg' } })
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    await waitFor(() => expect(calls).toEqual(['DELETE /docker/volumes/ffp-3900_pg']))
  })

  it('shows disk usage with its warning, and Reclaims only the lines left checked', async () => {
    const calls = setup(DOCKER, '/docker?tab=disk')
    expect((await screen.findByText('Docker 41 GB, 12 GB reclaimable')).tagName).toBeTruthy()
    expect(document.querySelector('[data-slot="docker-disk-warning"]')?.textContent).toContain('90 % full')
    expect(document.querySelectorAll('[data-slot="docker-disk-entry"]')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /Reclaim/ }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.querySelectorAll('[data-slot="docker-reclaim-item"]')).toHaveLength(3))
    fireEvent.click(within(dialog).getAllByRole('checkbox')[2]!)
    fireEvent.click(within(dialog).getByRole('button', { name: /^Reclaim / }))
    await waitFor(() => expect(calls).toEqual(['POST /docker/reclaim {"steps":[{"kind":"dangling-images"},{"kind":"build-cache"}]}']))
    expect((await within(dialog).findByText('Freed 6.1 GB.')).textContent).toBe('Freed 6.1 GB.')
  })

  it('opens a container’s logs in the log pane', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Logs of shop-a-redis-1' }))
    const pane = await waitFor(() => {
      const found = document.querySelector('[data-slot="fake-terminal"]')
      expect(found?.textContent).toBe('boot\r\nready\r\n')
      return found
    })
    expect(pane?.getAttribute('data-session')).toBe(`docker-logs:${A}`)
    expect(calls).toEqual([`GET /docker/containers/${A}/logs?cursor=0`])
  })

  it('Exec opens a cockpit terminal with docker exec typed into it', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Exec into shop-b-postgres-1' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]).toMatch(/^POST .*\/repo\/terminal \{\}$/)
    expect(calls[1]).toContain(`docker exec -it ${B} sh -c`)
    // A stopped container has nothing to exec into.
    expect((screen.getByRole('button', { name: 'Exec into shop-a-redis-1' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
