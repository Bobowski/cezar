/**
 * Links in a Code terminal's output (spec `.ai/specs/2026-10-24-code-page-terminal.md` §3.2): what
 * counts as one, and where a click on it goes.
 *
 * Two shapes. A schemed URL is what `@xterm/addon-web-links` finds (it accepts only what parses as
 * a URL with a host); a bare `localhost:3000` / `0.0.0.0:5173` is what dev servers print just as
 * often, and has no scheme for the addon to accept, so a small provider of our own finds those.
 */

/** Characters that end a URL in terminal text, and the ones a sentence leaves on its tail. */
const STOP = String.raw`\s"'<>\x60\[\]{}|\\^`
const TAIL = String.raw`.,;:!?)`

/** `http(s)://…`, an IPv6 host in its brackets, trailing punctuation excluded. */
export const SCHEMED_LINK = new RegExp(
  String.raw`https?:\/\/(?:\[[0-9a-f:]+\](?:[^${STOP}]*[^${STOP}${TAIL}])?|[^${STOP}]*[^${STOP}${TAIL}])`,
  'i',
)

/** A loopback address with a port and no scheme: `localhost:3000`, `0.0.0.0:5173/admin`,
 *  `127.0.0.1:8000`, `[::1]:4000`. Not preceded by `//` — that one is schemed. */
export const BARE_ADDRESS = new RegExp(
  String.raw`(?<![\w/.:@\[-])(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/(?:[^${STOP}]*[^${STOP}${TAIL}])?)?`,
)

export interface FoundLink {
  /** Offset in the line. */
  index: number
  text: string
}

/** Every bare loopback address in one line of output. */
export function findBareAddresses(line: string): FoundLink[] {
  const pattern = new RegExp(BARE_ADDRESS.source, 'g')
  return [...line.matchAll(pattern)].map((match) => ({ index: match.index, text: match[0] }))
}

/** Every schemed URL in one line — the addon's regex, exposed so it is testable. */
export function findSchemedLinks(line: string): FoundLink[] {
  const pattern = new RegExp(SCHEMED_LINK.source, `${SCHEMED_LINK.flags}g`)
  return [...line.matchAll(pattern)].map((match) => ({ index: match.index, text: match[0] }))
}

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$/i

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOST.test(hostname)
}

/** Where the cockpit itself is reached. */
export interface CockpitLocation {
  hostname: string
  port: string
}

export type LinkTarget =
  /** A Browser tab on the Code page: the project's own app (browser-tabs spec). */
  | { kind: 'browser'; url: string }
  /** Anything else: a new window, `noopener`. */
  | { kind: 'external'; url: string }

/**
 * Where a click on `raw` goes. A loopback address — `0.0.0.0` read as `localhost`, the bound
 * address meaning "this machine" to whoever reads it — and a gateway address (this cockpit's own
 * hostname on another port: preview-gateway spec §4) open in the Code page's Browser; anything
 * else, a documentation link or a registry URL, in a new window.
 */
export function linkTarget(raw: string, cockpit: CockpitLocation): LinkTarget | null {
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost'
  if (isLoopbackHost(url.hostname)) return { kind: 'browser', url: url.toString() }
  const gateway = url.hostname === cockpit.hostname && url.port !== '' && url.port !== cockpit.port
  return { kind: gateway ? 'browser' : 'external', url: url.toString() }
}
