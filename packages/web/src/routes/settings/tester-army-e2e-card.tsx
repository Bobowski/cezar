import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ExternalLinkIcon, MinusIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { E2E_CREDENTIAL_NAMES, queryScope, type E2eCredentialName, type RunStatus } from '@open-mercato/cezar-api-client'
import { shareProjectSecret, startE2eSetup } from '@/api/client'
import { queryKeys, useE2eStatus, useProjectSecrets, useRun, workspaceQueryKeys } from '@/api/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { scopeTo } from '@/lib/project-router'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { SettingsField, SettingsGroup, SettingsNote } from './settings-field'

/** TesterArmy's own repository — where the card sends someone who wants to know what e2e is. */
export const TESTER_ARMY_REPO = 'https://github.com/tester-army/e2e'

/** The provider behind each key, as the person picking one knows it. */
const PROVIDER_LABELS: Record<E2eCredentialName, string> = {
  AI_GATEWAY_API_KEY: 'Vercel AI Gateway',
  OPENAI_API_KEY: 'OpenAI',
  ANTHROPIC_API_KEY: 'Anthropic',
  OPENROUTER_API_KEY: 'OpenRouter',
}

const IN_FLIGHT: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting'])

/**
 * What a setup run's status means for the person waiting on it. A finished setup whose config is
 * not in the checkout yet has one step left — merging its branch — because the review gate is
 * off by default and `done` alone would read as "nothing left to do".
 */
function setupLine(status: RunStatus, landed: boolean, branch: string | undefined, prUrl: string | undefined): string {
  if (IN_FLIGHT.has(status)) return 'Setting up — cezar is installing and configuring e2e in its own worktree.'
  const mergeIt = prUrl
    ? 'its draft PR is ready — merge it to finish.'
    : `merge ${branch ? `branch ${branch}` : 'the setup task’s branch'} to finish.`
  if (status === 'review') return `Ready for review — ${mergeIt}`
  if (status === 'done') return landed ? 'Setup finished.' : `Setup finished — ${mergeIt}`
  if (status === 'failed') return 'The last setup failed — open the task to see why, then try again.'
  return 'The last setup was cancelled.'
}

function Row({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-[13px]" data-ok={ok}>
      {ok ? <CheckIcon className="size-4 shrink-0 text-success" aria-hidden /> : <MinusIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className={ok ? undefined : 'text-muted-foreground'}>{children}</span>
    </li>
  )
}

/**
 * Settings → project → External integrations → Test frameworks → TesterArmy e2e (spec
 * 2026-10-10-e2e-one-click-setup). One button: cezar
 * installs and configures TesterArmy's `e2e` as a task whose branch the user merges. The model key
 * is optional — smoke tests run without one — and goes to the project's secret store for check
 * steps only, never to an agent.
 */
export function TesterArmyE2eCard() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const status = useE2eStatus()
  // The run record is what the event stream keeps live; the status payload is a snapshot.
  const setupRun = useRun(status.data?.setup?.runId)
  // Until the user picks one, the provider follows the key already stored (else the AI Gateway,
  // `e2e init`'s own default) — re-running a setup should not quietly switch providers.
  const [chosenProvider, setProvider] = useState<E2eCredentialName | undefined>(undefined)
  const [key, setKey] = useState('')
  const [shared, setShared] = useState(false)
  const projectSecrets = useProjectSecrets()
  const [error, setError] = useState<string | null>(null)

  const setupStatus = setupRun.data?.status ?? status.data?.setup?.status
  // http(s) only (#431): the URL is written by `gh`, but a link is still a link.
  const prUrl = setupRun.data?.pullRequestUrl && /^https?:\/\//.test(setupRun.data.pullRequestUrl) ? setupRun.data.pullRequestUrl : undefined
  const inFlight = setupStatus !== undefined && IN_FLIGHT.has(setupStatus)
  const credentials = status.data?.credentials ?? []
  const provider: E2eCredentialName = chosenProvider ?? credentials[0] ?? 'AI_GATEWAY_API_KEY'
  const installed = Boolean(status.data?.configFile && status.data.workflow)

  const starting = useMutation({
    mutationFn: async () => {
      const projectId = queryScope()
      const response = await startE2eSetup(key ? { credential: { name: provider, value: key, ...(shared ? { shared: true } : {}) } } : {})
      return { projectId, runId: response.runId }
    },
    onSuccess: async ({ projectId, runId }) => {
      setKey('')
      setError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.e2e.allFor(projectId ?? '') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.secrets.allFor(projectId ?? '') }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.secrets }),
      ])
      toast('e2e setup started')
      if (queryScope() === projectId) void navigate(scopeTo(projectId, `/tasks/${runId}`))
    },
    // Keep the key on failure: a transient 409 should not cost a re-paste.
    onError: (e: Error) => setError(e.message),
  })

  // A key stored for this project only can be moved to the workspace, where every project's
  // checks read it — the value stays on the server.
  const projectOnly = credentials.filter((name) => projectSecrets.data?.secrets?.some((stored) => stored.name === name))
  const sharing = useMutation({
    mutationFn: async () => {
      const projectId = queryScope()
      for (const name of projectOnly) await shareProjectSecret(name)
      return projectId
    },
    onSuccess: async (projectId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.secrets.allFor(projectId ?? '') }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.secrets }),
      ])
      toast('Model key is now shared with every project')
    },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const badge = inFlight ? 'Setting up' : installed ? 'Installed' : 'Not set up'
  return (
    <div className="flex flex-col gap-8" data-slot="e2e-settings">
      <SettingsGroup>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-start gap-3">
            <img src={testerArmyLogo} alt="" width={40} height={40} className="size-10 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold text-foreground">TesterArmy e2e</h2>
                <Badge
                  variant="secondary"
                  data-slot="e2e-badge"
                  data-state={inFlight ? 'setting-up' : installed ? 'installed' : 'none'}
                  className={cn(installed && !inFlight && 'bg-success/10 text-success')}
                >
                  {badge}
                </Badge>
              </div>
              <p className="text-[13px] text-muted-foreground">Agentic browser end-to-end testing</p>
            </div>
            <Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
              <a href={TESTER_ARMY_REPO} target="_blank" rel="noreferrer">
                tester-army/e2e <ExternalLinkIcon aria-hidden />
              </a>
            </Button>
          </div>
          <p className="max-w-prose text-[13px] text-pretty text-muted-foreground">
            cezar installs it for this project, points it at your dev server, writes a smoke test and an{' '}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">implement-and-e2e</code> workflow, proves it all passes in a real browser and
            opens a draft PR for you to merge.
          </p>
        </div>
        {status.isPending ? (
          <div className="px-5 py-4">
            <SettingsNote>Loading…</SettingsNote>
          </div>
        ) : null}
        {status.isError ? (
          <div className="px-5 py-4">
            <SettingsNote tone="danger" role="alert">
              {status.error.message}
            </SettingsNote>
          </div>
        ) : null}
        {status.data ? (
          <div className="flex flex-col gap-3 px-5 py-4">
            <ul className="flex flex-col gap-1.5" aria-label="e2e status">
              <Row ok={Boolean(status.data.configFile)}>
                {status.data.configFile ? (
                  <>
                    Configured (<code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">{status.data.configFile}</code>)
                  </>
                ) : (
                  'Not configured in this checkout'
                )}
              </Row>
              <Row ok={status.data.workflow}>
                <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">implement-and-e2e</code> workflow{' '}
                {status.data.workflow ? 'available' : 'not added yet'}
              </Row>
              <Row ok={credentials.length > 0}>
                {credentials.length > 0 ? (
                  <>
                    Model key: <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">{credentials.join(', ')}</code>
                  </>
                ) : (
                  'No model key — smoke tests run without one; agent steps need one'
                )}
              </Row>
            </ul>
            {projectOnly.length > 0 ? (
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground" data-slot="e2e-share-key">
                <span>This key is stored for this project only.</span>
                <Button type="button" variant="outline" size="sm" disabled={sharing.isPending} onClick={() => sharing.mutate()}>
                  Use it in every project
                </Button>
              </div>
            ) : null}
            {status.data.setup && setupStatus ? (
              <p className="text-[13px] text-pretty" data-slot="e2e-setup-run" data-status={setupStatus}>
                {setupLine(setupStatus, Boolean(status.data.configFile), setupRun.data?.branch, prUrl)}{' '}
                {prUrl && !status.data.configFile ? (
                  <>
                    <a className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground" href={prUrl} target="_blank" rel="noreferrer">
                      Open the draft PR
                    </a>
                    {' · '}
                  </>
                ) : null}
                <Link
                  className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
                  to={scopeTo(queryScope(), `/tasks/${status.data.setup.runId}`)}
                >
                  Open the setup task
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>

      <form
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault()
          starting.mutate()
        }}
      >
        <SettingsGroup title={installed ? 'Set up again' : 'Set up e2e'}>
          <SettingsField
            title="Model provider"
            htmlFor="e2e-provider"
            hint="The provider whose key e2e's agent steps use."
            control={
              <NativeSelect
                id="e2e-provider"
                aria-label="Model provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value as E2eCredentialName)}
              >
                {E2E_CREDENTIAL_NAMES.map((name) => (
                  <NativeSelectOption key={name} value={name}>
                    {PROVIDER_LABELS[name]} ({name}){credentials.includes(name) ? ' — stored' : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            }
          />
          <SettingsField
            title="API key (optional)"
            htmlFor="e2e-key"
            hint="Stored encrypted as a project secret for check steps only — never handed to an agent session."
          >
            <Input
              id="e2e-key"
              aria-label="API key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={credentials.includes(provider) ? 'stored — leave empty to keep it' : ''}
            />
            <div className="flex items-center gap-2.5 pt-1">
              <Checkbox id="e2e-key-shared" checked={shared} onCheckedChange={(checked) => setShared(checked === true)} />
              <Label htmlFor="e2e-key-shared" className="font-normal">
                Use this key in every project (stored as a workspace secret)
              </Label>
            </div>
          </SettingsField>
          <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-3">
            {error ? (
              <SettingsNote tone="danger" role="alert" className="mr-auto">
                {error}
              </SettingsNote>
            ) : null}
            <Button type="submit" disabled={starting.isPending || inFlight || !status.data}>
              {inFlight ? 'Setup in progress…' : installed ? 'Set up again' : 'Set up e2e'}
            </Button>
          </div>
        </SettingsGroup>
      </form>
    </div>
  )
}
