import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CopyIcon, KeyRoundIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import type { ApiTokenScope, CreateApiTokenResponse } from '@open-mercato/cezar-api-client'
import { authQueryKeys, createApiToken, revokeApiToken, useApiTokens } from '@/api/auth'
import { errorText } from '@/components/auth/auth-frame'
import { CodeField } from '@/components/auth/code-field'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toaster'
import { lastActive } from './security-section'
import { SettingsError, SettingsGroup, SettingsLoading } from './settings-field'

/**
 * Settings → Security → API tokens (spec 2026-10-24-cezar-mcp-server §4): the Bearer credential
 * for cezar's MCP endpoint, `cez --server` and scripts. A value is shown once — the server keeps
 * only its hash — and minting one asks for a fresh authenticator code like every credential change.
 */

const SCOPES: Array<{ id: ApiTokenScope; label: string; hint: string }> = [
  { id: 'read', label: 'Read', hint: 'Reads that carry no secret: task status, workflows, the repo. Runs nothing — the one to share.' },
  { id: 'runs.transcript', label: 'Transcripts', hint: 'Read a task’s thread and live events — tool output can hold secrets. Tasks includes it.' },
  { id: 'tasks', label: 'Tasks', hint: 'Start, steer and stop tasks; dispatch. A task runs code as cezar’s user on this machine.' },
  { id: 'author', label: 'Author', hint: 'Write workflows, skills, automations, env files and the tracker connection — which run code too.' },
  { id: 'admin', label: 'Admin', hint: 'Everything, terminals, settings and self-update included.' },
]

const EXPIRY = [
  { id: 'never', label: 'Never', days: 0 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: '365', label: '1 year', days: 365 },
] as const

export function ApiTokensGroup() {
  const queryClient = useQueryClient()
  const tokens = useApiTokens()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  const revoke = (id: string, name: string) => {
    setPending(id)
    revokeApiToken(id)
      .then(() => {
        toast(`Revoked ${name}.`)
        return queryClient.invalidateQueries({ queryKey: authQueryKeys.tokens })
      })
      .catch((cause: unknown) => toast(errorText(cause), { tone: 'danger' }))
      .finally(() => setPending(null))
  }

  if (tokens.isPending) return <SettingsLoading label="Loading API tokens" />
  if (tokens.isError) return <SettingsError title="Could not load your API tokens">{errorText(tokens.error)}</SettingsError>
  const list = tokens.data.tokens

  return (
    <SettingsGroup
      title="API tokens"
      description={
        <>
          For cezar's MCP server and <code className="font-mono text-foreground">cez --server</code>: a coding agent on your
          desktop or a script calls this cockpit with one. Each is shown once and can be revoked here.
        </>
      }
      actions={
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          New token
        </Button>
      }
    >
      {list.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-muted-foreground">No tokens yet.</p>
      ) : (
        <ul data-slot="api-token-list" className="divide-y divide-border">
          {list.map((token) => (
            <li key={token.id} className="flex items-center gap-3 px-5 py-3.5">
              <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-foreground">
                  <span className="truncate">{token.name}</span>
                  {token.scopes.map((scope) => (
                    <Badge key={scope} variant="secondary">
                      {scope}
                    </Badge>
                  ))}
                </div>
                <div className="text-xs text-muted-foreground">
                  {token.lastUsedAt ? `Used ${lastActive(token.lastUsedAt)}` : 'Never used'} · created{' '}
                  {new Date(token.createdAt).toLocaleDateString()}
                  {token.expiresAt ? ` · expires ${new Date(token.expiresAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <Button type="button" variant="danger-ghost" size="sm" disabled={pending !== null} onClick={() => revoke(token.id, token.name)}>
                {pending === token.id ? <Spinner aria-hidden="true" /> : null}
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <NewTokenDialog open={open} onOpenChange={setOpen} />
    </SettingsGroup>
  )
}

function NewTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiTokenScope[]>(['tasks'])
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]['id']>('90')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreateApiTokenResponse | null>(null)

  const close = () => {
    onOpenChange(false)
    setName('')
    setScopes(['tasks'])
    setExpiry('90')
    setCode('')
    setError(null)
    setCreated(null)
  }

  const ready = name.trim() !== '' && scopes.length > 0 && code.length === 6
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    const days = EXPIRY.find((entry) => entry.id === expiry)?.days ?? 0
    createApiToken({
      name: name.trim(),
      scopes,
      code,
      ...(days > 0 ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
    })
      .then((result) => {
        setCreated(result)
        void queryClient.invalidateQueries({ queryKey: authQueryKeys.tokens })
      })
      .catch((cause: unknown) => {
        setError(errorText(cause))
        setCode('')
      })
      .finally(() => setBusy(false))
  }

  const toggle = (scope: ApiTokenScope, on: boolean) =>
    setScopes((current) => (on ? [...new Set([...current, scope])] : current.filter((entry) => entry !== scope)))

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Your new token</DialogTitle>
              <DialogDescription>Copy it now — it will not be shown again.</DialogDescription>
            </DialogHeader>
            <TokenValue value={created.value} />
            <DialogFooter>
              <Button type="button" variant="contrast" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form className="contents" onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>New API token</DialogTitle>
              <DialogDescription>Pick only the scopes it needs. Scopes bound the API, not the machine: Tasks and Author can run code here, so treat them like your own login.</DialogDescription>
            </DialogHeader>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="token-name">Name</FieldLabel>
                <Input id="token-name" value={name} maxLength={100} placeholder="Claude Code on my laptop" onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel>Scopes</FieldLabel>
                <div className="flex flex-col gap-2">
                  {SCOPES.map((scope) => (
                    <label key={scope.id} htmlFor={`token-scope-${scope.id}`} className="flex items-start gap-2.5 text-[13px]">
                      <Checkbox
                        id={`token-scope-${scope.id}`}
                        checked={scopes.includes(scope.id)}
                        onCheckedChange={(next) => toggle(scope.id, next === true)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium text-foreground">{scope.label}</span>
                        <span className="block text-muted-foreground">{scope.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>
              <Field>
                <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
                <NativeSelect id="token-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value as typeof expiry)}>
                  {EXPIRY.map((entry) => (
                    <NativeSelectOption key={entry.id} value={entry.id}>
                      {entry.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="token-code">Authenticator code</FieldLabel>
                <div className="flex">
                  <CodeField id="token-code" value={code} onChange={setCode} autoFocus={false} disabled={busy} invalid={error !== null} />
                </div>
                <FieldError>{error}</FieldError>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant="contrast" disabled={busy || !ready}>
                {busy ? <Spinner aria-hidden="true" /> : null}
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TokenValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const endpoint = `${window.location.origin}/api/v1/mcp`
  const copy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => toast('Could not copy — select the token and copy it by hand.', { tone: 'danger' }))
  }
  return (
    <div data-slot="api-token-value" className="flex flex-col gap-3">
      <code className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12.5px] text-foreground">{value}</code>
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy token'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Add this cockpit to Claude Code:
        <code className="mt-1 block break-all font-mono text-foreground">
          claude mcp add --transport http cezar {endpoint} --header "Authorization: Bearer {'<token>'}"
        </code>
      </p>
    </div>
  )
}
