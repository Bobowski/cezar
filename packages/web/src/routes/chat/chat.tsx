import { ArchiveIcon, FileDiffIcon, MessagesSquareIcon, PlusIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import type { ApiRun, RepoIndexFile, Runner } from '@open-mercato/cezar-api-client'

import { ApiError, createRun } from '@/api/client'
import { queryKeys, useArchiveRun, useChatRuns, useMarkRunSeen, useRun, useRuns } from '@/api/queries'
import { changeIndex, commitIndex, discardChange, useRepoGitAction, useRepoIndex } from '@/api/repo-git'
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
import { chatCommitMessage, chatTasks, inChatDir, knownChats, projectChats } from '@/lib/chat'
import { Link, useNavigate } from '@/lib/project-router'
import { isUnread } from '@/lib/read-state'
import { useQueryClient } from '@tanstack/react-query'

import { ThreadLoading } from '../task-thread/thread-loading'
import { ConversationColumn } from '../task-workspace/task-workspace'
import { RUNNERS } from '../new-task-form'

/**
 * `/chat`, `/chat/new`, `/chat/:id` — the project's cockpit chat (spec 2026-10-24-cockpit-chat §3):
 * a task thread without the Changes/Preview columns, beside the chats list. The newest unarchived
 * chat is the pinned one `/chat` opens; New chat starts another. Its Changes panel is the
 * checkout's diff under `.ai/cezar/`, with Commit and Revert through the Git page's own routes.
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
      {changesOpen ? <ChatChanges /> : null}
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
 * The chat's Changes: the checkout's files under `.ai/cezar/` (spec §3). Commit stages exactly
 * those and commits them on the checked-out branch — refused while something else is staged, so
 * it never sweeps the user's own work in; Revert throws them away after a confirm.
 */
export function ChatChanges() {
  const index = useRepoIndex()
  const [confirming, setConfirming] = useState(false)
  const staged = (index.data?.staged ?? []).filter((file) => inChatDir(file.path))
  const unstaged = (index.data?.unstaged ?? []).filter((file) => inChatDir(file.path))
  const otherStaged = (index.data?.staged ?? []).filter((file) => !inChatDir(file.path))
  const files = uniqueFiles([...staged, ...unstaged])

  const commit = useRepoGitAction(async (paths: string[]) => {
    const unstagedPaths = unstaged.map((file) => file.path)
    if (unstagedPaths.length) await changeIndex('stage', { paths: unstagedPaths })
    return commitIndex({ message: chatCommitMessage(paths) })
  })
  const revert = useRepoGitAction(async () => {
    if (staged.length) await changeIndex('unstage', { paths: staged.map((file) => file.path) })
    return discardChange({ paths: files.map((file) => file.path), confirm: true, untracked: true })
  })
  const busy = commit.isPending || revert.isPending

  return (
    <aside data-slot="chat-changes" className="flex w-80 shrink-0 flex-col gap-3 border-l border-border/70 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Changes in .ai/cezar/</h2>
      </div>
      {index.isPending ? (
        <p className="text-xs text-muted-foreground">Reading the checkout…</p>
      ) : index.isError ? (
        <p className="text-xs text-danger">{index.error.message}</p>
      ) : files.length === 0 ? (
        <p data-slot="chat-changes-empty" className="text-xs text-muted-foreground">
          Nothing the chat wrote is uncommitted.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {files.map((file) => (
              <li key={file.path} data-slot="chat-change" className="flex items-center gap-2 font-mono text-xs">
                <span className="w-3 shrink-0 text-muted-foreground">{file.untracked ? 'U' : file.status.charAt(0).toUpperCase()}</span>
                <span className="truncate" title={file.path}>{file.path}</span>
              </li>
            ))}
          </ul>
          {otherStaged.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Other files are staged in the checkout — commit those from the Git page first.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              data-action="chat-commit"
              disabled={busy || otherStaged.length > 0}
              onClick={() =>
                commit.mutate(files.map((file) => file.path), {
                  onSuccess: (answer) => toast(`committed ${answer.sha.slice(0, 8)}`),
                  onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                })
              }
            >
              Commit
            </Button>
            {confirming ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                data-action="chat-revert-confirm"
                disabled={busy}
                onClick={() =>
                  revert.mutate(undefined, {
                    onSettled: () => setConfirming(false),
                    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                  })
                }
              >
                Discard {files.length} {files.length === 1 ? 'file' : 'files'}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" data-action="chat-revert" disabled={busy} onClick={() => setConfirming(true)}>
                Revert
              </Button>
            )}
          </div>
        </>
      )}
    </aside>
  )
}

/** A file staged and then edited again is on both sides of the index; it is one file here. */
function uniqueFiles(files: RepoIndexFile[]): RepoIndexFile[] {
  const seen = new Map<string, RepoIndexFile>()
  for (const file of files) if (!seen.has(file.path)) seen.set(file.path, file)
  return [...seen.values()]
}
