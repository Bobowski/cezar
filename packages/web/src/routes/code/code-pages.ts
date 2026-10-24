/**
 * Browser tabs on the Code page as PAGES of the project's own app (spec
 * `2026-10-24-code-page-browser-tabs`): which addresses a tab may show, what it is called, and the
 * per-project copy the server keeps. Plain functions, like `code-state.ts`, so every rule is a test.
 */
import { isLoopbackPageAddress, MAX_CODE_PAGE_URL_LENGTH } from '@open-mercato/cezar-api-client'

/** The cockpit as the viewer's browser reaches it — `window.location`, or a test's stand-in. */
export interface CockpitLocation {
  protocol: string
  hostname: string
  port: string
}

const defaultPort = (protocol: string) => (protocol === 'https:' ? '443' : '80')
const portOf = (url: { protocol: string; port: string }) => url.port || defaultPort(url.protocol)
const LOOPBACK_NAME = /^(localhost|.+\.localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/i

/**
 * The address a Code Browser tab may load for `url`, or why not (§3 Scope): a loopback address
 * (`0.0.0.0` is read as `localhost`, as a dev server that printed it means), or — on a hosted
 * cockpit — the preview gateway: the cockpit's own scheme and host on another port. Never the
 * cockpit itself, which framed in its own origin would be its authenticated API.
 */
export function appAddress(url: string, cockpit: CockpitLocation | null): { ok: true; url: string } | { ok: false; reason: 'external' | 'cockpit' } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'external' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'external' }
  if (parsed.hostname === '0.0.0.0') parsed.hostname = 'localhost'
  const self = cockpit !== null && parsed.protocol === cockpit.protocol && parsed.hostname === cockpit.hostname && portOf(parsed) === portOf(cockpit)
  if (self) return { ok: false, reason: 'cockpit' }
  if (isLoopbackPageAddress(parsed.toString())) return { ok: true, url: parsed.toString() }
  const hosted = cockpit !== null && !LOOPBACK_NAME.test(cockpit.hostname)
  if (hosted && parsed.protocol === cockpit.protocol && parsed.hostname === cockpit.hostname) return { ok: true, url: parsed.toString() }
  return { ok: false, reason: 'external' }
}

/** What survives a reload: a loopback address the server will take. A gateway address carries a
 *  port this session was handed and is not kept (its loopback twin is, and gets a new ticket). */
export const keepableAddress = (url: string): boolean => url !== '' && url.length <= MAX_CODE_PAGE_URL_LENGTH && isLoopbackPageAddress(url)

/**
 * A Browser tab's title: host:port and path (a framed page's own title is unreadable across the
 * origin boundary — code-page "as built"). On a hosted cockpit the gateway port it is shown
 * through rides along: `localhost:3000/admin → :8502`.
 */
export function pageTitle(url: string, gatewayOrigin?: string | null): string {
  if (url === '') return 'Browser'
  let title: string
  try {
    const parsed = new URL(url)
    title = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return 'Browser'
  }
  if (!gatewayOrigin) return title
  try {
    const gateway = new URL(gatewayOrigin)
    return `${title} → :${portOf(gateway)}`
  } catch {
    return title
  }
}

/** Detected addresses as suggestions: normalised, app-only, each once, in the order given. */
export function pageSuggestions(urls: readonly string[], cockpit: CockpitLocation | null): string[] {
  const out: string[] = []
  for (const raw of urls) {
    const checked = appAddress(raw, cockpit)
    if (checked.ok && !out.includes(checked.url)) out.push(checked.url)
  }
  return out
}

/** The cockpit's own location, or null where there is no window (tests that stub nothing). */
export function cockpitLocation(): CockpitLocation | null {
  try {
    const { protocol, hostname, port } = window.location
    return { protocol, hostname, port }
  } catch {
    return null
  }
}

/**
 * Whether anything answers at `url`, asked from the viewer's browser: an opaque request that a
 * refused connection rejects and any answer at all resolves. Only meaningful for a loopback address
 * on a LOCAL cockpit — on a hosted one the gateway answers for the app, with its own message.
 */
export async function answers(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', ...(signal ? { signal } : {}) })
    return true
  } catch {
    return false
  }
}
