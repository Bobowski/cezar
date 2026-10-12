import { CheckIcon, CopyIcon, TerminalIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { AUTH_PASSWORD_MIN, AUTH_USERNAME_RE, type AuthSetupBeginResponse } from '@open-mercato/cezar-api-client'
import { beginSetup, completeSetup } from '@/api/auth'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { AuthFrame, errorText } from './auth-frame'
import { CodeField } from './code-field'
import { QrCode } from './qr-code'
import { RecoveryCodes } from './recovery-codes'

/** The one-time code `cezar auth setup` put in the link's fragment — never sent anywhere but the API. */
export function setupCodeFromLocation(hash: string = window.location.hash): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('code')?.trim() ?? ''
}

const STEPS = ['Account', 'Authenticator', 'Recovery codes'] as const

function Steps({ current }: { current: number }) {
  return (
    <ol data-slot="setup-steps" className="mb-5 flex items-center gap-2 text-xs text-muted-foreground">
      {STEPS.map((label, index) => (
        <li
          key={label}
          aria-current={index === current ? 'step' : undefined}
          className="flex min-w-0 flex-1 flex-col gap-1.5 aria-[current=step]:text-foreground"
        >
          <span className={`h-1 rounded-full ${index <= current ? 'bg-primary' : 'bg-muted'}`} />
          <span className="truncate">{label}</span>
        </li>
      ))}
    </ol>
  )
}

/**
 * First-run setup, and the same screen after `cezar auth reset` (spec
 * 2026-10-12-cockpit-authentication §5.1): account → authenticator → recovery codes. The session
 * already exists when the codes are shown; `onDone` is held back until the user says they kept
 * them, because that screen is the only time the server sends them.
 */
export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [linkCode] = useState(setupCodeFromLocation)
  const [setupCode, setSetupCode] = useState(linkCode)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [enrolment, setEnrolment] = useState<AuthSetupBeginResponse | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  const [secretCopied, setSecretCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = username.trim().toLowerCase()
  const nameProblem = name !== '' && !AUTH_USERNAME_RE.test(name) ? 'Lowercase letters, digits, ".", "_" or "-".' : null
  const passwordProblem =
    password !== '' && password.length < AUTH_PASSWORD_MIN ? `At least ${AUTH_PASSWORD_MIN} characters.` : null
  const confirmProblem = confirm !== '' && confirm !== password ? 'The two passwords do not match.' : null
  const accountReady =
    setupCode.trim() !== '' && name !== '' && !nameProblem && password.length >= AUTH_PASSWORD_MIN && confirm === password

  const submitAccount = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !accountReady) return
    setBusy(true)
    setError(null)
    beginSetup({ code: setupCode.trim(), username: name, password })
      .then(setEnrolment)
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false))
  }

  const submitCode = (value: string) => {
    if (busy || !enrolment || value.length !== 6) return
    setBusy(true)
    setError(null)
    completeSetup(enrolment.ticket, value)
      .then((result) => {
        // The link is spent; keep it out of the address bar and the history entry.
        window.history.replaceState(null, '', '/')
        setRecoveryCodes(result.recoveryCodes)
      })
      .catch((cause: unknown) => {
        const message = errorText(cause)
        setCode('')
        if (message.includes('expired')) {
          // The ticket is gone (timed out, or burned by wrong codes) and its QR with it. The setup
          // code is only spent on success, so step one can ask again — and if the link itself has
          // lapsed, `beginSetup` is the one that says to run `cezar auth setup`.
          setEnrolment(null)
          setError(`${message}. Continue to get a new QR code — the one you scanned no longer works.`)
        } else setError(message)
      })
      .finally(() => setBusy(false))
  }

  if (recoveryCodes) {
    return (
      <AuthFrame
        data-screen="setup-recovery"
        title="Save your recovery codes"
        description="If you lose your authenticator, one of these signs you in instead. Each works once, and they will not be shown again."
      >
        <Steps current={2} />
        <FieldGroup className="gap-5">
          <RecoveryCodes codes={recoveryCodes} />
          <Field orientation="horizontal">
            <Checkbox id="auth-saved" checked={saved} onCheckedChange={(next) => setSaved(next === true)} />
            <FieldLabel htmlFor="auth-saved" className="font-normal">
              I saved these codes somewhere safe
            </FieldLabel>
          </Field>
          <Button type="button" size="lg" disabled={!saved} onClick={onDone}>
            Open the cockpit
          </Button>
        </FieldGroup>
      </AuthFrame>
    )
  }

  if (enrolment) {
    return (
      <AuthFrame
        data-screen="setup-authenticator"
        title="Add your authenticator"
        description="Scan the code with an authenticator app — 1Password, Google Authenticator, Authy — then enter the 6 digits it shows."
      >
        <Steps current={1} />
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submitCode(code)
          }}
          noValidate
        >
          <FieldGroup className="gap-5">
            <div className="flex flex-col items-center gap-3">
              <QrCode value={enrolment.otpauthUri} label="Authenticator setup QR code" />
              <div className="flex w-full items-center gap-2">
                <code
                  data-slot="totp-secret"
                  className="min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-center font-mono text-xs break-all text-foreground"
                >
                  {enrolment.secret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Copy the setup key"
                  onClick={() => {
                    void navigator.clipboard.writeText(enrolment.secret).then(() => {
                      setSecretCopied(true)
                      window.setTimeout(() => setSecretCopied(false), 2000)
                    })
                  }}
                >
                  {secretCopied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                </Button>
              </div>
              {/* On the phone that is also the authenticator there is nothing to scan with. */}
              <Button asChild variant="link" size="sm" className="h-auto px-0 text-muted-foreground sm:hidden">
                <a href={enrolment.otpauthUri}>Open in an authenticator app on this device</a>
              </Button>
            </div>
            <Field>
              <FieldLabel htmlFor="auth-setup-code" className="sr-only">
                Authenticator code
              </FieldLabel>
              <CodeField id="auth-setup-code" value={code} onChange={setCode} onComplete={submitCode} disabled={busy} invalid={error !== null} />
              <FieldError className="text-center">{error}</FieldError>
            </Field>
            <Button type="submit" size="lg" disabled={busy || code.length !== 6}>
              {busy ? <Spinner aria-hidden="true" /> : null}
              Verify and continue
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto self-center px-0 text-muted-foreground"
              onClick={() => {
                setEnrolment(null)
                setCode('')
                setError(null)
              }}
            >
              Start over
            </Button>
          </FieldGroup>
        </form>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame
      data-screen="setup-account"
      title="Set up this cockpit"
      description="Create the owner account. You will sign in with it on every device."
      footer="There is no email recovery: a lost password is reset from the server, with cezar auth reset."
    >
      <Steps current={0} />
      <form onSubmit={submitAccount} noValidate>
        <FieldGroup className="gap-5">
          {linkCode === '' ? (
            <>
              <Alert>
                <TerminalIcon aria-hidden="true" />
                <AlertTitle>Start on the server</AlertTitle>
                <AlertDescription>
                  <p>
                    Run <code className="font-mono text-foreground">cezar auth setup</code> on the machine hosting this
                    cockpit and open the link it prints — or paste its code below.
                  </p>
                </AlertDescription>
              </Alert>
              <Field>
                <FieldLabel htmlFor="auth-setup-link-code">Setup code</FieldLabel>
                <Input
                  id="auth-setup-link-code"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono"
                  value={setupCode}
                  onChange={(event) => setSetupCode(event.target.value)}
                />
              </Field>
            </>
          ) : null}
          <Field>
            <FieldLabel htmlFor="auth-setup-username">Username</FieldLabel>
            <Input
              id="auth-setup-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={linkCode !== ''}
              aria-invalid={nameProblem ? true : undefined}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <FieldError>{nameProblem}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="auth-setup-password">Password</FieldLabel>
            <Input
              id="auth-setup-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={passwordProblem ? true : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {passwordProblem ? (
              <FieldError>{passwordProblem}</FieldError>
            ) : (
              <FieldDescription className="text-xs">At least {AUTH_PASSWORD_MIN} characters. A passphrase works well.</FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="auth-setup-confirm">Confirm password</FieldLabel>
            <Input
              id="auth-setup-confirm"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={confirmProblem ? true : undefined}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <FieldError>{confirmProblem ?? error}</FieldError>
          </Field>
          <Button type="submit" size="lg" disabled={busy || !accountReady}>
            {busy ? <Spinner aria-hidden="true" /> : null}
            Continue
          </Button>
        </FieldGroup>
      </form>
    </AuthFrame>
  )
}
