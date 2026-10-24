import type { ILink, IDisposable, Terminal } from '@xterm/xterm'

import { SCHEMED_LINK, findBareAddresses, linkTarget } from './links'

/**
 * Make a terminal's addresses clickable (spec `.ai/specs/2026-10-24-code-page-terminal.md` §3.2):
 * `@xterm/addon-web-links` for schemed URLs, a provider of our own for bare `localhost:3000`
 * (the addon accepts only what parses as a URL with a host). Both hand the click to one handler.
 */
export async function attachTerminalLinks(
  term: Terminal,
  openInBrowser: (url: string) => void,
  gatewayPorts: () => readonly number[] = () => [],
): Promise<IDisposable> {
  const activate = (_event: MouseEvent, raw: string) => {
    const target = linkTarget(raw, { hostname: window.location.hostname, port: window.location.port, gatewayPorts: gatewayPorts() })
    if (!target) return
    if (target.kind === 'browser') openInBrowser(target.url)
    else window.open(target.url, '_blank', 'noopener,noreferrer')
  }
  const { WebLinksAddon } = await import('@xterm/addon-web-links')
  const addon = new WebLinksAddon(activate, { urlRegex: SCHEMED_LINK })
  term.loadAddon(addon)
  const bare = term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const links: ILink[] = findBareAddresses(text).map((found) => ({
        range: { start: { x: found.index + 1, y }, end: { x: found.index + found.text.length, y } },
        text: found.text,
        activate,
      }))
      callback(links.length > 0 ? links : undefined)
    },
  })
  return {
    dispose: () => {
      bare.dispose()
      addon.dispose()
    },
  }
}
