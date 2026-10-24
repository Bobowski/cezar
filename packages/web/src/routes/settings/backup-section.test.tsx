import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackupStatus } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ageOf, BackupSection, humanBytes } from './backup-section'

const RECIPIENT = 'age18j35t29smu32hg0lgmtsh3x7cad66hl7p5n2cdyd5jtsy5w6gc7swv3dp3'

function empty(): BackupStatus {
  return {
    recipient: null,
    target: null,
    schedule: { nightly: false, keep: 14, lastRunAt: null, nextRunAt: null },
    archives: [],
    job: null,
    restartAvailable: true,
  }
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(status: BackupStatus) {
  requests = []
  const json = (payload: unknown, code = 200) =>
    new Response(JSON.stringify(payload), { status: code, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/backup' && method === 'GET') return json(status)
      if (url === '/api/v1/workspace/backup/recipient' && method === 'PUT') {
        const value = body as { recipient?: string; passphrase?: true }
        status.recipient = value.recipient ? { kind: 'age', recipient: value.recipient } : { kind: 'passphrase' }
        return json(status)
      }
      if (url === '/api/v1/workspace/backup' && method === 'POST') {
        status.job = { id: 'j', kind: 'backup', status: 'done', startedAt: '2026-10-23T03:00:00Z', finishedAt: '2026-10-23T03:00:05Z', log: ['wrote it'], archive: 'cezar-backup-box-20261023T0300Z.tar.zst.age' }
        status.archives = [{ name: 'cezar-backup-box-20261023T0300Z.tar.zst.age', size: 4_200_000, createdAt: new Date().toISOString(), uploaded: false }]
        return json(status)
      }
      return json({ error: 'unexpected' }, 404)
    }),
  )
}

function renderSection() {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <BackupSection />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Settings → Backup', () => {
  it('asks for a recipient before Back up now does anything, and hides Nightly without a target', async () => {
    serve(empty())
    renderSection()
    const now = await screen.findByRole('button', { name: /back up now/i })
    expect(now).toHaveProperty('disabled', true)
    expect(screen.queryByText('Back up every night')).toBeNull()
    expect(screen.getByText('No remote target')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('age1…'), { target: { value: 'not-a-key' } })
    expect(screen.getByText(/not an age public key/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('age1…'), { target: { value: RECIPIENT } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT' && (r.body as { recipient?: string }).recipient === RECIPIENT)).toBe(true))
    await waitFor(() => expect(screen.getByRole('button', { name: /back up now/i })).toHaveProperty('disabled', false))

    fireEvent.click(screen.getByRole('button', { name: /back up now/i }))
    const download = await screen.findByRole('link', { name: /download/i })
    expect(download.getAttribute('href')).toBe('/api/v1/workspace/backup/archives/cezar-backup-box-20261023T0300Z.tar.zst.age')
    expect(screen.getByText('wrote it')).toBeTruthy()
  })

  it('shows Nightly once a target exists, and says why it needs a public key', async () => {
    serve({
      ...empty(),
      recipient: { kind: 'passphrase' },
      target: { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'bk', prefix: '', region: 'auto', accessKeyId: 'AK', secretSet: true },
    })
    renderSection()
    expect(await screen.findByText('Back up every night')).toBeTruthy()
    expect(screen.getByText(/Needs an age1… recipient/)).toBeTruthy()
    expect(screen.getByText('bk at acct.r2.cloudflarestorage.com')).toBeTruthy()
    // The passphrase is asked for at backup time, never stored.
    expect(screen.getByLabelText('Passphrase')).toBeTruthy()
  })

  it('formats sizes and ages for the archive rows', () => {
    expect(humanBytes(4_200_000)).toBe('4.0 MB')
    expect(humanBytes(10)).toBe('1 KB')
    expect(ageOf('2026-10-23T03:00:00Z', Date.parse('2026-10-23T05:00:00Z'))).toBe('2 h ago')
  })
})
