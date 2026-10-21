import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { worktreeLifecycleConfigSchema, type ConfigResponse, type LifecyclePreviewResponse, type ScriptEntry, type WorktreeLifecycleConfig } from '@open-mercato/cezar-api-client'
import { getConfig, previewLifecycleCommand, putConfig } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useWorktreeLifecycles } from '@/api/worktree-lifecycle'
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, EyeIcon, PlusIcon, TerminalSquareIcon, Trash2Icon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SettingsField, SettingsNote, SettingsSelect } from './settings-field'

const empty = (): WorktreeLifecycleConfig => ({ afterCreate: [], beforeRemove: [] })
const phases = ['afterCreate', 'beforeRemove'] as const
const titles = { afterCreate: 'After worktree creation', beforeRemove: 'Before worktree removal' }
const variables = [
  ['root_path', 'The selected project’s root directory'],
  ['worktree_path', 'The isolated worktree directory'],
  ['worktree_id', 'Stable cez-prefixed resource identity'],
  ['task_id', 'The original task ID'],
] as const

/** Local drafts survive validation/conflict failures. Saving config never resumes a parked task. */
export function WorktreeLifecycleEditor({ config }: { config: ConfigResponse }) {
  const client = useQueryClient()
  const configKey = queryKeys.config
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const lifecycle = useWorktreeLifecycles()
  const [draft, setDraft] = useState<WorktreeLifecycleConfig>(config.worktreeLifecycle ?? empty())
  const [baseline, setBaseline] = useState(config.worktreeLifecycle ?? empty())
  const [revision, setRevision] = useState<string | null>(config.worktreeLifecycleRevision ?? null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [previewWorktree, setPreviewWorktree] = useState('')
  const [previews, setPreviews] = useState<Record<string, LifecyclePreviewResponse>>({})
  const [previewing, setPreviewing] = useState<string | null>(null)
  const editors = useRef(new Map<string, HTMLTextAreaElement>())
  const currentPreview = useRef({ draft, previewWorktree })
  currentPreview.current = { draft, previewWorktree }
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  useEffect(() => {
    if (dirty) return
    const next = config.worktreeLifecycle ?? empty()
    setDraft(next); setBaseline(next); setRevision(config.worktreeLifecycleRevision ?? null)
  }, [config.worktreeLifecycle, config.worktreeLifecycleRevision, dirty])

  const update = (phase: typeof phases[number], id: string, patch: Partial<ScriptEntry>) => {
    setDraft(current => ({ ...current, [phase]: current[phase].map(entry => entry.id === id ? { ...entry, ...patch } : entry) }))
    setErrors(current => ({ ...current, [id]: '' })); setMessage('')
    setPreviews(current => { const next = { ...current }; delete next[id]; return next })
  }
  const insert = (phase: typeof phases[number], entry: ScriptEntry, name: typeof variables[number][0]) => {
    const editor = editors.current.get(entry.id)
    const start = editor?.selectionStart ?? entry.command.length
    const end = editor?.selectionEnd ?? start
    const token = `{{ ${name} }}`
    update(phase, entry.id, { command: entry.command.slice(0, start) + token + entry.command.slice(end) })
    requestAnimationFrame(() => { editor?.focus(); editor?.setSelectionRange(start + token.length, start + token.length) })
  }
  const move = (phase: typeof phases[number], index: number, direction: number) => {
    setDraft(current => {
      const entries = [...current[phase]]
      const entry = entries.splice(index, 1)[0]!
      entries.splice(index + direction, 0, entry)
      return { ...current, [phase]: entries }
    }); setMessage('')
  }
  const preview = async (entry: ScriptEntry) => {
    setPreviewing(entry.id)
    try {
      const value = await previewLifecycleCommand({ command: entry.command, ...(previewWorktree ? { worktreeId: previewWorktree } : {}) })
      const latest = phases.flatMap(phase => currentPreview.current.draft[phase]).find(item => item.id === entry.id)
      if (!mounted.current || latest?.command !== entry.command || currentPreview.current.previewWorktree !== previewWorktree) return
      setPreviews(current => ({ ...current, [entry.id]: value })); setErrors(current => ({ ...current, [entry.id]: '' }))
    } catch (error) { setErrors(current => ({ ...current, [entry.id]: error instanceof Error ? error.message : 'Preview failed' })) }
    finally { setPreviewing(null) }
  }
  const save = useMutation({
    mutationFn: async () => {
      setErrors({}); setMessage('')
      const parsed = worktreeLifecycleConfigSchema.safeParse(draft)
      if (!parsed.success) {
        const errors: Record<string, string> = {}
        for (const issue of parsed.error.issues) {
          const phase = issue.path[0] as typeof phases[number]
          const id = typeof issue.path[1] === 'number' ? draft[phase]?.[issue.path[1]]?.id : undefined
          errors[id ?? 'form'] = issue.message
        }
        setErrors(errors); throw new Error('Check the highlighted commands before saving.')
      }
      // Server validation owns shell grammar; preview neither executes nor expands a shell.
      for (const phase of phases) for (const entry of parsed.data[phase]) {
        if (!mounted.current) throw new Error('Settings closed; saving cancelled.')
        try { await previewLifecycleCommand({ command: entry.command }) }
        catch (error) { setErrors({ [entry.id]: error instanceof Error ? error.message : 'Invalid template' }); throw new Error('Check the highlighted command before saving.') }
      }
      if (!mounted.current) throw new Error('Settings closed; saving cancelled.')
      return putConfig({ worktreeLifecycle: parsed.data, worktreeLifecycleRevision: revision })
    },
    onSuccess: result => {
      const value = result.worktreeLifecycle ?? empty()
      setBaseline(value); setDraft(value); setRevision(result.worktreeLifecycleRevision ?? null)
      client.setQueryData(configKey, result)
      setMessage('Saved. Retry uses these commands. Saving does not restart paused scripts.')
    },
  })
  const reload = async () => {
    try {
      const latest = await getConfig()
      client.setQueryData(configKey, latest)
      const value = latest.worktreeLifecycle ?? empty()
      setDraft(value); setBaseline(value); setRevision(latest.worktreeLifecycleRevision ?? null)
      setErrors({}); setPreviews({}); setMessage('Loaded saved scripts.'); save.reset()
    } catch (error) { setErrors({ form: error instanceof Error ? error.message : 'Settings could not be loaded' }) }
  }
  const pending = lifecycle.data?.worktrees.filter(worktree => worktree.operation && worktree.needsAttention) ?? []

  const previewOptions = [
    { value: '', label: 'Example values' },
    ...(lifecycle.data?.worktrees.filter(worktree => worktree.onDisk).map(worktree => ({ value: worktree.worktreeId, label: worktree.task?.title ?? `Orphan ${worktree.runId.slice(0, 8)}` })) ?? []),
  ]

  return <div id="worktree-lifecycle-scripts" className="flex min-w-0 flex-col gap-4" data-slot="worktree-lifecycle-editor">
    <Alert role="note">
      <TerminalSquareIcon aria-hidden="true" />
      <AlertTitle>Runs as the Cezar host user, in each task’s worktree</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>Scripts apply only to this project. Saving commands opts in to running them as the Cezar host user, with that user’s local privileges.</p>
        <p>Runtime: noninteractive Bash, in the isolated worktree directory. Bash must be installed on the host. Commands run in order; the default timeout is 30 minutes.</p>
        <p id="lifecycle-variable-help">Values are shell-escaped; do not wrap variable tokens in quotes. Use <code className="font-mono">{'\\{{'}</code> for literal double braces, for example <code className="font-mono">{"docker inspect --format '\\{{.State.Status}}' container"}</code>.</p>
      </AlertDescription>
    </Alert>

    <Card flush className="divide-y divide-border">
      <SettingsField
        title="Preview context"
        hint="Which worktree a preview fills the variables from."
        control={<SettingsSelect aria-label="Preview context" value={previewWorktree} options={previewOptions} onChange={value => { setPreviewWorktree(value); setPreviews({}) }} />}
      />
      {phases.map(phase => <SettingsField key={phase} title={titles[phase]} hint={phase === 'afterCreate' ? 'Run after a worktree is created and before its agent starts, including recreation after reclamation.' : 'Run while the worktree files still exist, before removal or reclamation. Failure retains the directory for recovery.'}>
        {draft[phase].length === 0 && <SettingsNote>No commands. This phase completes without running a script.</SettingsNote>}
        {draft[phase].map((entry, index) => {
          const label = `${titles[phase].toLowerCase()} command ${index + 1}`
          return <FieldSet key={entry.id} className="min-w-0 gap-3 rounded-lg border border-border p-4" disabled={save.isPending}>
            <FieldLegend variant="label" className="mb-0">Command {index + 1}</FieldLegend>
            <Field>
              <FieldLabel htmlFor={`lifecycle-name-${entry.id}`}>Display name (optional)</FieldLabel>
              <Input id={`lifecycle-name-${entry.id}`} value={entry.name ?? ''} maxLength={120} onChange={event => update(phase, entry.id, { name: event.target.value })} />
            </Field>
            <Field data-invalid={!!errors[entry.id] || undefined}>
              <FieldLabel htmlFor={`lifecycle-command-${entry.id}`}>{titles[phase]} — command {index + 1}</FieldLabel>
              <Textarea id={`lifecycle-command-${entry.id}`} ref={element => { if (element) editors.current.set(entry.id, element); else editors.current.delete(entry.id) }} className="min-h-24 resize-y font-mono text-xs md:text-xs" value={entry.command} maxLength={32 * 1024} spellCheck={false} aria-describedby={`lifecycle-variable-help${errors[entry.id] ? ` lifecycle-error-${entry.id}` : ''}`} aria-invalid={!!errors[entry.id]} onChange={event => update(phase, entry.id, { command: event.target.value })} />
              {errors[entry.id] ? <FieldError id={`lifecycle-error-${entry.id}`} className="text-xs">{errors[entry.id]}</FieldError> : null}
            </Field>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="group/trigger -ml-2 text-muted-foreground">
                  <ChevronRightIcon aria-hidden="true" className="transition-transform group-data-[state=open]/trigger:rotate-90" />Variables
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 space-y-2 text-xs">{variables.map(([name, description]) => <li key={name} className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" aria-label={`Insert ${name} into ${label}`} onClick={() => insert(phase, entry, name)}><code className="font-mono">{`{{ ${name} }}`}</code></Button><span className="text-muted-foreground">{description}</span></li>)}</ul>
              </CollapsibleContent>
            </Collapsible>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="group/trigger -ml-2 text-muted-foreground">
                  <ChevronRightIcon aria-hidden="true" className="transition-transform group-data-[state=open]/trigger:rotate-90" />Advanced timeout
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Field orientation="horizontal" className="mt-1">
                  <FieldLabel htmlFor={`lifecycle-timeout-${entry.id}`} className="font-normal text-muted-foreground">Timeout in seconds (1–86,400; blank uses 1,800)</FieldLabel>
                  <Input id={`lifecycle-timeout-${entry.id}`} type="number" min={1} max={86400} step={1} className="w-32" value={entry.timeoutSeconds ?? ''} onChange={event => update(phase, entry.id, { timeoutSeconds: event.target.value === '' ? undefined : Number(event.target.value) })} />
                </Field>
              </CollapsibleContent>
            </Collapsible>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={index === 0} aria-label={`Move ${label} up`} onClick={() => move(phase, index, -1)}><ArrowUpIcon aria-hidden="true" />Move up</Button>
              <Button type="button" variant="outline" size="sm" disabled={index === draft[phase].length - 1} aria-label={`Move ${label} down`} onClick={() => move(phase, index, 1)}><ArrowDownIcon aria-hidden="true" />Move down</Button>
              <Button type="button" variant="outline" size="sm" disabled={!entry.command.trim() || previewing !== null} aria-label={`Preview ${label}`} onClick={() => void preview(entry)}><EyeIcon aria-hidden="true" />{previewing === entry.id ? 'Previewing…' : 'Preview'}</Button>
              <Button type="button" variant="ghost" size="sm" className="ml-auto" aria-label={`Remove ${label}`} onClick={() => { setDraft(current => ({ ...current, [phase]: current[phase].filter(item => item.id !== entry.id) })); setMessage('') }}><Trash2Icon aria-hidden="true" />Remove</Button>
            </div>
            {previews[entry.id] && <Card className="min-w-0 gap-1 bg-muted/50 px-3 py-3 text-xs shadow-none">
              <p className="font-medium">{previews[entry.id]!.illustrative ? 'Example preview — illustrative values' : 'Selected worktree preview'}</p>
              <p className="break-all text-muted-foreground">Working directory: {previews[entry.id]!.cwd}</p>
              <pre className="mt-1 font-mono whitespace-pre-wrap break-all">{previews[entry.id]!.renderedCommand}</pre>
              <p className="mt-1 text-muted-foreground">Preview does not execute commands or expand shell expressions.</p>
            </Card>}
          </FieldSet>
        })}
        <Button type="button" variant="outline" size="sm" className="self-start" disabled={draft[phase].length >= 32 || save.isPending} onClick={() => { setDraft(current => ({ ...current, [phase]: [...current[phase], { id: crypto.randomUUID(), command: '' }] })); setMessage('') }}><PlusIcon aria-hidden="true" />Add {phase === 'afterCreate' ? 'setup' : 'cleanup'} command</Button>
      </SettingsField>)}
    </Card>

    <div className="flex flex-wrap items-center justify-end gap-3">
      {(errors.form || save.error) ? <SettingsNote tone="danger" role="alert" className="mr-auto">{errors.form ?? save.error?.message}</SettingsNote> : null}
      {message ? <SettingsNote role="status" className="mr-auto">{message}</SettingsNote> : null}
      {save.isError ? <Button type="button" variant="outline" onClick={() => void reload()}>Reload saved scripts</Button> : null}
      <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save scripts'}</Button>
    </div>
    {pending.length > 0 && <Alert role="note">
      <AlertTitle>Paused scripts wait for an explicit recovery choice.</AlertTitle>
      <AlertDescription>
        {pending.map(worktree => <Button key={worktree.worktreeId} variant="link" size="sm" className="h-auto px-0" asChild><a href={`#lifecycle-operation-${worktree.operation!.id}`}>Return to {worktree.task?.title ?? 'orphan worktree'} and Retry</a></Button>)}
      </AlertDescription>
    </Alert>}
  </div>
}
