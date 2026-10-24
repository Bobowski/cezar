import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SetupRestoreCard } from './setup-restore-card'

/** `/setup`'s Restore from a backup (spec 2026-10-23-backup-restore §4). */
describe('the setup restore card', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('needs the setup code, sends it with the archive, follows the job and hands over to sign-in', async () => {
    const posted: FormData[] = []
    let polls = 0
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/v1/auth/setup/restore' && init?.method === 'POST') {
          posted.push(init.body as FormData)
          return json({ job: 'job-id-0123456789abcdef' })
        }
        if (url.startsWith('/api/v1/auth/setup/restore?job=')) {
          polls += 1
          // The process restarts into the restored state, and the job dies with it.
          if (polls > 1) return json({ error: 'no such restore' }, 404)
          return json({ id: 'job-id-0123456789abcdef', kind: 'restore', status: 'restarting', startedAt: 'x', finishedAt: 'y', log: ['restored cezar state (12 files)'] })
        }
        if (url === '/api/v1/auth/session') return json({ enforced: true, authenticated: false, setupRequired: false })
        return json({ error: 'unexpected' }, 404)
      }),
    )
    const onDone = vi.fn()
    const { rerender } = render(<SetupRestoreCard setupCode="" onDone={onDone} />)
    expect(screen.getByText(/Paste the setup code above first/)).toBeTruthy()
    rerender(<SetupRestoreCard setupCode="the-code" onDone={onDone} />)

    fireEvent.change(screen.getByLabelText('Archive (.age)'), { target: { files: [new File(['age'], 'b.age')] } })
    fireEvent.change(screen.getByLabelText('Age identity or passphrase'), { target: { value: 'AGE-SECRET-KEY-1X' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore this cockpit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.get('code')).toBe('the-code')
    expect(posted[0]!.get('identity')).toBe('AGE-SECRET-KEY-1X')
    expect(await screen.findByText('restored cezar state (12 files)')).toBeTruthy()
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 5_000 })
  })
})
