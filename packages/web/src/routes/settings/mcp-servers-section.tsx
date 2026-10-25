import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, FlaskConicalIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  mcpSecretNames,
  queryScope,
  secretNameIssue,
  type McpCatalogEntry,
  type McpProjectApproval,
  type McpRegistryEntry,
  type McpScope,
  type McpSecretBindings,
  type McpServer,
  type McpServerDefinition,
  type McpServerKey,
  type McpServerTestResponse,
} from '@open-mercato/cezar-api-client'
import { approveProjectMcp, confirmPrivateMcpOverride, deleteMcpServer, putMcpServer, saveProjectSecret, searchMcpRegistry, testMcpServer } from '@/api/client'
import { queryKeys, useMcpServers, useProjectSecrets, useWorkspaceSecrets, workspaceQueryKeys } from '@/api/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { applyKeyChoices, launchLine, parsePastedDefinition } from './mcp-servers-helpers'
import { SettingsGroup, SettingsNote, SettingsPane } from './settings-field'

const SCOPE_FILES: Record<McpScope, string> = { project: '.ai/cezar/mcp.json', private: '.ai/cezar/mcp.local.json' }
const NEW_SECRET = '__new__'

/** What the operator picks for one catalog key: an existing secret, or a value to store as one. */
type KeyChoice = { secret: string } | { create: string; value: string }

function useInvalidate() {
  const queryClient = useQueryClient()
  return (projectId: string | null) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.allFor(projectId ?? '') }),
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.allFor(projectId ?? '') }),
      queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.secrets }),
    ])
}

function ScopePicker({ value, onChange }: { value: McpScope; onChange: (scope: McpScope) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium text-foreground">Where it is stored</legend>
      {(['project', 'private'] as const).map((scope) => (
        <label key={scope} className="flex items-start gap-2.5 text-[13px]">
          <input
            type="radio"
            name="mcp-scope"
            className="mt-0.5"
            checked={value === scope}
            onChange={() => onChange(scope)}
            aria-label={scope === 'project' ? 'Project' : 'Private'}
          />
          <span>
            <span className="font-medium">{scope === 'project' ? 'Project' : 'Private'}</span>{' '}
            <code className="font-mono text-xs text-muted-foreground">{SCOPE_FILES[scope]}</code>
            <span className="block text-xs text-muted-foreground">
              {scope === 'project'
                ? 'Committed with the repository and shared with your team. Secrets stay references.'
                : 'Only on this machine, never committed. Replaces an approved project server of the same name once you confirm it.'}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function ServerRow({ server, editable }: { server: McpServer; editable: boolean }) {
  const invalidate = useInvalidate()
  const [result, setResult] = useState<McpServerTestResponse | null>(null)
  const testing = useMutation({
    mutationFn: () => testMcpServer(server.scope, server.name),
    onSuccess: setResult,
    onError: (e: Error) => setResult({ ok: false, reason: e.message }),
  })
  const removing = useMutation({
    mutationFn: async () => { const projectId = queryScope(); await deleteMcpServer(server.scope, server.name); return projectId },
    onSuccess: async (projectId) => { await invalidate(projectId); toast(`${server.name} removed`) },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })
  const overriding = useMutation({
    mutationFn: async () => { const projectId = queryScope(); await confirmPrivateMcpOverride(server.name, server.override?.hash ?? ''); return projectId },
    onSuccess: async (projectId) => { await invalidate(projectId); toast(`${server.name} now replaces the project server`) },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })
  const target = server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url
  return (
    <li className="space-y-2 px-5 py-3" data-slot="mcp-server-row" data-scope={server.scope} data-name={server.name}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="font-mono text-[13px] text-foreground">{server.name}</code>
          <Badge variant="outline">{server.transport}</Badge>
          {server.shadowed ? <Badge variant="secondary" title="A private server of the same name is used instead">replaced by private</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" aria-label={`Test ${server.name}`} disabled={!editable || testing.isPending} onClick={() => testing.mutate()}>
            <FlaskConicalIcon aria-hidden="true" /> {testing.isPending ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="outline" size="sm" aria-label={`Remove ${server.name}`} disabled={!editable || removing.isPending} onClick={() => removing.mutate()}>
            <Trash2Icon aria-hidden="true" /> Remove
          </Button>
        </div>
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">{target}</p>
      {server.override && !server.override.confirmed ? (
        <SettingsNote tone="danger" data-slot="mcp-override">
          A project server is named <code className="font-mono">{server.name}</code> too. Once that one is approved, this private server is skipped at launch until you confirm it replaces it.{' '}
          <Button variant="outline" size="sm" disabled={!editable || overriding.isPending} onClick={() => overriding.mutate()}>Confirm replacement</Button>
        </SettingsNote>
      ) : null}
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" aria-label={`Agents ${server.name} reaches`}>
        Reaches:
        {server.reach.map((reach) => (
          <span
            key={reach.runner}
            title={reach.note}
            data-reach={reach.reach}
            className={reach.reach === 'yes' ? 'text-foreground' : reach.reach === 'maybe' ? 'italic' : 'line-through opacity-60'}
          >
            {reach.runner}
          </span>
        ))}
      </p>
      {server.secrets.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Secrets: {server.secrets.map((name) => (
            <code key={name} className={`mr-1.5 font-mono ${server.missingSecrets.includes(name) || (server.boundSecrets && !server.boundSecrets.includes(name)) ? 'text-destructive' : ''}`}>
              {name}{server.missingSecrets.includes(name) ? ' (not stored for cezar)' : server.boundSecrets && !server.boundSecrets.includes(name) ? ' (not bound — approve to bind)' : ''}
            </code>
          ))}
        </p>
      ) : null}
      {server.status ? (
        <p className={`text-xs ${server.status.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} data-slot="mcp-status">
          Last launch ({server.status.runner}, {new Date(server.status.at).toLocaleString()}):{' '}
          {server.status.state === 'injected' ? 'injected' : `not attached — ${server.status.reason ?? 'unknown reason'}`}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Not launched yet.</p>
      )}
      {result ? (
        result.ok ? (
          <SettingsNote data-slot="mcp-test-result">
            {result.tools.length === 0 ? 'Answered, with no tools.' : `${result.tools.length} tools: ${result.tools.join(', ')}`}
          </SettingsNote>
        ) : (
          <SettingsNote tone="danger" role="alert" data-slot="mcp-test-result">{result.reason}</SettingsNote>
        )
      ) : null}
    </li>
  )
}

/**
 * The committed file is repo content: nothing in it runs or receives a secret until the operator
 * approves THAT content on this machine (spec 2026-10-24-easy-mcp §5) — a diff of the server
 * entries, a secret-binding checkbox per reference, and Approve.
 */
function ApprovalPanel({ approval, servers, editable }: { approval: McpProjectApproval; servers: McpServer[]; editable: boolean }) {
  const invalidate = useInvalidate()
  const [bindings, setBindings] = useState<McpSecretBindings>(approval.bindings)
  // A new content to review starts from the last approval's bindings, never from the previous review's clicks.
  const approvedKey = `${approval.hash}:${JSON.stringify(approval.bindings)}`
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content, not by the refetched object
  useEffect(() => setBindings(approval.bindings), [approvedKey])
  const pending = approval.state === 'unapproved' || approval.state === 'changed'
  const unbound = servers.some((server) => server.secrets.some((name) => !(server.boundSecrets ?? []).includes(name)))
  const approving = useMutation({
    mutationFn: async () => {
      const projectId = queryScope()
      const chosen = Object.fromEntries(
        servers
          .map((server) => [server.name, (bindings[server.name] ?? []).filter((name) => server.secrets.includes(name))] as const)
          .filter(([, names]) => names.length > 0),
      )
      await approveProjectMcp(approval.hash ?? '', chosen)
      return projectId
    },
    onSuccess: async (projectId) => { await invalidate(projectId); toast('Project MCP servers approved on this machine') },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })
  if (approval.state === 'none') return null
  if (!pending && !unbound) {
    return <SettingsNote data-slot="mcp-approval-state">Approved on this machine{approval.approvedAt ? ` (${new Date(approval.approvedAt).toLocaleString()})` : ''}.</SettingsNote>
  }
  const withSecrets = servers.filter((server) => server.secrets.length > 0)
  const toggle = (server: string, name: string, on: boolean) =>
    setBindings((current) => {
      const names = new Set(current[server] ?? [])
      if (on) names.add(name)
      else names.delete(name)
      return { ...current, [server]: [...names] }
    })
  return (
    <div className="space-y-3 rounded-md border border-destructive/40 p-4" data-slot="mcp-approval" data-state={approval.state}>
      <p className="text-[13px] font-medium text-foreground">
        {approval.state === 'changed' ? 'Changed — review and approve' : approval.state === 'unapproved' ? 'Not approved yet — review and approve' : 'Bind secrets — review and approve'}
      </p>
      <p className="text-xs text-muted-foreground">
        <code className="font-mono">{SCOPE_FILES.project}</code> is part of the repository. None of its servers runs, and none receives a secret, until you approve this content on this machine. Any later change to the file asks again. <span data-slot="mcp-test-unapproved">Test runs this server now, even unapproved; approval gates agent launches.</span>
      </p>
      {pending ? (
        approval.changes.length === 0 ? (
          <p className="text-xs text-muted-foreground">No server entry changed — only formatting or other keys of the file.</p>
        ) : (
          <ul className="space-y-2" aria-label="Changes since the last approval">
            {approval.changes.map((change) => (
              <li key={change.name} className="space-y-1" data-slot="mcp-approval-change" data-change={change.change}>
                <p className="flex items-center gap-2 text-xs">
                  <code className="font-mono text-foreground">{change.name}</code>
                  <Badge variant="outline">{change.change}</Badge>
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {change.before !== undefined ? <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all" aria-label={`${change.name} before`}>{change.before}</pre> : null}
                  {change.after !== undefined ? <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all" aria-label={`${change.name} after`}>{change.after}</pre> : null}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {withSecrets.length > 0 ? (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-foreground">Secrets each server may receive — unchecked ones are not resolved, and that server is skipped</legend>
          {withSecrets.map((server) => server.secrets.map((name) => (
            <label key={`${server.name}:${name}`} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={(bindings[server.name] ?? []).includes(name)}
                onChange={(event) => toggle(server.name, name, event.target.checked)}
                aria-label={`Give ${name} to ${server.name}`}
              />
              <span><code className="font-mono">{name}</code> to <code className="font-mono">{server.name}</code></span>
            </label>
          )))}
        </fieldset>
      ) : null}
      <div className="flex justify-end">
        <Button size="sm" disabled={!editable || approving.isPending || !approval.hash} onClick={() => approving.mutate()}>Approve</Button>
      </div>
    </div>
  )
}

function ServerList({ scope, servers, problems, editable, approval }: { scope: McpScope; servers: McpServer[]; problems: string[]; editable: boolean; approval?: McpProjectApproval }) {
  return (
    <SettingsGroup
      bare
      title={scope === 'project' ? 'Project' : 'Private'}
      description={
        scope === 'project'
          ? <>Stored in <code className="font-mono">{SCOPE_FILES.project}</code> — committed, shared with your team. Credentials are <code className="font-mono">{'${{ secrets.KEY }}'}</code> references, resolved at launch.</>
          : <>Stored in <code className="font-mono">{SCOPE_FILES.private}</code> — this machine only, never committed.</>
      }
    >
      {approval ? <ApprovalPanel approval={approval} servers={servers} editable={editable} /> : null}
      {problems.map((problem) => (
        <SettingsNote key={problem} tone="danger">{problem}</SettingsNote>
      ))}
      {servers.length === 0 ? (
        <SettingsNote>No {scope} servers.</SettingsNote>
      ) : (
        <Card flush>
          <ul className="divide-y divide-border" aria-label={`${scope} MCP servers`}>
            {servers.map((server) => <ServerRow key={server.name} server={server} editable={editable} />)}
          </ul>
        </Card>
      )}
    </SettingsGroup>
  )
}

/** One catalog or registry entry, picked: name, keys, destination, then Add. */
function ConfigureEntry({
  entry,
  unreviewed,
  onDone,
}: {
  entry: { title: string; description: string; docsUrl?: string; suggestedName: string; definition: McpServerDefinition; keys: McpServerKey[]; oauth?: boolean }
  unreviewed: boolean
  onDone: () => void
}) {
  const invalidate = useInvalidate()
  const projectSecrets = useProjectSecrets()
  const workspaceSecrets = useWorkspaceSecrets()
  const [name, setName] = useState(entry.suggestedName)
  const [scope, setScope] = useState<McpScope>('project')
  const [choices, setChoices] = useState<Record<string, KeyChoice | undefined>>({})
  const [error, setError] = useState<string | null>(null)
  const stored = useMemo(() => {
    const byName = new Map<string, { name: string; audiences: string[]; where: string }>()
    for (const secret of workspaceSecrets.data?.secrets ?? []) byName.set(secret.name, { ...secret, where: 'workspace' })
    for (const secret of projectSecrets.data?.secrets ?? []) byName.set(secret.name, { ...secret, where: 'project' })
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [projectSecrets.data, workspaceSecrets.data])

  // A key whose name is already stored is picked by default; otherwise the operator pastes one.
  useEffect(() => {
    setChoices((current) => {
      const next = { ...current }
      for (const key of entry.keys) {
        if (next[key.name]) continue
        next[key.name] = stored.some((secret) => secret.name === key.name) ? { secret: key.name } : { create: key.name, value: '' }
      }
      return next
    })
  }, [entry.keys, stored])

  const adding = useMutation({
    mutationFn: async () => {
      const projectId = queryScope()
      const picked: Record<string, string | undefined> = {}
      for (const key of entry.keys) {
        const choice = choices[key.name]
        if (!choice) continue
        if ('secret' in choice) { picked[key.name] = choice.secret; continue }
        if (!choice.value) {
          if (key.required) throw new Error(`${key.name} is required`)
          continue
        }
        const issue = secretNameIssue(choice.create)
        if (issue) throw new Error(`${choice.create}: ${issue}`)
        // A pasted value becomes a project secret only cezar reads — never an agent's own env.
        await saveProjectSecret(choice.create, { value: choice.value, audiences: ['cezar'] })
        picked[key.name] = choice.create
      }
      await putMcpServer(scope, name, applyKeyChoices(entry.definition, picked))
      return projectId
    },
    onSuccess: async (projectId) => {
      await invalidate(projectId)
      toast(`${name} added to ${scope === 'project' ? 'the project' : 'private'} MCP servers`)
      onDone()
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <form
      className="flex flex-col gap-4 px-5 pb-5"
      autoComplete="off"
      onSubmit={(event) => { event.preventDefault(); setError(null); adding.mutate() }}
    >
      <div className="space-y-1">
        <p className="text-[13px] text-muted-foreground">{entry.description}</p>
        {entry.docsUrl ? (
          <a href={entry.docsUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline">
            Docs <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>
      {unreviewed ? (
        <SettingsNote tone="danger">From the MCP Registry — unreviewed by cezar. Read the command below before adding it: it runs on this machine.</SettingsNote>
      ) : null}
      {entry.oauth ? (
        <SettingsNote>Signs in through OAuth in a browser the first time. A headless task may not be able to finish that sign-in.</SettingsNote>
      ) : null}
      <div className="space-y-1.5">
        <Label>Runs</Label>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all" data-slot="mcp-launch-line">{launchLine(entry.definition)}</pre>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mcp-entry-name">Name</Label>
        <Input id="mcp-entry-name" value={name} onChange={(event) => setName(event.target.value)} className="font-mono" spellCheck={false} />
      </div>
      {entry.keys.map((key) => {
        const choice = choices[key.name]
        const selected = choice && 'secret' in choice ? choice.secret : NEW_SECRET
        const existing = choice && 'secret' in choice ? stored.find((secret) => secret.name === choice.secret) : undefined
        return (
          <div key={key.name} className="space-y-1.5" data-slot="mcp-key" data-key={key.name}>
            <Label htmlFor={`mcp-key-${key.name}`}>
              <code className="font-mono">{key.name}</code>{key.required ? '' : ' (optional)'}
            </Label>
            <p className="text-xs text-muted-foreground">{key.description}</p>
            <NativeSelect
              id={`mcp-key-${key.name}`}
              aria-label={`Secret for ${key.name}`}
              value={selected}
              onChange={(event) => {
                const value = event.target.value
                setChoices((current) => ({ ...current, [key.name]: value === NEW_SECRET ? { create: key.name, value: '' } : { secret: value } }))
              }}
            >
              <NativeSelectOption value={NEW_SECRET}>Paste a new value…</NativeSelectOption>
              {stored.map((secret) => (
                <NativeSelectOption key={secret.name} value={secret.name}>
                  {secret.name} ({secret.where})
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {existing && !existing.audiences.includes('cezar') ? (
              <SettingsNote tone="danger">{existing.name} is not readable by cezar — save it again in Secrets with the cezar audience, or paste a new value.</SettingsNote>
            ) : null}
            {choice && 'create' in choice ? (
              <Input
                type="password"
                autoComplete="off"
                aria-label={`Value for ${key.name}`}
                placeholder={`stored as the project secret ${choice.create}`}
                value={choice.value}
                onChange={(event) => setChoices((current) => ({ ...current, [key.name]: { create: choice.create, value: event.target.value } }))}
              />
            ) : null}
          </div>
        )
      })}
      <ScopePicker value={scope} onChange={setScope} />
      {error ? <SettingsNote tone="danger" role="alert">{error}</SettingsNote> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={adding.isPending || name === ''}>Add</Button>
      </div>
    </form>
  )
}

function CatalogSheet({ open, onOpenChange, catalog }: { open: boolean; onOpenChange: (open: boolean) => void; catalog: McpCatalogEntry[] }) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [picked, setPicked] = useState<{ entry: McpCatalogEntry | McpRegistryEntry; unreviewed: boolean } | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 400)
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => { if (!open) { setPicked(null); setQuery('') } }, [open])
  // The registry is a network call made only when the operator types (spec §6).
  const registry = useQuery({
    queryKey: ['mcp-registry', debounced],
    queryFn: ({ signal }) => searchMcpRegistry(debounced, { signal }),
    enabled: open && debounced.length > 0,
    staleTime: 60 * 60 * 1000,
  })
  const needle = query.trim().toLowerCase()
  const curated = catalog.filter((entry) => !needle || `${entry.title} ${entry.description}`.toLowerCase().includes(needle))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[520px]" data-slot="mcp-catalog-sheet">
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="text-[15px]">{picked ? picked.entry.title : 'Add an MCP server'}</SheetTitle>
          <SheetDescription className="text-[13px]">
            {picked ? 'Pick a secret for each key; the definition stores a reference, never the value.' : 'Curated servers, or search the MCP Registry.'}
          </SheetDescription>
        </SheetHeader>
        {picked && picked.entry.definition ? (
          <ConfigureEntry
            entry={{ ...picked.entry, definition: picked.entry.definition }}
            unreviewed={picked.unreviewed}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <div className="flex flex-col gap-4 px-5 pb-5">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input aria-label="Search MCP servers" placeholder="Search the catalog and the MCP Registry" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" />
            </div>
            <ul className="flex flex-col gap-1" aria-label="Curated MCP servers">
              {curated.map((entry) => (
                <li key={entry.id}>
                  <Button type="button" variant="ghost" className="h-auto w-full flex-col items-start gap-0.5 px-3 py-2 text-left whitespace-normal" onClick={() => setPicked({ entry, unreviewed: false })}>
                    <span className="text-[13.5px] font-medium">{entry.title}</span>
                    <span className="text-xs font-normal text-muted-foreground">{entry.description}</span>
                  </Button>
                </li>
              ))}
              {curated.length === 0 ? <li className="px-3 text-xs text-muted-foreground">No curated server matches.</li> : null}
            </ul>
            {debounced ? (
              <section className="space-y-2" aria-label="MCP Registry results">
                <h3 className="text-[13px] font-semibold">MCP Registry <Badge variant="outline">unreviewed</Badge></h3>
                {registry.isPending ? <SettingsNote>Searching…</SettingsNote> : null}
                {registry.data && !registry.data.available ? <SettingsNote tone="danger">{registry.data.reason}</SettingsNote> : null}
                {registry.isError ? <SettingsNote tone="danger">{(registry.error as Error).message}</SettingsNote> : null}
                {registry.data?.available && registry.data.items.length === 0 ? <SettingsNote>No registry results.</SettingsNote> : null}
                <ul className="flex flex-col gap-1">
                  {(registry.data?.items ?? []).map((item) => (
                    <li key={item.id}>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={!item.definition}
                        title={item.definition ? undefined : 'No package or remote cezar can launch'}
                        className="h-auto w-full flex-col items-start gap-0.5 px-3 py-2 text-left whitespace-normal"
                        onClick={() => setPicked({ entry: item, unreviewed: true })}
                      >
                        <span className="text-[13.5px] font-medium">{item.title} <Badge variant="outline">unreviewed</Badge></span>
                        <span className="font-mono text-[11px] text-muted-foreground">{item.id}</span>
                        <span className="text-xs font-normal text-muted-foreground">{item.description}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ManualSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const invalidate = useInvalidate()
  const [name, setName] = useState('')
  const [text, setText] = useState('{\n  "command": "npx",\n  "args": ["-y", "some-mcp-server"],\n  "env": { "API_KEY": "${{ secrets.SOME_API_KEY }}" }\n}')
  // A pasted block is the likeliest to carry a literal key: this machine only, unless the operator picks Project.
  const [scope, setScope] = useState<McpScope>('private')
  const [error, setError] = useState<string | null>(null)
  const adding = useMutation({
    mutationFn: async () => {
      const parsed = parsePastedDefinition(text, name)
      if ('error' in parsed) throw new Error(parsed.error)
      const projectId = queryScope()
      await putMcpServer(scope, parsed.name, parsed.definition)
      return { projectId, name: parsed.name, secrets: mcpSecretNames(parsed.definition) }
    },
    onSuccess: async ({ projectId, name: added }) => {
      await invalidate(projectId)
      toast(`${added} added`)
      onOpenChange(false)
    },
    onError: (e: Error) => setError(e.message),
  })
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[520px]" data-slot="mcp-manual-sheet">
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="text-[15px]">Add an MCP server manually</SheetTitle>
          <SheetDescription className="text-[13px]">
            The <code className="font-mono">.mcp.json</code> shape. Put credentials in Secrets (audience cezar) and reference them as <code className="font-mono">{'${{ secrets.KEY }}'}</code>.
          </SheetDescription>
        </SheetHeader>
        <form className="flex flex-col gap-4 px-5 pb-5" autoComplete="off" onSubmit={(event) => { event.preventDefault(); setError(null); adding.mutate() }}>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-manual-name">Name</Label>
            <Input id="mcp-manual-name" value={name} onChange={(event) => setName(event.target.value)} className="font-mono" placeholder="taken from the JSON when it names one" spellCheck={false} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-manual-json">Definition</Label>
            <Textarea id="mcp-manual-json" value={text} onChange={(event) => setText(event.target.value)} rows={10} className="font-mono text-xs" spellCheck={false} />
          </div>
          <ScopePicker value={scope} onChange={setScope} />
          {error ? <SettingsNote tone="danger" role="alert">{error}</SettingsNote> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={adding.isPending}>Add</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Settings → project → MCP servers (spec 2026-10-24-easy-mcp): the committed and the private
 * file as two lists, a curated catalog plus MCP Registry search, a manual add, and Test. Agent
 * config keeps the agents' own raw files; this section owns cezar's two.
 */
export function McpServersSection() {
  const list = useMcpServers()
  const [sheet, setSheet] = useState<'catalog' | 'manual' | null>(null)
  const editable = list.data?.editable ?? false
  return (
    <SettingsPane data-slot="mcp-servers-settings">
      <SettingsGroup
        bare
        title="MCP servers"
        description="Added to every task of this project at launch, for every agent with a launch-time channel. Secrets are resolved then, in memory — never written to a file."
        actions={
          <>
            <Button size="sm" disabled={!editable} onClick={() => setSheet('catalog')}><PlusIcon aria-hidden="true" /> Add from catalog</Button>
            <Button size="sm" variant="outline" disabled={!editable} onClick={() => setSheet('manual')}>Add manually</Button>
          </>
        }
      >
        {list.isPending ? <SettingsNote>Loading…</SettingsNote> : null}
        {list.isError ? <SettingsNote tone="danger" role="alert">{list.error?.message}</SettingsNote> : null}
        {list.data && !editable ? (
          <SettingsNote>Read-only here: adding, removing and testing servers runs code on the host, so it needs the machine’s owner.</SettingsNote>
        ) : null}
      </SettingsGroup>
      {list.data ? (
        <>
          <ServerList scope="project" servers={list.data.project} problems={list.data.problems.project} editable={editable} approval={list.data.approval} />
          <ServerList scope="private" servers={list.data.private} problems={list.data.problems.private} editable={editable} />
          <CatalogSheet open={sheet === 'catalog'} onOpenChange={(open) => setSheet(open ? 'catalog' : null)} catalog={list.data.catalog} />
          <ManualSheet open={sheet === 'manual'} onOpenChange={(open) => setSheet(open ? 'manual' : null)} />
        </>
      ) : null}
    </SettingsPane>
  )
}
