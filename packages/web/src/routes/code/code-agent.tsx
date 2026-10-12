import { PlusIcon, XIcon } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { useWorkflows } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'

// The chat is the task workspace's own column: one transcript, one composer, wherever it shows.
const Conversation = lazy(() => import('@/routes/task-workspace/task-workspace').then((module) => ({ default: module.ConversationColumn })))

/** The workflow a task started from here runs, when the user has not picked one. */
export const DEFAULT_AGENT_WORKFLOW = 'quick-task'

/**
 * The agent pane (spec 2026-10-11-code-page): a task's conversation beside the code, or the
 * place to start one. Choosing a task here also decides where the browser's Design Mode notes
 * go — to that task, or into a new one.
 */
export function AgentPane({
  runs, run, activeFile, onSelect, onStart, onClose,
}: {
  runs: readonly ApiRun[]
  /** The task shown; `null` is the new-task form. */
  run: ApiRun | null
  /** The file in the focused editor — offered as context for a new task. */
  activeFile: string | null
  onSelect: (runId: string | null) => void
  /** Start a task. Resolves once it exists (and is selected). */
  onStart: (input: { task: string; workflow: string }) => Promise<void>
  onClose: () => void
}) {
  const recent = [...runs].filter((each) => !each.archived).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 40)
  return (
    <aside data-slot="code-agent" aria-label="Agent" className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <NativeSelect aria-label="Task" value={run?.id ?? ''} onChange={(event) => onSelect(event.target.value === '' ? null : event.target.value)} className="h-7 min-w-0 flex-1 text-xs">
          <NativeSelectOption value="">New task…</NativeSelectOption>
          {run && !recent.some((each) => each.id === run.id) ? <NativeSelectOption value={run.id}>{runTitle(run)}</NativeSelectOption> : null}
          {recent.map((each) => <NativeSelectOption key={each.id} value={each.id}>{runTitle(each)}</NativeSelectOption>)}
        </NativeSelect>
        {run ? (
          <>
            <Button variant="ghost" size="icon-xs" aria-label="New task" title="New task" onClick={() => onSelect(null)}><PlusIcon aria-hidden="true" /></Button>
            <Button variant="ghost" size="xs" asChild><Link to={`/tasks/${run.id}`}>Open</Link></Button>
          </>
        ) : null}
        <Button variant="ghost" size="icon-xs" aria-label="Close agent" title="Close" onClick={onClose}><XIcon aria-hidden="true" /></Button>
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
    </aside>
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
  return (
    <form data-slot="code-agent-new" className="flex flex-1 flex-col gap-2 p-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
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
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={withFile} onChange={(event) => setWithFile(event.target.checked)} />
          <span className="min-w-0 truncate">Mention <code className="font-mono text-foreground">{activeFile}</code></span>
        </label>
      ) : null}
      <div className="flex items-center gap-2">
        <NativeSelect aria-label="Workflow" value={workflow} onChange={(event) => setWorkflow(event.target.value)} className="h-8 min-w-0 flex-1 text-xs">
          {!workflows.some((each) => each.name === DEFAULT_AGENT_WORKFLOW) ? <NativeSelectOption value={DEFAULT_AGENT_WORKFLOW}>{DEFAULT_AGENT_WORKFLOW}</NativeSelectOption> : null}
          {workflows.map((each) => <NativeSelectOption key={each.name} value={each.name}>{each.name}</NativeSelectOption>)}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={busy || text.trim() === ''}>Start task</Button>
      </div>
    </form>
  )
}
