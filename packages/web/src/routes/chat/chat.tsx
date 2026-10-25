import { ArchiveIcon, FileDiffIcon, MessagesSquareIcon, PlusIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import type { ApiRun, Runner } from '@open-mercato/cezar-api-client'

import { ApiError, createRun } from '@/api/client'
import { queryKeys, useArchiveRun, useChatRuns, useMarkRunSeen, useRun, useRuns } from '@/api/queries'
import { applyChatProposals, discardChatProposals, repoGitKeys, useChatProposals, useRepoGitAction } from '@/api/repo-git'
import { CenteredState } from '@/components/centered-state'
import { ContextSidebar } from '@/components/context-sidebar'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { statusTone } from '@/lib/automation-format'
import { chatTasks, knownChats, projectChats, proposalOversized, riskLine } from '@/lib/chat'
import { Link, useNavigate } from '@/lib/project-router'
import { isUnread } from '@/lib/read-state'
import { useQueryClient } from '@tanstack/react-query'

import { ThreadLoading } from '../task-thread/thread-loading'
import { ConversationColumn } from '../task-workspace/task-workspace'
import { RUNNERS } from '../new-task-form'

/**
 * `/chat`, `/chat/new`, `/chat/:id` — the project's cockpit chat (spec 2026-10-24-cockpit-chat §3):
 * a task thread without the Changes/Preview columns, beside the chats list. The newest unarchived
 * chat is the pinned one `/chat` opens; New chat starts another. Its Changes panel is the chat's
 * proposals as diffs against the live files, with Apply & commit and Discard (spec §3).
 */
export function ChatRoute({ fresh = false }: { fresh?: boolean }) {
  const { id } = useParams<{ id?: string }>()
  const runs = useRuns()
  const chatRuns = useChatRuns()
  const chats = useMemo(() => projectChats(knownChats(chatRuns.data, runs.data)), [chatRuns.data, runs.data])
  const chatId = fresh ? undefined : id ?? chats.pinned?.id

  return (
    <>
      <ChatSidebar pinned={chats.pinned} previous={chats.previous} activeId={chatId} />
      <div data-route="chat" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {chatId ? (
          <ChatThread key={chatId} id={chatId} tasks={chatTasks(runs.data ?? [], chatId)} />
        ) : chatRuns.isPending && !fresh ? (
          <ThreadLoading />
        ) : (
          <NewChat />
        )}
      </div>
    </>
  )
}

function chatName(chat: Pick<ApiRun, 'title' | 'titleSummary'>): string {
  return chat.titleSummary ?? chat.title
}

function ChatSidebar({ pinned, previous, activeId }: { pinned?: ApiRun; previous: ApiRun[]; activeId?: string }) {
  const row = (chat: ApiRun) => (
    <SidebarMenuItem key={chat.id}>
      <SidebarMenuButton asChild isActive={chat.id === activeId}>
        <Link to={`/chat/${encodeURIComponent(chat.id)}`} data-slot="chat-row" data-chat-id={chat.id}>
          <StatusDot tone={statusTone(chat.status)} pulse={chat.status === 'running'} />
          <span className="truncate">{chatName(chat)}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
  return (
    <ContextSidebar>
      <SidebarHeader className="gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="px-1 text-[15px] font-semibold text-foreground">Chat</h2>
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to="/chat/new" data-action="new-chat">
              <PlusIcon aria-hidden="true" />
              New chat
            </Link>
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {pinned ? (
          <SidebarGroup className="pt-0">
            <SidebarGroupLabel>Pinned</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu data-slot="chat-pinned">{row(pinned)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        {previous.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel>Previous chats</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu data-slot="chat-previous">{previous.map(row)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
    </ContextSidebar>
  )
}

/** The first message: it starts the chat run (`POST /runs { kind: 'chat' }`). */
function NewChat() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  // Empty = the project's default agent (spec §6); the thread's Continue pills switch it later.
  const [runner, setRunner] = useState<Runner | ''>('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    const task = text.trim()
    if (!task || sending) return
    setSending(true)
    try {
      const created = await createRun({ kind: 'chat', task, ...(runner ? { runner } : {}) })
      const run = 'runs' in created ? created.runs[0] : created
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      if (run) navigate(`/chat/${encodeURIComponent(run.id)}`)
    } catch (error) {
      toast((error as Error).message, { tone: 'danger' })
      setSending(false)
    }
  }

  return (
    <div data-slot="new-chat" className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <MessagesSquareIcon aria-hidden="true" className="size-6 text-soft-foreground" />
        <h1 className="text-lg font-semibold">Ask cezar about this project</h1>
        <p className="text-sm text-muted-foreground">
          "Make me a workflow that runs e2e after every implement step", "which tasks touched checkout this week",
          "start three variants of this on Codex". The chat writes only cezar's workflows, skills, personas, automations and MCP config; anything else becomes a task.
        </p>
      </div>
      <Textarea
        aria-label="Message"
        data-slot="new-chat-input"
        value={text}
        rows={4}
        placeholder="Message the cezar chat…"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <NativeSelect size="sm" aria-label="Agent" value={runner} onChange={(event) => setRunner(event.target.value as Runner | '')}>
          <NativeSelectOption value="">Project default agent</NativeSelectOption>
          {RUNNERS.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>{option.label}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="button" data-action="send-chat" disabled={!text.trim() || sending} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  )
}

function ChatThread({ id, tasks }: { id: string; tasks: ApiRun[] }) {
  const run = useRun(id)
  const [changesOpen, setChangesOpen] = useState(false)
  const { mutate: markRunSeen } = useMarkRunSeen()
  useEffect(() => {
    if (run.data && isUnread(run.data)) markRunSeen(run.data.id)
  }, [markRunSeen, run.data?.id, run.data?.status, run.data?.finishedAt, run.data?.seenAt]) // eslint-disable-line react-hooks/exhaustive-deps

  if (run.isPending) return <ThreadLoading />
  if (run.isError) {
    const notFound = run.error instanceof ApiError && run.error.status === 404
    return (
      <CenteredState
        icon={<SearchXIcon />}
        tone={notFound ? 'neutral' : 'danger'}
        title={notFound ? 'Chat not found' : 'Could not load this chat'}
        subtitle={notFound ? 'No chat has this id here.' : run.error.message}
        actions={
          <Button asChild variant="outline">
            <Link to="/chat/new">New chat</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader run={run.data} tasks={tasks} changesOpen={changesOpen} onToggleChanges={() => setChangesOpen((open) => !open)} />
        <div data-slot="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ConversationColumn run={run.data} onMarkedUnread={() => {}} />
        </div>
      </div>
      {changesOpen ? <ChatChanges chatId={run.data.id} turn={`${run.data.status}:${run.data.finishedAt ?? ''}`} running={run.data.status === 'running'} /> : null}
    </div>
  )
}

function ChatHeader({
  run,
  tasks,
  changesOpen,
  onToggleChanges,
}: {
  run: ApiRun
  tasks: ApiRun[]
  changesOpen: boolean
  onToggleChanges: () => void
}) {
  const navigate = useNavigate()
  const archive = useArchiveRun('task_view')
  return (
    <header data-slot="chat-header" className="flex flex-col gap-2 border-b border-border/70 px-4 py-3">
      <div className="flex items-center gap-2">
        <StatusDot tone={statusTone(run.status)} pulse={run.status === 'running'} />
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{chatName(run)}</h1>
        <span data-slot="chat-engine" className="font-mono text-xs text-muted-foreground">
          {run.runner ?? 'default'}{run.model ? ` · ${run.model}` : ''}
        </span>
        <Button type="button" size="sm" variant={changesOpen ? 'secondary' : 'ghost'} className="gap-1.5" data-action="chat-changes" aria-pressed={changesOpen} onClick={onToggleChanges}>
          <FileDiffIcon aria-hidden="true" />
          Changes
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={run.archived ? 'Restore chat' : 'Archive chat'}
          data-action="chat-archive"
          onClick={() =>
            archive.mutate(
              { id: run.id, archived: !run.archived },
              { onSuccess: () => { if (!run.archived) navigate('/chat') }, onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
            )
          }
        >
          <ArchiveIcon aria-hidden="true" />
        </Button>
      </div>
      {tasks.length > 0 ? (
        <div data-slot="chat-tasks" className="flex flex-wrap gap-1.5">
          {tasks.map((task) => (
            <Link
              key={task.id}
              to={`/tasks/${encodeURIComponent(task.id)}`}
              data-slot="chat-task-chip"
              className="inline-flex max-w-64 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs hover:bg-accent"
            >
              <StatusDot tone={statusTone(task.status)} pulse={task.status === 'running'} />
              <span className="truncate">{chatName(task)}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </header>
  )
}

/**
 * The chat's Changes: what it PROPOSES (spec §3) — nothing it writes is live until the owner applies
 * it. Each file is a diff against the live one; Apply & commit copies them into place and commits
 * the repo files (refused while anything else is staged), Discard throws them away after a confirm.
 * Apply confirms too, naming the files and every risk the server read from the parsed proposals; an
 * oversized diff must be opened first, a proposal over the size cap cannot be applied, and it
 * applies exactly the paths the owner saw — a refetch that changes one closes the confirm and says so.
 */
export function ChatChanges({ chatId, turn, running = false }: { chatId: string; turn?: string; running?: boolean }) {
  const proposals = useChatProposals(chatId)
  const queryClient = useQueryClient()
  // A turn that ended may have written proposals: read them again.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: repoGitKeys.proposals(chatId) })
  }, [queryClient, chatId, turn])
  const [confirming, setConfirming] = useState(false)
  // The hashes the Apply confirm opened on; a refetch that changes any of them closes it.
  const [confirmedOn, setConfirmedOn] = useState<ReadonlyMap<string, string> | null>(null)
  // A diff counts as opened only at the hash it was opened at.
  const [opened, setOpened] = useState<ReadonlyMap<string, string>>(() => new Map())
  const listed = proposals.data?.proposals ?? []
  const files = listed.filter((file) => file.status !== 'unchanged')
  const changedSince = confirmedOn
    ? [...new Set([...confirmedOn.keys(), ...listed.map((file) => file.path)])].filter(
        (path) => confirmedOn.get(path) !== listed.find((file) => file.path === path)?.hash,
      )
    : []
  const confirmingApply = confirmedOn !== null && changedSince.length === 0
  const setConfirmingApply = (open: boolean) =>
    setConfirmedOn(open ? new Map(listed.map((file) => [file.path, file.hash])) : null)
  const unread = files.filter((file) => proposalOversized(file.diff) && opened.get(file.path) !== file.hash)
  const tooLarge = files.filter((file) => file.tooLarge)
  // A running turn may rewrite a proposal under the confirm; the hashes catch what slips past.
  const blocked = running || unread.length > 0 || tooLarge.length > 0
  const risks = files.flatMap((file) => file.risks.map((risk) => ({ path: file.path, line: riskLine(risk) })))
  const apply = useRepoGitAction((reviewed: typeof listed) =>
    applyChatProposals(chatId, { paths: reviewed.map((file) => file.path), hashes: Object.fromEntries(reviewed.map((file) => [file.path, file.hash])) }))
  const discard = useRepoGitAction(() => discardChatProposals(chatId))
  const busy = apply.isPending || discard.isPending

  return (
    <aside data-slot="chat-changes" className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/70 p-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold">Proposed changes</h2>
        <p className="text-xs text-muted-foreground">Nothing here runs until you apply it.</p>
      </div>
      {proposals.isPending ? (
        <p className="text-xs text-muted-foreground">Reading the proposals…</p>
      ) : proposals.isError ? (
        <p className="text-xs text-danger">{proposals.error.message}</p>
      ) : files.length === 0 ? (
        <p data-slot="chat-changes-empty" className="text-xs text-muted-foreground">
          The chat proposes nothing right now.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {files.map((file) => (
              <li key={file.path} data-slot="chat-change" className="flex flex-col gap-1">
                <details
                  onToggle={(event) => {
                    if (!event.currentTarget.open) return
                    setOpened((current) => (current.get(file.path) === file.hash ? current : new Map([...current, [file.path, file.hash]])))
                  }}
                >
                  <summary className="flex cursor-pointer items-center gap-2 font-mono text-xs">
                    <span className="w-3 shrink-0 text-muted-foreground">{file.status === 'added' ? 'A' : 'M'}</span>
                    <span className="truncate" title={file.path}>{file.path}</span>
                  </summary>
                  <pre data-slot="chat-change-diff" className="mt-1 max-h-72 overflow-auto rounded border border-border/70 bg-muted/40 p-2 text-[11px] leading-snug">
                    {file.diff}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
          {unread.length > 0 ? (
            <p data-slot="chat-apply-blocked" className="text-xs text-muted-foreground">
              Open the diff of {unread.map((file) => file.path).join(', ')} before applying: it is too large to review collapsed.
            </p>
          ) : null}
          {tooLarge.length > 0 ? (
            <p data-slot="chat-apply-too-large" className="text-xs text-danger">
              {tooLarge.map((file) => file.path).join(', ')} is too large to apply — discard it and ask the chat for a smaller one.
            </p>
          ) : null}
          {running ? (
            <p data-slot="chat-apply-running" className="text-xs text-muted-foreground">
              The chat is answering: Apply waits for its turn to end, so you apply what you reviewed.
            </p>
          ) : null}
          {changedSince.length > 0 ? (
            <p data-slot="chat-apply-changed" className="text-xs text-danger">
              {changedSince.join(', ')} changed since you opened this — review it and apply again.
            </p>
          ) : null}
          {confirmingApply ? (
            <div data-slot="chat-apply-confirm" className="flex flex-col gap-2 rounded border border-border/70 p-2 text-xs">
              <p className="font-medium">Apply and commit these files?</p>
              <ul className="flex flex-col gap-0.5 font-mono">
                {files.map((file) => <li key={file.path}>{file.path}</li>)}
              </ul>
              {risks.length > 0 ? (
                <>
                  <p className="font-medium text-danger">Once applied, these run or reach out without you:</p>
                  <ul className="flex flex-col gap-0.5 font-mono">
                    {risks.map((risk, index) => (
                      <li key={`${risk.path}:${index}`} data-slot="chat-apply-risk" title={risk.path}>{risk.line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-action="chat-apply-confirm"
                  disabled={busy || blocked}
                  onClick={() =>
                    apply.mutate(listed, {
                      onSuccess: (answer) => toast(answer.sha ? `applied and committed ${answer.sha.slice(0, 8)}` : 'applied'),
                      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                      onSettled: () => setConfirmingApply(false),
                    })
                  }
                >
                  Apply & commit {files.length} {files.length === 1 ? 'file' : 'files'}
                </Button>
                <Button type="button" size="sm" variant="ghost" data-action="chat-apply-cancel" onClick={() => setConfirmingApply(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            {confirmingApply ? null : (
              <Button type="button" size="sm" data-action="chat-apply" disabled={busy || blocked} onClick={() => setConfirmingApply(true)}>
                Apply & commit
              </Button>
            )}
            {confirming ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                data-action="chat-discard-confirm"
                disabled={busy}
                onClick={() =>
                  discard.mutate(undefined, {
                    onSettled: () => setConfirming(false),
                    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                  })
                }
              >
                Discard {files.length} {files.length === 1 ? 'proposal' : 'proposals'}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" data-action="chat-discard" disabled={busy} onClick={() => setConfirming(true)}>
                Discard
              </Button>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
