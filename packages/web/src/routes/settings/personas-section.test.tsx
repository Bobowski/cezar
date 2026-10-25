import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope, type PersonasResponse } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { PersonasSection, newPersonaNameIssue, personaTemplate } from './personas-section'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const FILE = '---\nname: reviewer\nrunner: claude\n# kept as written\n---\nReview.\n'

const LIST: PersonasResponse = {
  editable: true,
  issues: [{ path: '/r/.ai/cezar/agents/broken.md', message: 'broken.md: runner: must be one of claude, codex' }],
  personas: [
    { name: 'reviewer', description: 'Reads a branch, never edits.', runner: 'claude', model: 'opus', body: 'Review.', path: '/r/.ai/cezar/agents/reviewer.md', source: 'project' },
    { name: 'helper', runner: 'claude', body: 'Help.', path: '/r/.claude/agents/helper.md', source: 'claude' },
  ],
}

function setup(list: PersonasResponse = LIST) {
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET' && url.includes('/agents/reviewer')) {
      return new Response(JSON.stringify({ persona: list.personas[0], markdown: FILE }), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify(list), { status: 200 })
    if (method === 'PUT') return new Response(JSON.stringify({ persona: list.personas[0] }), { status: 200 })
    return new Response(JSON.stringify({ ok: true, path: '/r' }), { status: 200 })
  }))
  render(<QueryClientProvider client={createQueryClient()}><PersonasSection /></QueryClientProvider>)
  return calls
}

describe('Settings → Personas', () => {
  it('lists personas with their source, launch options and load issues; only project ones are editable', async () => {
    setup()
    await screen.findByText('reviewer')
    expect(screen.getByText('Reads a branch, never edits.')).toBeTruthy()
    expect(screen.getByText('claude · opus')).toBeTruthy()
    expect(screen.getByText('Claude-only')).toBeTruthy()
    expect(screen.getByText(/broken\.md: runner: must be one of/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1)
  })

  it('opens the file exactly as written and saves it back unchanged', async () => {
    const calls = setup()
    await screen.findByText('reviewer')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = (await screen.findByLabelText('reviewer persona file')) as HTMLTextAreaElement
    expect(editor.value).toBe(FILE)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const putCall = calls.find((c) => c.method === 'PUT')!
    expect(putCall.url).toContain('/agents/reviewer')
    expect(JSON.parse(putCall.body!)).toEqual({ markdown: FILE })
  })

  it('a new persona opens on the template, under a name that is a valid file stem', () => {
    expect(newPersonaNameIssue('reviewer', LIST.personas)).toBe('A project persona has this name.')
    expect(newPersonaNameIssue('../x', LIST.personas)).toMatch(/Letters, digits/)
    expect(newPersonaNameIssue('helper', LIST.personas)).toBeNull()
    expect(personaTemplate('qa')).toMatch(/^---\nname: qa\n/)
  })

  it('is read-only on a cockpit that may not write', async () => {
    setup({ ...LIST, editable: false })
    await screen.findByText('reviewer')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: /New persona/ })).toBeNull()
  })
})
