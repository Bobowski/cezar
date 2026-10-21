import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope, type EnvFilesList } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { EnvFilesSection } from './env-files-section'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const LIST: EnvFilesList = {
  editable: true,
  files: [
    { path: 'apps/api/.env', exists: true, variables: ['DATABASE_URL'], template: 'apps/api/.env.example', missing: ['JWT_SECRET'], updatedAt: '2026-10-12T00:00:00Z' },
    { path: 'apps/web/.env', exists: false, variables: [], template: 'apps/web/.env.example', missing: ['API_URL'], updatedAt: null },
  ],
  suggestions: ['apps/cms/.env'],
}

function setup(options: { list?: EnvFilesList; putStatus?: number } = {}) {
  const { list = LIST, putStatus = 200 } = options
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET' && url.includes('/env-files/content')) {
      const existing = decodeURIComponent(url).includes('apps/api')
      return new Response(JSON.stringify({
        path: existing ? 'apps/api/.env' : 'apps/web/.env',
        content: existing ? 'DATABASE_URL=postgres://secret\n' : '',
        version: existing ? 'v1' : null,
        template: existing ? null : 'API_URL=\n',
      }), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify(list), { status: 200 })
    if (method === 'PUT' && putStatus !== 200) return new Response(JSON.stringify({ error: 'changed on disk' }), { status: putStatus })
    if (method === 'PUT') return new Response(JSON.stringify({ path: 'apps/api/.env', content: 'x', version: 'v2', template: null }), { status: 200 })
    return new Response(null, { status: 204 })
  }))
  render(<QueryClientProvider client={createQueryClient()}><EnvFilesSection /></QueryClientProvider>)
  return calls
}

describe('Environment settings', () => {
  it('lists files with variable names and what the example still asks for — no values', async () => {
    const calls = setup()
    await screen.findByText('apps/api/.env')
    expect(screen.getByText('1 variable · missing from the example: JWT_SECRET')).toBeTruthy()
    expect(screen.getByText(/Not created — apps\/web\/.env.example asks for 1 variable$/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /apps\/cms\/\.env/ })).toBeTruthy()
    // Nothing fetched a file's contents to render the list.
    expect(calls.every((call) => !call.url.includes('/content'))).toBe(true)
  })

  it('opens a file, saves the edit with the version it loaded, and closes the editor', async () => {
    const calls = setup()
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Raw text' }))
    const editor = await screen.findByLabelText('Contents of apps/api/.env') as HTMLTextAreaElement
    expect(editor.value).toBe('DATABASE_URL=postgres://secret\n')
    fireEvent.change(editor, { target: { value: 'DATABASE_URL=postgres://new\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(screen.queryByLabelText('Contents of apps/api/.env')).toBeNull())
    const put = calls.find((call) => call.method === 'PUT')
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ path: 'apps/api/.env', content: 'DATABASE_URL=postgres://new\n', version: 'v1' })
  })

  it('keeps the draft when a save is refused', async () => {
    setup({ putStatus: 409 })
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Raw text' }))
    const editor = await screen.findByLabelText('Contents of apps/api/.env') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'PASTED=1\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await screen.findByRole('alert')
    expect((screen.getByLabelText('Contents of apps/api/.env') as HTMLTextAreaElement).value).toBe('PASTED=1\n')
  })

  it('starts a new file from the tracked example', async () => {
    setup()
    await screen.findByText('apps/web/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Raw text' }))
    const editor = await screen.findByLabelText('Contents of apps/web/.env') as HTMLTextAreaElement
    expect(editor.value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Start from the example' }))
    expect(editor.value).toBe('API_URL=\n')
  })

  it('opens on the variables view with values masked until shown', async () => {
    setup()
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const value = await screen.findByLabelText('Value of DATABASE_URL') as HTMLInputElement
    expect(value.value).toBe('postgres://secret')
    expect(value.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Show DATABASE_URL' }))
    expect((screen.getByLabelText('Value of DATABASE_URL') as HTMLInputElement).type).toBe('text')
  })

  it('edits one value and adds a variable, saving the file text', async () => {
    const calls = setup()
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByLabelText('Value of DATABASE_URL'), { target: { value: 'postgres://new' } })
    fireEvent.click(screen.getByRole('button', { name: /New variable/ }))
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'API_KEY' } })
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: 'with space' } })
    // Enter in the add row adds the variable; it does not submit (save) the file.
    fireEvent.keyDown(screen.getByLabelText('New variable value'), { key: 'Enter' })
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
    expect(screen.getByLabelText('Value of API_KEY')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true))
    const put = calls.find((call) => call.method === 'PUT')
    expect(JSON.parse(put?.body ?? '{}').content).toBe('DATABASE_URL=postgres://new\nAPI_KEY="with space"\n')
  })

  it('refuses an invalid or duplicate new name', async () => {
    setup()
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: /New variable/ }))
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: '1BAD' } })
    expect((screen.getByRole('button', { name: /^Add$/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'DATABASE_URL' } })
    expect(screen.getByText(/already set/)).toBeTruthy()
  })

  it('fills a new file with what its example asks for', async () => {
    const calls = setup()
    await screen.findByText('apps/web/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(await screen.findByRole('button', { name: /Add 1 missing from the example/ }))
    expect(screen.getByLabelText('Value of API_URL')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Raw text' }))
    expect((screen.getByLabelText('Contents of apps/web/.env') as HTMLTextAreaElement).value).toBe('API_URL=\n')
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  it('offers no editing where the cockpit serves names only', async () => {
    setup({ list: { ...LIST, editable: false } })
    await screen.findByText('apps/api/.env')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByLabelText('Path')).toBeNull()
    expect(screen.getByRole('note').textContent).toMatch(/names only/)
  })
})
