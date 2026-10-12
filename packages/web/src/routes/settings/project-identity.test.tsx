import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ProjectIcon, projectIconUrl } from '@/components/project-icon'
import { ProjectIdentity } from './project-identity'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const PROJECT: ProjectListEntry = {
  id: 'wrap-creators', name: 'WRAP-CREATORS', root: '/work/WRAP-CREATORS', addedAt: '2026-10-01T00:00:00Z', lastOpenedAt: '2026-10-12T00:00:00Z',
  source: 'local', status: 'ok',
}

function setup(project: ProjectListEntry = PROJECT, candidates: string[] = ['public/favicon.svg']) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    if (url.endsWith('/icon-candidates')) return new Response(JSON.stringify({ candidates }), { status: 200 })
    if (url.endsWith('/projects')) return new Response(JSON.stringify({ projects: [project], bootProject: project.id, projectsDir: '/work' }), { status: 200 })
    return new Response(JSON.stringify({ project: { ...project, name: 'Wrap Creators', icon: 'wrap-creators-0123456789ab.png' } }), { status: 200 })
  }))
  render(<QueryClientProvider client={createQueryClient()}><ProjectIdentity project={project} /></QueryClientProvider>)
  return calls
}
const sent = (calls: { method: string; url: string; body?: unknown }[]) => calls.filter((call) => call.method !== 'GET')

describe('Project identity settings (spec 2026-10-12-project-identity)', () => {
  it('renames the project, and only when the name actually changed', async () => {
    const calls = setup()
    const save = screen.getByRole('button', { name: 'Save name' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    // The folder's own name is in use, so there is nothing to reset to.
    expect(screen.queryByRole('button', { name: 'Use the folder’s name' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Wrap Creators ' } })
    fireEvent.click(save)
    await waitFor(() => expect(sent(calls)).toEqual([{ method: 'PATCH', url: '/api/v1/projects/wrap-creators', body: { name: 'Wrap Creators' } }]))
  })

  it('offers to go back to the folder\'s name once it differs', async () => {
    const calls = setup({ ...PROJECT, name: 'Wrap Creators' })
    fireEvent.click(screen.getByRole('button', { name: 'Use the folder’s name' }))
    await waitFor(() => expect(sent(calls)[0]).toEqual({ method: 'PATCH', url: '/api/v1/projects/wrap-creators', body: { name: null } }))
  })

  it('uploads an image as the icon', async () => {
    const calls = setup()
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Icon file'), { target: { files: [file] } })
    await waitFor(() => expect(sent(calls)).toEqual([{ method: 'PUT', url: '/api/v1/projects/wrap-creators/icon', body: { data: 'iVBORw==' } }]))
  })

  it('uses a favicon found in the repository, and removes an icon that is set', async () => {
    const calls = setup({ ...PROJECT, icon: 'wrap-creators-0123456789ab.png' })
    fireEvent.click(await screen.findByRole('button', { name: 'Use public/favicon.svg' }))
    await waitFor(() => expect(sent(calls)[0]).toEqual({ method: 'PUT', url: '/api/v1/projects/wrap-creators/icon', body: { path: 'public/favicon.svg' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(sent(calls).at(-1)).toMatchObject({ method: 'DELETE', url: '/api/v1/projects/wrap-creators/icon' }))
  })

  it('shows the first letter without an icon, and addresses an icon by its version', () => {
    render(<ProjectIcon project={{ id: 'a b', name: ' wrap', icon: undefined }} />)
    expect(document.querySelector('[data-slot="project-icon"]')?.textContent).toBe('w')
    expect(projectIconUrl('a b', 'a-1.png')).toBe('/api/v1/projects/a%20b/icon?v=a-1.png')
  })
})
