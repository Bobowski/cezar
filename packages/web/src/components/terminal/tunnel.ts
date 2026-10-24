import { isLoopbackHost } from './links'

/**
 * The ssh line for what the preview gateway cannot carry (spec
 * `.ai/specs/2026-10-14-tunnel-command.md` §3): every port forwarded on its OWN number — a
 * different local number is a different origin, which defeats the tunnel.
 */

/** The ports of the loopback addresses among `urls`, deduped and sorted. */
export function tunnelPorts(urls: readonly string[]): number[] {
  const ports = new Set<number>()
  for (const raw of urls) {
    try {
      const url = new URL(raw)
      if (!isLoopbackHost(url.hostname)) continue
      const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
      if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port)
    } catch {
      // not an address
    }
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * `ssh -N -L 3000:localhost:3000 … user@host`, or null when there is nothing to tunnel: no port,
 * or a cockpit opened at a loopback address (it is on this machine already — tunnel spec §3.3).
 * `host` is the hostname the viewer's browser reached the cockpit at; it never goes to the server.
 */
export function tunnelCommand(ports: readonly number[], host: string, user?: string | null): string | null {
  if (ports.length === 0 || host === '' || isLoopbackHost(host)) return null
  const forwards = ports.map((port) => `-L ${port}:localhost:${port}`).join(' ')
  return `ssh -N ${forwards} ${user ? `${user}@` : ''}${host}`
}
