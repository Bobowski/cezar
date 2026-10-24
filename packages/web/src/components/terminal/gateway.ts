import { useEffect, useRef, useState } from 'react'

import type { PreviewGatewayResponse } from '@open-mercato/cezar-api-client'

import { openPreviewGateway } from '@/api/client'

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

/** What the strip says about one loopback origin. */
export type GatewayAnswer =
  | { status: 'pending' }
  | { status: 'mapped'; origin: string }
  | { status: 'refused'; reason: string }

/** `:8502` — the part of a gateway origin a user needs to recognise it. */
export function gatewayPortLabel(origin: string): string {
  try {
    const url = new URL(origin)
    return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return origin
  }
}

export function loopbackOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return isLoopbackHost(parsed.hostname) && parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** How long a refusal stands before the strip asks again: a port may have been freed. */
const REFUSAL_RETRY_MS = 30_000

/**
 * The gateway port of each RUNNING loopback origin among `urls`, when `enabled` (a hosted
 * cockpit). Asked once per origin — the gateway reuses one listener per app, so asking again
 * would only mint tickets nobody spends; an address that is not answering yet is not asked at
 * all, so a stopped server does not hold a port.
 */
export function useGatewayMapping(urls: ReadonlyArray<{ url: string; running: boolean | null }>, enabled: boolean): ReadonlyMap<string, GatewayAnswer> {
  const [answers, setAnswers] = useState<ReadonlyMap<string, GatewayAnswer>>(new Map())
  // Read by the effect without following it: following it would re-ask after every answer.
  const asked = useRef(new Map<string, { status: GatewayAnswer['status']; at: number }>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const now = Date.now()
    const live = new Set(urls.filter((entry) => entry.running === true).map((entry) => loopbackOrigin(entry.url)))
    for (const origin of live) {
      if (origin === null) continue
      const known = asked.current.get(origin)
      if (known && !(known.status === 'refused' && now - known.at > REFUSAL_RETRY_MS)) continue
      asked.current.set(origin, { status: 'pending', at: now })
      setAnswers((current) => new Map(current).set(origin, { status: 'pending' }))
      const settle = (answer: GatewayAnswer) => {
        asked.current.set(origin, { status: answer.status, at: Date.now() })
        if (mounted.current) setAnswers((current) => new Map(current).set(origin, answer))
      }
      openPreviewGateway({ target: origin, parentOrigin: window.location.origin })
        .then((opened) => settle({ status: 'mapped', origin: opened.origin }))
        .catch((error: unknown) => settle({ status: 'refused', reason: error instanceof Error && error.message ? error.message : 'the preview gateway did not answer' }))
    }
  }, [enabled, urls])

  return answers
}
