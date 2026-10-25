import { CircleIcon, CopyIcon, ExternalLinkIcon, PanelRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { DetectedUrlEntry } from '@open-mercato/cezar-api-client'
import { useHealth } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { loopbackOrigin } from './gateway'
import { scopeKey, terminalUrls, type TerminalScope } from './scope'
import { tunnelCommand, tunnelPorts } from './tunnel'

/**
 * The addresses a scope's terminals printed (spec `.ai/specs/2026-10-07-task-workspace.md` §7,
 * lifted for the Code page by `2026-10-24-code-page-terminal.md` §3.1).
 *
 * Nothing here does anything on its own: an address opens only when the user clicks. On a hosted
 * cockpit (§3.4) a loopback address says it goes through the gateway, and the ssh tunnel line sits
 * beside it. The gateway's port is opened by the click — the Browser tab asks for it — never by
 * the strip showing, so a list of addresses holds no listener and evicts no one's Preview.
 */

/** How often the strip re-probes while it is looked at. Each refresh is one TCP connect per address
 *  on the server, and a server coming up is something a user waits a second or two for anyway. */
const URL_REFRESH_MS = 3_000

export function DetectedUrlsStrip({
  scope,
  onOpen,
  onPreview,
  active = true,
}: {
  scope: TerminalScope
  /** The pane is on screen. A hidden one — or a page in the background — asks nothing. */
  active?: boolean
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

  const key = scopeKey(scope)
  useEffect(() => {
    if (!active) return
    let live = true
    let timer: ReturnType<typeof setInterval> | null = null
    const pull = () => {
      void terminalUrls(scope)
        .then((state) => {
          if (!live) return
          setUrls(state.urls)
          setSshUser(state.sshUser ?? null)
        })
        .catch(() => {})
    }
    const pace = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
      if (document.visibilityState === 'hidden') return
      pull()
      timer = setInterval(pull, URL_REFRESH_MS)
    }
    pace()
    document.addEventListener('visibilitychange', pace)
    return () => {
      live = false
      if (timer !== null) clearInterval(timer)
      document.removeEventListener('visibilitychange', pace)
    }
    // `scope` is identified by its key; a fresh object each render is the same scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active])

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
            {hosted && origin ? (
              <span data-slot="gateway-port" className="font-mono text-muted-foreground" title="Opened through the preview gateway, on its own port">
                → gateway
              </span>
            ) : null}
            <span className="text-soft-foreground">
              {entry.running === true ? 'running' : entry.running === false ? 'not responding' : '…'}
            </span>
            {onOpen ? (
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
            {/* An app that calls another loopback port by absolute address works only through the
                tunnel (preview-gateway §7). */}
            {tunnel && origin ? <CopyTunnel command={tunnel} /> : null}
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

function CopyTunnel({ command }: { command: string }) {
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
      className="h-auto px-1.5 py-0.5 text-[length:inherit] text-muted-foreground hover:bg-background"
    >
      <CopyIcon aria-hidden="true" className="size-3" />
      <span>Tunnel</span>
    </Button>
  )
}
