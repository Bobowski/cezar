import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { WebhookIcon } from 'lucide-react'

import type { AutomationWebhook } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client'
import { getAutomationWebhook, pingAutomationWebhook, registerAutomationWebhook, removeAutomationWebhook } from '@/api/client'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { logTime } from '@/lib/automation-format'

export const automationWebhookQueryKey = () => [queryScope(), 'automation-webhook'] as const

/**
 * The GitHub webhook wake-up (spec 2026-10-23-github-events §4): one line under the list that
 * says whether GitHub can tell this cockpit about changes, with Register / Ping / Remove. A
 * webhook only wakes the polls early; without one they keep their interval, so this is never a
 * setup step — a local cockpit just shows the route and why it cannot be registered.
 */
export function WebhookCard({ timeZone }: { timeZone: string }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: automationWebhookQueryKey(),
    queryFn: ({ signal }) => getAutomationWebhook({ signal }),
  })
  const settle = (data: { webhook: AutomationWebhook }) => queryClient.setQueryData(automationWebhookQueryKey(), data)
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
  const register = useMutation({ mutationFn: registerAutomationWebhook, onSuccess: (data) => { settle(data); toast('Webhook registered — GitHub sends a ping now.') }, onError: fail })
  const ping = useMutation({ mutationFn: pingAutomationWebhook, onSuccess: settle, onError: fail })
  const remove = useMutation({ mutationFn: removeAutomationWebhook, onSuccess: settle, onError: fail })
  const webhook = query.data?.webhook
  if (!webhook) return null
  const busy = register.isPending || ping.isPending || remove.isPending

  return (
    <div data-slot="webhook-card" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-[13px] text-muted-foreground">
      <WebhookIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="font-medium text-foreground">GitHub webhook</span>
      <StatusDot tone={webhook.registered ? 'success' : 'neutral'} />
      <span data-slot="webhook-status" className="min-w-0">
        {webhook.registered
          ? webhookLine(webhook, timeZone)
          : webhook.available
            ? 'Not registered — polls keep their interval.'
            : `${webhook.reason ?? 'Unavailable here.'} Route: ${webhook.route}`}
      </span>
      <span className="ml-auto flex shrink-0 gap-2">
        {webhook.registered ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => ping.mutate()}>Ping</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate()}>Remove</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={!webhook.available || busy} onClick={() => register.mutate()}>
            Register webhook
          </Button>
        )}
      </span>
    </div>
  )
}

function webhookLine(webhook: AutomationWebhook, timeZone: string): string {
  const parts = [
    webhook.lastDeliveryAt
      ? `last delivery ${logTime(webhook.lastDeliveryAt, timeZone)}${webhook.lastEvent ? ` (${webhook.lastEvent})` : ''}`
      : 'no delivery yet',
  ]
  if (webhook.ping) parts.push(webhook.ping.ok ? `ping sent ${logTime(webhook.ping.at, timeZone)}` : `ping failed: ${webhook.ping.error ?? 'unknown error'}`)
  return parts.join(' · ')
}
