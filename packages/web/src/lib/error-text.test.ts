import { describe, expect, it } from 'vitest'

import { ApiError, unwrap } from '@/api/client'

import { errorText } from './error-text'

/** A failure toast says the server's own words (spec 2026-10-24-cockpit-polish §3.4 item 4). */

describe('errorText', () => {
  it('is the server’s `{ error }` verbatim, through the client’s own error', async () => {
    const answer = new Response(JSON.stringify({ error: 'your local changes would be overwritten by checkout' }), { status: 409 })
    const failure = await unwrap(answer as never, '/repo/branch').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(errorText(failure)).toBe('your local changes would be overwritten by checkout')
  })

  it('says what is known when the body is not one, and never something generic', async () => {
    const answer = new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
    expect(errorText(await unwrap(answer as never, '/x').catch((error: unknown) => error))).toBe('502 Bad Gateway')
    expect(errorText('refused')).toBe('refused')
    expect(errorText(new Error('the shell exited'))).toBe('the shell exited')
  })
})
