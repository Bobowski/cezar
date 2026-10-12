import { useState, type FormEvent } from 'react'

import { loginWithPassword, verifyLogin } from '@/api/auth'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { AuthFrame, errorText } from './auth-frame'
import { CodeField } from './code-field'

/**
 * Sign-in, in the two steps the server has (spec 2026-10-12-cockpit-authentication §5.3): the
 * password buys a short-lived ticket, and only the second factor turns it into a session.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [ticket, setTicket] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submitPassword = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    loginWithPassword(username.trim(), password)
      .then((next) => {
        setTicket(next)
        setPassword('')
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false))
  }

  const submitCode = (value: string) => {
    if (busy || !ticket || value.trim() === '') return
    setBusy(true)
    setError(null)
    verifyLogin(ticket, value.trim())
      .then(onSignedIn)
      .catch((cause: unknown) => {
        const message = errorText(cause)
        setError(message)
        setCode('')
        // The ticket is gone (expired, or burned by wrong codes): only the password gets a new one.
        if (message.includes('expired')) setTicket(null)
      })
      .finally(() => setBusy(false))
  }

  if (ticket === null) {
    return (
      <AuthFrame data-screen="login" title="Sign in" description="Use the account that was set up for this cockpit.">
        <form onSubmit={submitPassword} noValidate>
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="auth-username">Username</FieldLabel>
              <Input
                id="auth-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="auth-password">Password</FieldLabel>
              <Input
                id="auth-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={error ? true : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldError>{error}</FieldError>
            </Field>
            <Button type="submit" size="lg" disabled={busy || username.trim() === '' || password === ''}>
              {busy ? <Spinner aria-hidden="true" /> : null}
              Continue
            </Button>
          </FieldGroup>
        </form>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame
      data-screen="login-code"
      title="Two-step verification"
      description={
        recovery
          ? 'Enter one of the recovery codes you saved when you set this account up. Each works once.'
          : 'Enter the 6-digit code from your authenticator app.'
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submitCode(code)
        }}
        noValidate
      >
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="auth-code" className={recovery ? undefined : 'sr-only'}>
              {recovery ? 'Recovery code' : 'Authenticator code'}
            </FieldLabel>
            {recovery ? (
              <Input
                id="auth-code"
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="xxxxx-xxxxx"
                className="font-mono"
                aria-invalid={error ? true : undefined}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            ) : (
              <CodeField id="auth-code" value={code} onChange={setCode} onComplete={submitCode} disabled={busy} invalid={error !== null} />
            )}
            <FieldError className={recovery ? undefined : 'text-center'}>{error}</FieldError>
          </Field>
          <Button type="submit" size="lg" disabled={busy || code.trim() === ''}>
            {busy ? <Spinner aria-hidden="true" /> : null}
            Sign in
          </Button>
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0 text-muted-foreground"
              onClick={() => {
                setRecovery((current) => !current)
                setCode('')
                setError(null)
              }}
            >
              {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0 text-muted-foreground"
              onClick={() => {
                setTicket(null)
                setCode('')
                setError(null)
                setRecovery(false)
              }}
            >
              Start over
            </Button>
          </div>
          <FieldDescription className="text-center text-xs">
            Lost both? Run <code className="font-mono">cezar auth reset {username.trim() || '<user>'}</code> on the server.
          </FieldDescription>
        </FieldGroup>
      </form>
    </AuthFrame>
  )
}
