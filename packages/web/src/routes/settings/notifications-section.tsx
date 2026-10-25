import { useQueryClient } from '@tanstack/react-query'
import { BellOffIcon } from 'lucide-react'
import * as React from 'react'

import { putWorkspaceUiState } from '@/api/client'
import { pushQueryKeys, subscribePush, unsubscribePush, usePushState } from '@/api/push'
import {
  currentPushSubscription,
  disableDevicePush,
  enableDevicePush,
  pushDeviceSupport,
  type PushDeviceSupport,
} from '@/lib/push'
import { useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import {
  normalizeNotifications,
  notificationSupport,
  type NotificationSupport,
} from '@/lib/notifications'
import { SettingsField, SettingsGroup, SettingsPane } from './settings-field'

/**
 * Settings → Notifications (R6 Step 1.7, spec §"Cross-cutting").
 *
 * A GLOBAL section since the multi-project split (step 3.5): the browser doing the notifying
 * is one browser whichever project you are looking at, so the answer belongs to the user, not
 * to a repo. It persists in `~/.cezar/ui-state.json` via `PUT /api/workspace/ui-state`
 * (Migration 001 carried the pre-existing per-repo value up).
 *
 * One real knob: the browser-notification toggle, OFF by default. Two contracts it keeps:
 *
 *  - the preference persists via the same PUT-then-reconcile pattern as Appearance (1.3):
 *    flip locally for immediacy, PUT the full object, and on a failed write fall back to the
 *    server's truth rather than keep showing a choice the file never got. No localStorage
 *    mirror — nothing here affects first paint.
 *  - `Notification.requestPermission()` runs on ENABLE only, and only when the browser hasn't
 *    answered yet. A denial still persists the preference (it follows the user; permission is
 *    per-browser) — the section then says plainly that this browser is blocking delivery.
 */
export function NotificationsSection() {
  const queryClient = useQueryClient()
  const uiState = useWorkspaceUiState()

  const [enabled, setEnabled] = React.useState(false)
  const [permission, setPermission] = React.useState<NotificationSupport>(notificationSupport)

  // The server's word wins — including "no notifications key" meaning the off default, so
  // wiping ui-state.json honestly resets every browser that visits.
  const serverState = uiState.data
  React.useEffect(() => {
    if (serverState === undefined) return
    setEnabled(normalizeNotifications(serverState.notifications).enabled)
  }, [serverState])

  const save = React.useCallback(
    (next: boolean) => {
      setEnabled(next)
      putWorkspaceUiState({ notifications: { enabled: next } })
        .then((merged) => queryClient.setQueryData(workspaceQueryKeys.uiState, merged))
        .catch((error: unknown) => {
          toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
          void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState })
        })
    },
    [queryClient],
  )

  const onToggle = React.useCallback(
    (next: boolean) => {
      if (!next) {
        save(false)
        return
      }
      // Permission is requested HERE and nowhere else (spec: "permission requested on enable
      // only") — and only when the browser has never been asked. `granted`/`denied` are final
      // answers Chrome would ignore a re-request for anyway.
      if (notificationSupport() !== 'default') {
        save(true)
        return
      }
      // Persist first, then ask: the preference is not conditional on the answer, and an
      // `await` before the write would let a closed permission prompt strand the toggle.
      save(true)
      Notification.requestPermission()
        .then((answer) => setPermission(answer))
        .catch(() => setPermission(notificationSupport()))
    },
    [save],
  )

  const unsupported = permission === 'unsupported'

  return (
    <SettingsPane data-slot="notifications-section">
      <SettingsGroup title="Browser">
        <SettingsField
          title="Notify when an agent needs you"
          htmlFor="notifications-enabled"
          hint="A browser notification when a task starts waiting, asks for review, or fails — only while this tab is in the background. Off by default."
          control={
            <Switch
              id="notifications-enabled"
              data-slot="notifications-toggle"
              checked={enabled}
              disabled={unsupported}
              onCheckedChange={onToggle}
            />
          }
        >
          {unsupported ? (
            <Alert data-slot="notifications-unsupported">
              <BellOffIcon aria-hidden="true" />
              <AlertDescription>
                This browser does not support notifications, so the toggle is unavailable here.
              </AlertDescription>
            </Alert>
          ) : null}

          {!unsupported && enabled && permission === 'denied' ? (
            <Alert variant="destructive" data-slot="notifications-denied">
              <BellOffIcon aria-hidden="true" />
              <AlertDescription>
                This browser is blocking notifications for the cockpit. The preference is saved, but
                nothing will be delivered here until you allow notifications in the browser&apos;s
                site settings.
              </AlertDescription>
            </Alert>
          ) : null}
        </SettingsField>
      </SettingsGroup>
      <DevicePushGroup />
    </SettingsPane>
  )
}

/** Why push cannot be switched on here, in words; null when it can. Exported for the table test. */
export function devicePushBlocker(input: {
  available: boolean | undefined
  support: PushDeviceSupport
}): string | null {
  if (input.available === false) {
    return 'Push needs a hosted cockpit served over HTTPS. This one runs on this machine, where a browser’s push service cannot reach it — browser notifications above still work.'
  }
  if (input.support === 'insecure') return 'This page is not served over HTTPS, so the browser offers no push here.'
  if (input.support === 'unsupported') {
    return 'This browser does not support push notifications. On an iPhone or iPad, add the cockpit to the Home Screen and open it from there.'
  }
  return null
}

/**
 * Settings → Notifications → This device (spec 2026-10-24-mobile-cockpit §3.5): Web Push for THIS
 * device only, off until tapped. The permission prompt runs on enable and nowhere else; turning it
 * off drops the browser's subscription and the server's row together.
 */
function DevicePushGroup() {
  const queryClient = useQueryClient()
  const push = usePushState()
  const [support] = React.useState(pushDeviceSupport)
  const [deviceHasSubscription, setDeviceHasSubscription] = React.useState<boolean | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [refusal, setRefusal] = React.useState<'denied' | 'failed' | null>(null)

  React.useEffect(() => {
    let live = true
    void currentPushSubscription().then((subscription) => {
      if (live) setDeviceHasSubscription(subscription !== null)
    })
    return () => {
      live = false
    }
  }, [])

  const blocker = devicePushBlocker({ available: push.data?.available, support })
  const checked = push.data?.subscribed === true && deviceHasSubscription !== false

  const onToggle = React.useCallback(
    async (next: boolean) => {
      setBusy(true)
      setRefusal(null)
      try {
        if (next) {
          const publicKey = push.data?.publicKey
          if (!publicKey) return
          const result = await enableDevicePush(publicKey)
          if (!result.ok) {
            setRefusal(result.reason === 'denied' ? 'denied' : 'failed')
            return
          }
          const { endpoint, keys, expirationTime } = result.subscription
          if (!endpoint || !keys?.p256dh || !keys.auth) {
            setRefusal('failed')
            return
          }
          if (result.replacedEndpoint !== undefined) await unsubscribePush(result.replacedEndpoint).catch(() => undefined)
          const state = await subscribePush({ endpoint, expirationTime: expirationTime ?? null, keys: { p256dh: keys.p256dh, auth: keys.auth } })
          setDeviceHasSubscription(true)
          queryClient.setQueryData(pushQueryKeys.state, state)
        } else {
          const endpoint = await disableDevicePush()
          const state = await unsubscribePush(endpoint)
          setDeviceHasSubscription(false)
          queryClient.setQueryData(pushQueryKeys.state, state)
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        void queryClient.invalidateQueries({ queryKey: pushQueryKeys.state })
      } finally {
        setBusy(false)
      }
    },
    [push.data?.publicKey, queryClient],
  )

  return (
    <SettingsGroup title="This device">
      <SettingsField
        title="This device: enable push"
        htmlFor="push-enabled"
        hint="A push notification on this device when a task waits for you, asks for review, or fails — even with the cockpit closed, and only while no cockpit tab of yours is on screen. It shows the task’s title and status, nothing else."
        control={
          <Switch
            id="push-enabled"
            data-slot="push-toggle"
            checked={checked}
            disabled={busy || push.data === undefined || blocker !== null}
            onCheckedChange={(next) => void onToggle(next)}
          />
        }
      >
        {!blocker && push.data?.stale === true ? (
          <Alert variant="destructive" data-slot="push-stale">
            <BellOffIcon aria-hidden="true" />
            <AlertDescription>
              Push stopped reaching this device after the cockpit&apos;s push key changed — re-enable push on this device.
            </AlertDescription>
          </Alert>
        ) : null}
        {blocker ? (
          <Alert data-slot="push-unavailable">
            <BellOffIcon aria-hidden="true" />
            <AlertDescription>{blocker}</AlertDescription>
          </Alert>
        ) : null}
        {refusal === 'denied' ? (
          <Alert variant="destructive" data-slot="push-denied">
            <BellOffIcon aria-hidden="true" />
            <AlertDescription>
              This browser is blocking notifications for the cockpit. Allow them in the browser&apos;s site settings, then try again.
            </AlertDescription>
          </Alert>
        ) : null}
        {refusal === 'failed' ? (
          <Alert variant="destructive" data-slot="push-failed">
            <BellOffIcon aria-hidden="true" />
            <AlertDescription>This browser could not subscribe to push. Try again, or use another browser.</AlertDescription>
          </Alert>
        ) : null}
      </SettingsField>
    </SettingsGroup>
  )
}
