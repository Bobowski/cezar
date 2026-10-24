import { useQueryClient } from '@tanstack/react-query'
import { MonitorSmartphoneIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { AUTH_PASSWORD_MIN } from '@open-mercato/cezar-api-client'
import {
  authQueryKeys,
  changePassword,
  regenerateRecoveryCodes,
  revokeDevice,
  revokeOtherDevices,
  useDevices,
  useSignedInUser,
} from '@/api/auth'
import { errorText } from '@/components/auth/auth-frame'
import { CodeField } from '@/components/auth/code-field'
import { RecoveryCodes } from '@/components/auth/recovery-codes'
import { useSignOut } from '@/components/auth/use-sign-out'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import {
  SettingsError,
  SettingsFact,
  SettingsFacts,
  SettingsField,
  SettingsGroup,
  SettingsLoading,
  SettingsNote,
  SettingsPane,
} from './settings-field'
import { ApiTokensGroup } from './api-tokens-group'

/**
 * Settings → Security (spec 2026-10-12-cockpit-authentication §8). Global: an account belongs to
 * the person, not to a project. Listed only on a cockpit that has sign-in.
 *
 * Everything that changes a credential asks for a FRESH authenticator code — the server refuses
 * without one — so a session left open on a shared screen cannot be used to take the account.
 */
export function SecuritySection() {
  const user = useSignedInUser()
  if (!user) {
    return <SettingsNote>Sign-in is not enabled on this cockpit, so there is no account to manage here.</SettingsNote>
  }
  return (
    <SettingsPane data-slot="security-section">
      <SettingsGroup title="Account">
        <SettingsFacts>
          <SettingsFact label="Username">
            <span className="font-mono text-[13px]">{user.name}</span>
          </SettingsFact>
          <SettingsFact label="Role">
            <span className="capitalize">{user.role}</span>
          </SettingsFact>
          <SettingsFact label="Two-step verification">Authenticator app — always on</SettingsFact>
        </SettingsFacts>
      </SettingsGroup>
      <PasswordGroup />
      <RecoveryGroup />
      <DevicesGroup />
      <ApiTokensGroup />
    </SettingsPane>
  )
}

function PasswordGroup() {
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nextProblem = next !== '' && next.length < AUTH_PASSWORD_MIN ? `At least ${AUTH_PASSWORD_MIN} characters.` : null
  const confirmProblem = confirm !== '' && confirm !== next ? 'The two passwords do not match.' : null
  const ready = current !== '' && next.length >= AUTH_PASSWORD_MIN && confirm === next && code.length === 6

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    changePassword({ currentPassword: current, newPassword: next, code })
      .then((revoked) => {
        setCurrent('')
        setNext('')
        setConfirm('')
        setCode('')
        void queryClient.invalidateQueries({ queryKey: authQueryKeys.devices })
        toast(
          revoked > 0
            ? `Password changed. ${revoked} other ${revoked === 1 ? 'device was' : 'devices were'} signed out.`
            : 'Password changed.',
        )
      })
      .catch((cause: unknown) => {
        setError(errorText(cause))
        setCode('')
      })
      .finally(() => setBusy(false))
  }

  return (
    <SettingsGroup
      title="Password"
      description="Changing it signs every other device out. You will need your current password and a fresh authenticator code."
    >
      <form onSubmit={submit} noValidate className="px-5 py-4">
        <FieldGroup className="max-w-sm gap-5">
          <Field>
            <FieldLabel htmlFor="security-current">Current password</FieldLabel>
            <Input
              id="security-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="security-new">New password</FieldLabel>
            <Input
              id="security-new"
              type="password"
              autoComplete="new-password"
              aria-invalid={nextProblem ? true : undefined}
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
            <FieldError>{nextProblem}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="security-confirm">Confirm new password</FieldLabel>
            <Input
              id="security-confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={confirmProblem ? true : undefined}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <FieldError>{confirmProblem}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="security-code">Authenticator code</FieldLabel>
            <div className="flex">
              <CodeField id="security-code" value={code} onChange={setCode} autoFocus={false} disabled={busy} invalid={error !== null} />
            </div>
            <FieldError>{error}</FieldError>
          </Field>
          <div>
            <Button type="submit" variant="contrast" disabled={busy || !ready}>
              {busy ? <Spinner aria-hidden="true" /> : null}
              Change password
            </Button>
          </div>
        </FieldGroup>
      </form>
    </SettingsGroup>
  )
}

function RecoveryGroup() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setOpen(false)
    setCode('')
    setCodes(null)
    setError(null)
  }

  const submit = (value: string) => {
    if (busy || value.length !== 6) return
    setBusy(true)
    setError(null)
    regenerateRecoveryCodes(value)
      .then(setCodes)
      .catch((cause: unknown) => {
        setError(errorText(cause))
        setCode('')
      })
      .finally(() => setBusy(false))
  }

  return (
    <SettingsGroup title="Recovery codes">
      <SettingsField
        title="Generate new codes"
        hint="Ten single-use codes that sign you in when you do not have your authenticator. Generating a new set makes every older code stop working."
        control={
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            Generate
          </Button>
        }
      />
      <SettingsField
        title="Lost your authenticator?"
        hint={
          <>
            Sign in with a recovery code, then run <code className="font-mono text-foreground">cezar auth reset</code> on
            the server to enrol a new one. There is no way to do that from the browser, on purpose.
          </>
        }
      />
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-sm">
          {codes ? (
            <>
              <DialogHeader>
                <DialogTitle>Your new recovery codes</DialogTitle>
                <DialogDescription>
                  Save them now — they will not be shown again, and the previous set no longer works.
                </DialogDescription>
              </DialogHeader>
              <RecoveryCodes codes={codes} />
              <DialogFooter>
                <Button type="button" variant="contrast" onClick={close}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form
              className="contents"
              onSubmit={(event) => {
                event.preventDefault()
                submit(code)
              }}
            >
              <DialogHeader>
                <DialogTitle>Generate new recovery codes</DialogTitle>
                <DialogDescription>Enter the current code from your authenticator app to confirm.</DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="recovery-confirm-code" className="sr-only">
                  Authenticator code
                </FieldLabel>
                <CodeField id="recovery-confirm-code" value={code} onChange={setCode} onComplete={submit} disabled={busy} invalid={error !== null} />
                <FieldError className="text-center">{error}</FieldError>
              </Field>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="contrast" disabled={busy || code.length !== 6}>
                  {busy ? <Spinner aria-hidden="true" /> : null}
                  Generate
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "5 minutes ago", coarse on purpose: this is "which device is that", not an audit log. */
export function lastActive(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return 'just now'
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3600), 'hour')
  return RELATIVE.format(Math.round(seconds / 86_400), 'day')
}

function DevicesGroup() {
  const queryClient = useQueryClient()
  const devices = useDevices()
  const signOut = useSignOut()
  const [pending, setPending] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: authQueryKeys.devices })
  const run = (key: string, work: () => Promise<unknown>, done: string) => {
    setPending(key)
    work()
      .then(() => {
        toast(done)
        return refresh()
      })
      .catch((cause: unknown) => toast(errorText(cause), { tone: 'danger' }))
      .finally(() => setPending(null))
  }

  if (devices.isPending) return <SettingsLoading label="Loading devices" />
  if (devices.isError) return <SettingsError title="Could not load your devices">{errorText(devices.error)}</SettingsError>

  const sessions = devices.data.sessions
  const others = sessions.filter((session) => !session.current)

  return (
    <SettingsGroup
      title="Devices"
      description="Every browser signed in to this account. A session ends after 7 days without use, or 30 days in all."
      actions={
        others.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending !== null}
            onClick={() => run('others', revokeOtherDevices, 'Signed out of every other device.')}
          >
            {pending === 'others' ? <Spinner aria-hidden="true" /> : null}
            Sign out other devices
          </Button>
        ) : null
      }
    >
      <ul data-slot="device-list" className="divide-y divide-border">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-3 px-5 py-3.5">
            <MonitorSmartphoneIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
                <span className="truncate">{session.label}</span>
                {session.current ? <Badge variant="secondary">This device</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                Active {lastActive(session.lastSeenAt)} · signed in {new Date(session.createdAt).toLocaleDateString()}
              </div>
            </div>
            <Button
              type="button"
              variant={session.current ? 'outline' : 'danger-ghost'}
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                session.current ? signOut() : run(session.id, () => revokeDevice(session.id), `Signed out ${session.label}.`)
              }
            >
              {pending === session.id ? <Spinner aria-hidden="true" /> : null}
              Sign out
            </Button>
          </li>
        ))}
      </ul>
    </SettingsGroup>
  )
}
