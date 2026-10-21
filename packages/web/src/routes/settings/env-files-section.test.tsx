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

function setup(options: { list?: EnvFilesList; putStatus?: number; content?: string; renderReply?: (body: { content: string; runId?: string }) => Response; runs?: unknown[] } = {}) {
  const { list = LIST, putStatus = 200, content = 'DATABASE_URL=postgres://secret\n', renderReply, runs = [] } = options
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET' && url.includes('/env-files/content')) {
      const existing = decodeURIComponent(url).includes('apps/api')
      return new Response(JSON.stringify({
        path: existing ? 'apps/api/.env' : 'apps/web/.env',
        content: existing ? content : '',
        version: existing ? 'v1' : null,
        template: existing ? null : 'API_URL=\n',
      }), { status: 200 })
    }
    if (method === 'POST' && url.includes('/env-files/render')) {
      const body = JSON.parse(String(init?.body)) as { content: string; runId?: string }
      return renderReply ? renderReply(body) : new Response(JSON.stringify({ rendered: body.content, values: [], slot: null }), { status: 200 })
    }
    if (method === 'POST' && url.includes('/env-files/rerender')) return new Response(JSON.stringify({ changed: ['apps/api/.env'], missing: [], slot: 2 }), { status: 200 })
    if (method === 'GET' && url.includes('/runs')) return new Response(JSON.stringify(runs), { status: 200 })
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

  it('adds a port reference from the menu: it replaces the bare port and writes a #cezar directive', async () => {
    setup({ content: 'PORT=9000\n' })
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const trigger = await screen.findByRole('button', { name: 'Add reference to PORT' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Port for a service/ }))
    expect((screen.getByLabelText('Value of PORT') as HTMLInputElement).value).toBe('${{ task.port(0, 9000) }}')
    fireEvent.click(screen.getByRole('radio', { name: 'Raw text' }))
    expect((screen.getByLabelText('Contents of apps/api/.env') as HTMLTextAreaElement).value).toBe('#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\n')
  })

  it('a port reference over a selected port keeps that port for the main checkout', async () => {
    setup({ content: 'DATABASE_URL=postgres://u@localhost:5432/db\n' })
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const value = await screen.findByLabelText('Value of DATABASE_URL') as HTMLInputElement
    const at = value.value.indexOf('5432')
    value.setSelectionRange(at, at + 4)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add reference to DATABASE_URL' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Port for a service/ }))
    expect((screen.getByLabelText('Value of DATABASE_URL') as HTMLInputElement).value).toBe('postgres://u@localhost:${{ task.port(0, 5432) }}/db')
  })

  it('shows what a reference renders to, for the main checkout', async () => {
    const calls = setup({
      content: '#cezar URL=http://localhost:${{ task.port(1, 3000) }}\nURL=http://localhost:3000\n',
      renderReply: () => new Response(JSON.stringify({ rendered: '', values: [{ key: 'URL', value: 'http://localhost:3000' }], slot: null }), { status: 200 }),
    })
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(((await screen.findByLabelText('Value of URL')) as HTMLInputElement).value).toBe('http://localhost:${{ task.port(1, 3000) }}')
    fireEvent.click(screen.getByRole('button', { name: 'Show URL' }))
    await waitFor(() => expect(screen.getByLabelText('URL renders to').textContent).toBe('→ http://localhost:3000'))
    const render = calls.find((call) => call.url.includes('/env-files/render'))
    expect(JSON.parse(render?.body ?? '{}')).toEqual({ path: 'apps/api/.env', content: '#cezar URL=http://localhost:${{ task.port(1, 3000) }}\nURL=http://localhost:3000\n' })
  })

  it('a reference typed by hand becomes a directive; a plain value again drops it', async () => {
    setup({ content: 'NAME=app\n' })
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(await screen.findByLabelText('Value of NAME'), { target: { value: 'app${{ task.suffix }}' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Raw text' }))
    expect((screen.getByLabelText('Contents of apps/api/.env') as HTMLTextAreaElement).value).toBe('#cezar NAME=app${{ task.suffix }}\nNAME=app\n')
    fireEvent.click(screen.getByRole('radio', { name: 'Variables' }))
    fireEvent.change(screen.getByLabelText('Value of NAME'), { target: { value: 'plain' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Raw text' }))
    expect((screen.getByLabelText('Contents of apps/api/.env') as HTMLTextAreaElement).value).toBe('NAME=plain\n')
  })

  it('shows the server refusing a reference', async () => {
    setup({
      content: '#cezar A=${{ NOPE }}\nA=\n',
      renderReply: () => new Response(JSON.stringify({ error: 'apps/api/.env: NOPE is not set in apps/api/.env' }), { status: 400 }),
    })
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((await screen.findByRole('alert')).textContent).toContain('NOPE is not set')
  })

  it('re-renders a chosen task from the saved file, and only once the draft is saved', async () => {
    const calls = setup({
      content: '#cezar PORT=${{ task.port(0, 9000) }}\nPORT=9000\n',
      runs: [{ id: 'run-abc12345', title: 'Fix cart', status: 'review', worktreePath: '/wt/abc' }],
    })
    await screen.findByText('apps/api/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByLabelText('Value of PORT')
    expect(screen.queryByRole('button', { name: 'Re-render in this task' })).toBeNull()
    Element.prototype.scrollIntoView = vi.fn()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Render references for' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Fix cart' }))
    const button = await screen.findByRole('button', { name: 'Re-render in this task' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Value of PORT'), { target: { value: '${{ task.port(1, 9000) }}' } })
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Value of PORT'), { target: { value: '${{ task.port(0, 9000) }}' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(calls.some((call) => call.url.includes('/env-files/rerender'))).toBe(true))
    expect(JSON.parse(calls.find((call) => call.url.includes('/env-files/rerender'))?.body ?? '{}')).toEqual({ runId: 'run-abc12345' })
  })

  it('offers no editing where the cockpit serves names only', async () => {
    setup({ list: { ...LIST, editable: false } })
    await screen.findByText('apps/api/.env')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByLabelText('Path')).toBeNull()
    expect(screen.getByRole('note').textContent).toMatch(/names only/)
  })
})
