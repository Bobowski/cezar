import type { PreviewGatewayResponse } from '@open-mercato/cezar-api-client'

import { isLoopbackHost } from './links'

/**
 * A loopback address on a hosted cockpit, resolved through the preview gateway (spec
 * `.ai/specs/2026-10-24-code-page-terminal.md` §3.4, `2026-10-10-preview-gateway.md`).
 */

/** The page to load: the gateway's origin, the address's path, and the one-load ticket. */
export function gatewayHref(url: string, opened: PreviewGatewayResponse): string {
  const target = new URL(url)
  const href = new URL(opened.origin + target.pathname + target.search + target.hash)
  href.searchParams.set(opened.ticketParam, opened.ticket)
  return href.toString()
}

export function loopbackOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return isLoopbackHost(parsed.hostname) && parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}
