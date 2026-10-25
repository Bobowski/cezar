import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope, type McpServersList } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { McpServersSection } from './mcp-servers-section'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const STRIPE = {
  id: 'stripe',
  title: 'Stripe',
  description: 'Payments.',
  docsUrl: 'https://docs.stripe.com/mcp',
  suggestedName: 'stripe',
  definition: { type: 'http' as const, url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer ${{ secrets.STRIPE_SECRET_KEY }}' } },
  keys: [{ name: 'STRIPE_SECRET_KEY', description: 'A Stripe key.', required: true }],
}

const LIST: McpServersList = {
  project: [
    {
      name: 'context7', scope: 'project', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: [], headers: [],
      secrets: [], missingSecrets: [], shadowed: false,
      reach: [{ runner: 'claude', reach: 'yes' }, { runner: 'cursor', reach: 'no', note: 'no channel' }],
      status: { state: 'injected', at: '2026-10-24T10:00:00Z', runId: 'r1', runner: 'claude' },
    },
  ],
  private: [],
  problems: { project: [], private: ['mcp.local.json is not valid JSON: x'] },
  catalog: [STRIPE],
  editable: true,
  approval: { state: 'approved', hash: 'a'.repeat(64), approvedAt: '2026-10-24T09:00:00Z', changes: [], bindings: {} },
}

function setup(list: McpServersList = LIST) {
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.includes('/secrets')) {
      if (method === 'GET') return new Response(JSON.stringify({ secrets: [], keyBackend: 'keychain' }), { status: 200 })
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/approval')) return new Response(JSON.stringify(list), { status: 200 })
    if (url.endsWith('/test')) return new Response(JSON.stringify({ ok: true, tools: ['resolve-library-id', 'get-library-docs'] }), { status: 200 })
    return new Response(JSON.stringify(list), { status: 200 })
  }))
  render(<QueryClientProvider client={createQueryClient()}><McpServersSection /></QueryClientProvider>)
  return calls
}

describe('MCP servers settings (spec 2026-10-24-easy-mcp)', () => {
  it('lists both files with status, reach and file problems, and tests a server', async () => {
    const calls = setup()
    const row = await screen.findByText('context7')
    const item = row.closest('li')!
    expect(within(item).getByText(/injected/)).toBeTruthy()
    expect(within(item).getByText('cursor').getAttribute('data-reach')).toBe('no')
    expect(screen.getByText(/mcp.local.json is not valid JSON/)).toBeTruthy()
    expect(screen.getByText('No private servers.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Test context7' }))
    await screen.findByText('2 tools: resolve-library-id, get-library-docs')
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/mcp-servers/project/context7/test'))).toBe(true)
  })

  it('adds a catalog entry: the pasted key becomes a cezar-only project secret, the file gets a reference', async () => {
    const calls = setup()
    await screen.findByText('context7')
    fireEvent.click(screen.getByRole('button', { name: /add from catalog/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Stripe/ }))
    expect(screen.getByText('http https://mcp.stripe.com')).toBeTruthy()
    fireEvent.change(await screen.findByLabelText('Value for STRIPE_SECRET_KEY'), { target: { value: 'sk_test_abc' } })
    fireEvent.click(screen.getByLabelText('Private'))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/mcp-servers/private/stripe'))).toBe(true))
    const secret = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/secrets/STRIPE_SECRET_KEY'))!
    expect(JSON.parse(secret.body!)).toEqual({ value: 'sk_test_abc', audiences: ['cezar'] })
    const server = calls.find((c) => c.method === 'PUT' && c.url.includes('/mcp-servers/private/stripe'))!
    expect(server.body).not.toContain('sk_test_abc')
    expect(JSON.parse(server.body!).definition.headers).toEqual({ Authorization: 'Bearer ${{ secrets.STRIPE_SECRET_KEY }}' })
  })

  it('a private server named like a project one asks to confirm the replacement, naming the entry it saw', async () => {
    const hash = 'c'.repeat(64)
    const calls = setup({
      ...LIST,
      private: [{ ...LIST.project[0]!, scope: 'private', override: { hash, confirmed: false } }],
    })
    const note = await screen.findByText(/A project server is named/)
    fireEvent.click(within(note.closest('[data-slot=mcp-override]') as HTMLElement).getByRole('button', { name: 'Confirm replacement' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/mcp-servers/override'))).toBe(true))
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/mcp-servers/override'))!.body!)).toEqual({ name: 'context7', hash })
  })

  it('a manual definition is Private unless the operator picks Project', async () => {
    setup()
    await screen.findByText('context7')
    fireEvent.click(screen.getByRole('button', { name: /add manually/i }))
    expect((await screen.findByLabelText('Private') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Project') as HTMLInputElement).checked).toBe(false)
  })

  it('a changed committed file shows the diff, binds only the secrets checked, and approves that content', async () => {
    const hash = 'b'.repeat(64)
    const calls = setup({
      ...LIST,
      project: [{ ...LIST.project[0]!, name: 'gh', secrets: ['GH_PAT', 'OTHER_KEY'], boundSecrets: [] }],
      approval: {
        state: 'changed', hash, approvedAt: '2026-10-24T09:00:00Z', bindings: { gh: ['GH_PAT'] },
        changes: [{ name: 'gh', change: 'changed', before: '{"command": "old"}', after: '{"command": "new"}' }],
      },
    })
    const panel = (await screen.findByText('Changed — review and approve')).closest('[data-slot="mcp-approval"]') as HTMLElement
    expect(within(panel).getByLabelText('gh before').textContent).toContain('old')
    expect(within(panel).getByLabelText('gh after').textContent).toContain('new')
    expect(within(panel).getByText('Test runs this server now, even unapproved; approval gates agent launches.')).toBeTruthy()
    expect((within(panel).getByLabelText('Give GH_PAT to gh') as HTMLInputElement).checked).toBe(true)
    expect((within(panel).getByLabelText('Give OTHER_KEY to gh') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/mcp-servers/approval'))).toBe(true))
    const approval = calls.find((c) => c.method === 'POST' && c.url.endsWith('/mcp-servers/approval'))!
    expect(JSON.parse(approval.body!)).toEqual({ hash, bindings: { gh: ['GH_PAT'] } })
  })

  it('is read-only when the cockpit says so', async () => {
    setup({ ...LIST, editable: false })
    await screen.findByText('context7')
    expect((screen.getByRole('button', { name: /add from catalog/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Test context7' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
