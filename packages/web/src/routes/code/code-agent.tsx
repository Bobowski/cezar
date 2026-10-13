import { ExternalLinkIcon, PlusIcon } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { useWorkflows } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'

// The chat is the task workspace's own column: one transcript, one composer, wherever it shows.
const Conversation = lazy(() => import('@/routes/task-workspace/task-workspace').then((module) => ({ default: module.ConversationColumn })))

/** The workflow a task started from here runs, when the user has not picked one. */
export const DEFAULT_AGENT_WORKFLOW = 'quick-task'
/** Radix's Select has no empty value, so "no task yet" needs a name of its own. */
const NEW_TASK = '__new__'

/**
 * An agent tab (spec 2026-10-11-code-page): a task's conversation beside the code, or the form
 * that starts one. It is a tab like a file or a browser — it splits, moves and resizes the same
 * way. The task chosen here is also where the browser's Design Mode notes go.
 */
export function AgentTab({
  runs, run, activeFile, onSelect, onStart,
}: {
  runs: readonly ApiRun[]
  /** The task shown; `null` is the new-task form. */
  run: ApiRun | null
  /** The file last focused in an editor — offered as context for a new task. */
  activeFile: string | null
  onSelect: (runId: string | null) => void
  /** Start a task. Resolves once it exists (and this tab shows it). */
  onStart: (input: { task: string; workflow: string }) => Promise<void>
}) {
  const recent = [...runs].filter((each) => !each.archived).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 40)
  return (
    <section data-slot="code-agent" aria-label="Agent" className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <Select value={run?.id ?? NEW_TASK} onValueChange={(value) => onSelect(value === NEW_TASK ? null : value)}>
          <SelectTrigger size="sm" aria-label="Task" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_TASK}>New task…</SelectItem>
            {run && !recent.some((each) => each.id === run.id) ? <SelectItem value={run.id}>{runTitle(run)}</SelectItem> : null}
            {recent.map((each) => <SelectItem key={each.id} value={each.id}>{runTitle(each)}</SelectItem>)}
          </SelectContent>
        </Select>
        {run ? (
          <>
            <IconTooltip label="New task">
              <Button variant="ghost" size="icon-sm" aria-label="New task" onClick={() => onSelect(null)}><PlusIcon aria-hidden="true" /></Button>
            </IconTooltip>
            <IconTooltip label="Open the task">
              <Button variant="ghost" size="icon-sm" aria-label="Open the task" asChild><Link to={`/tasks/${run.id}`}><ExternalLinkIcon aria-hidden="true" /></Link></Button>
            </IconTooltip>
          </>
        ) : null}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {run ? (
          <Suspense fallback={<p className="p-3 text-xs text-muted-foreground">Loading the conversation…</p>}>
            <Conversation key={run.id} run={run} onMarkedUnread={() => {}} />
          </Suspense>
        ) : (
          <NewTask activeFile={activeFile} onStart={onStart} />
        )}
      </div>
    </section>
  )
}

function NewTask({ activeFile, onStart }: { activeFile: string | null; onStart: (input: { task: string; workflow: string }) => Promise<void> }) {
  const workflows = useWorkflows().data?.workflows ?? []
  const [text, setText] = useState('')
  const [workflow, setWorkflow] = useState(DEFAULT_AGENT_WORKFLOW)
  const [withFile, setWithFile] = useState(true)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    try {
      const context = withFile && activeFile ? `\n\nThe file open in my editor: ${activeFile}` : ''
      await onStart({ task: `${text.trim()}${context}`, workflow })
      setText('')
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : 'Could not start the task.', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  const names = workflows.some((each) => each.name === DEFAULT_AGENT_WORKFLOW) ? workflows.map((each) => each.name) : [DEFAULT_AGENT_WORKFLOW, ...workflows.map((each) => each.name)]
  return (
    <form data-slot="code-agent-new" className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 p-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <p className="text-xs text-pretty text-muted-foreground">
        Describe the work. It runs as a task in its own worktree and ends at a review — nothing merges on its own.
      </p>
      <Textarea
        aria-label="Task for an agent"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit() } }}
        placeholder="What should the agent do?"
        rows={6}
        className="min-h-32 resize-none text-[13px] md:text-[13px]"
      />
      {activeFile ? (
        <div className="flex items-center gap-2">
          <Checkbox id="code-agent-with-file" checked={withFile} onCheckedChange={(checked) => setWithFile(checked === true)} />
          <Label htmlFor="code-agent-with-file" className="min-w-0 text-xs font-normal text-muted-foreground">
            <span className="truncate">Mention <code className="font-mono text-foreground">{activeFile}</code></span>
          </Label>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Select value={workflow} onValueChange={setWorkflow}>
          <SelectTrigger size="sm" aria-label="Workflow" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {names.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={busy || text.trim() === ''}>Start task</Button>
      </div>
    </form>
  )
}
