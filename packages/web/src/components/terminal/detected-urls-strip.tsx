import { CircleIcon, CopyIcon, ExternalLinkIcon, PanelRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { DetectedUrlEntry } from '@open-mercato/cezar-api-client'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { gatewayPortLabel, loopbackOrigin, useGatewayMapping, type GatewayAnswer } from './gateway'
import { scopeKey, terminalUrls, type TerminalScope } from './scope'
import { tunnelCommand, tunnelPorts } from './tunnel'

/**
 * The addresses a scope's terminals printed (spec `.ai/specs/2026-10-07-task-workspace.md` §7,
 * lifted for the Code page by `2026-10-24-code-page-terminal.md` §3.1).
 *
 * Nothing here does anything on its own: an address opens only when the user clicks. On a hosted
 * cockpit (§3.4) each running loopback address shows the gateway port it is served on, and where
 * the gateway refuses it the strip offers the ssh tunnel line instead of a dead link.
 */

/** How often the strip re-probes. Each refresh is one TCP connect per address on the server, and
 *  a server coming up is something a user waits a second or two for anyway. */
const URL_REFRESH_MS = 3_000

export function DetectedUrlsStrip({
  scope,
  onOpen,
  onPreview,
}: {
  scope: TerminalScope
  /** Opens the address inside the cockpit (the Code page's Browser tab). Absent: `Open in Browser`
   *  is the user's own browser, a new tab. */
  onOpen?: (url: string) => void
  /** Opens the address in a Browser column (the task drawer). Returns false when the layout had
   *  no room for one, so the strip can say so instead of appearing to do nothing. */
  onPreview?: (url: string) => boolean
}) {
  const [urls, setUrls] = useState<DetectedUrlEntry[]>([])
  const [sshUser, setSshUser] = useState<string | null>(null)
  const [noRoom, setNoRoom] = useState(false)
  const health = useHealth()
  // Hosted: the addresses are the server's loopback, so they go through the gateway (§3.4).
  // Only where the strip opens inside the cockpit — the task drawer keeps its behaviour.
  const hosted = onOpen !== undefined && health.data?.capabilities?.localHandoff === false
  const gateway = useGatewayMapping(urls, hosted)

  const key = scopeKey(scope)
  useEffect(() => {
    let active = true
    const pull = () => {
      void terminalUrls(scope)
        .then((state) => {
          if (!active) return
          setUrls(state.urls)
          setSshUser(state.sshUser ?? null)
        })
        .catch(() => {})
    }
    pull()
    const timer = setInterval(pull, URL_REFRESH_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
    // `scope` is identified by its key; a fresh object each render is the same scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (urls.length === 0) return null
  const tunnel = hosted ? tunnelCommand(tunnelPorts(urls.map((entry) => entry.url)), window.location.hostname, sshUser) : null

  return (
    <div
      data-slot="detected-urls"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-3 py-1.5"
    >
      <span className="text-xs text-muted-foreground">Detected addresses</span>
      {urls.map((entry) => {
        const origin = loopbackOrigin(entry.url)
        const answer: GatewayAnswer | undefined = hosted && origin ? gateway.get(origin) : undefined
        // Refused by the gateway: a dead link is worse than the line that does work (§3.4).
        const refused = answer?.status === 'refused'
        return (
          <span
            key={entry.url}
            data-slot="detected-url"
            data-running={entry.running === true ? '' : undefined}
            className="flex items-center gap-1.5 rounded-sm bg-muted/60 py-0.5 pr-0.5 pl-2 text-xs"
          >
            {/* Three states, not two: `null` is "not probed yet", which is not the same claim as
                "nothing is listening". */}
            <CircleIcon
              aria-hidden="true"
              className={cn(
                'size-2',
                entry.running === true
                  ? 'fill-success text-success'
                  : entry.running === false
                    ? 'fill-muted text-muted-foreground'
                    : 'text-soft-foreground',
              )}
            />
            <span className="font-mono">{entry.url}</span>
            {answer?.status === 'mapped' ? (
              <span data-slot="gateway-port" className="font-mono text-muted-foreground" title={answer.origin}>
                → {gatewayPortLabel(answer.origin)}
              </span>
            ) : null}
            <span className="text-soft-foreground" title={refused ? answer.reason : undefined}>
              {entry.running === true ? 'running' : entry.running === false ? 'not responding' : '…'}
            </span>
            {refused ? null : onOpen ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Open ${entry.url} in Browser`}
                onClick={() => onOpen(entry.url)}
                className="h-auto px-1.5 py-0.5 text-[length:inherit] hover:bg-background"
              >
                <PanelRightIcon aria-hidden="true" className="size-3" />
                <span>Open in Browser</span>
              </Button>
            ) : (
              // The user's own browser, a new tab: the desktop shell hands `_blank` to the default one.
              <Button
                asChild
                variant="ghost"
                size="xs"
                className="h-auto px-1.5 py-0.5 text-[length:inherit] hover:bg-background"
              >
                <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${entry.url} in Browser`}>
                  <ExternalLinkIcon aria-hidden="true" className="size-3" />
                  <span>Open in Browser</span>
                </a>
              </Button>
            )}
            {onPreview ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Open ${entry.url} in Preview`}
                onClick={() => setNoRoom(!onPreview(entry.url))}
                className="h-auto px-1.5 py-0.5 text-[length:inherit] hover:bg-background"
              >
                <PanelRightIcon aria-hidden="true" className="size-3" />
                <span>Open Preview</span>
              </Button>
            ) : null}
            {/* Also beside a mapped address: an app that calls another loopback port by absolute
                address works only through the tunnel (preview-gateway §7). */}
            {tunnel && origin ? <CopyTunnel command={tunnel} prominent={refused} /> : null}
          </span>
        )
      })}
      {noRoom ? (
        <span className="text-xs text-muted-foreground">
          No room to open it here — this layout has three columns, or its Preview is out of tabs.
        </span>
      ) : null}
    </div>
  )
}

function CopyTunnel({ command, prominent }: { command: string; prominent: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      title={command}
      aria-label="Copy tunnel command"
      data-slot="copy-tunnel"
      onClick={() => {
        void (navigator.clipboard?.writeText(command) ?? Promise.reject(new Error('no clipboard')))
          .then(() => toast('Tunnel command copied — run it on your own machine.'))
          .catch(() => toast(command, { durationMs: 15_000 }))
      }}
      className={cn('h-auto px-1.5 py-0.5 text-[length:inherit] hover:bg-background', !prominent && 'text-muted-foreground')}
    >
      <CopyIcon aria-hidden="true" className="size-3" />
      <span>{prominent ? 'Copy tunnel command' : 'Tunnel'}</span>
    </Button>
  )
}
