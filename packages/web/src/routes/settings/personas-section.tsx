import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { PERSONA_NAME_PATTERN, queryScope, type Persona } from '@open-mercato/cezar-api-client'
import { deletePersona, getPersonaFile, putPersona } from '@/api/client'
import { queryKeys, usePersonas } from '@/api/queries'
import { CodeEditor } from '@/components/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { SettingsGroup, SettingsNote, SettingsPane } from './settings-field'

/** What a new persona opens on: every field the format knows, the optional ones commented out. */
export function personaTemplate(name: string): string {
  return `---
name: ${name}
description: One line on what this agent does.
# runner: claude          # optional — the project default otherwise
# model: opus             # optional
# allowedTools: [Read, Grep, Glob, Bash(git *)]
# skills: [code-review]
---
You are the project's ${name}. Say how it works, what it may touch and what it reports.
`
}

const SOURCE_LABEL: Record<Persona['source'], string> = {
  project: 'project',
  global: 'global',
  claude: 'Claude-only',
}

/** Why a name cannot be a new project persona, or null. */
export function newPersonaNameIssue(name: string, personas: readonly Persona[]): string | null {
  if (name === '') return null
  if (!PERSONA_NAME_PATTERN.test(name)) return 'Letters, digits, "-" and "_" (at most 64), starting with a letter or digit.'
  if (personas.some((p) => p.name === name && p.source === 'project')) return 'A project persona has this name.'
  return null
}

/**
 * Settings → project → Personas (spec 2026-10-24-personas §4): the project's named agents —
 * what a workflow step's `agent:` and `cez task create --as` name. Project personas are files in
 * `.ai/cezar/agents/`, edited here as written; global ones and Claude's own `.claude/agents` are
 * listed read-only.
 */
export function PersonasSection() {
  const queryClient = useQueryClient()
  const list = usePersonas()
  const [open, setOpen] = useState<{ name: string; markdown: string; isNew: boolean } | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = (projectId: string | null) =>
    queryClient.invalidateQueries({ queryKey: queryKeys.personas.allFor(projectId ?? '') })

  // The editor opens on the file exactly as written: comments and unknown keys survive a save.
  const opening = useMutation({
    mutationFn: (name: string) => getPersonaFile(name),
    onSuccess: ({ persona, markdown }) => {
      setError(null)
      setOpen({ name: persona.name, markdown, isNew: false })
    },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })
  const saving = useMutation({
    mutationFn: async (input: { name: string; markdown: string }) => {
      const projectId = queryScope()
      return { projectId, result: await putPersona(input.name, { markdown: input.markdown }) }
    },
    onSuccess: async ({ projectId, result }) => {
      if (queryScope() === projectId) {
        setOpen(null)
        setError(null)
      }
      await refresh(projectId)
      toast(`${result.persona.name} saved`)
    },
    // The draft stays: a refused save must not cost the user what they wrote.
    onError: (e: Error) => setError(e.message),
  })
  const removing = useMutation({
    mutationFn: async (name: string) => {
      const projectId = queryScope()
      await deletePersona(name)
      return { projectId, name }
    },
    onSuccess: async ({ projectId, name }) => {
      if (open?.name === name) setOpen(null)
      await refresh(projectId)
      toast(`${name} deleted`)
    },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const personas = list.data?.personas ?? []
  const issues = list.data?.issues ?? []
  const editable = list.data?.editable ?? false
  const nameIssue = newPersonaNameIssue(newName, personas)
  const busy = saving.isPending || removing.isPending || opening.isPending

  return (
    <SettingsPane data-slot="personas-settings">
      <SettingsGroup
        title="Personas"
        description="Named agents of this project: a system prompt plus runner, model, tools and skills. A workflow step runs as one with agent: <name>; a dispatching task with cez task create --as <name>."
        bare
      >
        {list.isPending ? <SettingsNote>Loading…</SettingsNote> : null}
        {list.isError ? <SettingsNote tone="danger" role="alert">{list.error?.message}</SettingsNote> : null}
        {list.data && !editable ? (
          <SettingsNote role="note">
            Read-only: this cockpit is hosted without sign-in (CEZ_AUTH=0), so personas are edited on the machine that owns the checkout.
          </SettingsNote>
        ) : null}
        {issues.map((issue) => (
          <SettingsNote key={issue.path} tone="danger" data-slot="persona-issue">
            {issue.message}
          </SettingsNote>
        ))}
        {list.data && personas.length === 0 ? (
          <SettingsNote>No personas yet. Add one below, or put a Markdown file in .ai/cezar/agents/.</SettingsNote>
        ) : null}
        {personas.length > 0 ? (
          <Card flush>
            <ul className="divide-y divide-border" aria-label="Personas">
              {personas.map((persona) => (
                <li
                  key={persona.name}
                  data-slot="persona-row"
                  data-source={persona.source}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-[13px] text-foreground">{persona.name}</code>
                      <Badge variant="secondary" className="text-[11px] font-normal">
                        {SOURCE_LABEL[persona.source]}
                      </Badge>
                      {persona.runner || persona.model ? (
                        <span className="text-xs text-muted-foreground">
                          {[persona.runner, persona.model].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </div>
                    {persona.description ? (
                      <p className="text-xs text-pretty text-muted-foreground">{persona.description}</p>
                    ) : null}
                  </div>
                  {editable && persona.source === 'project' ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => opening.mutate(persona.name)}>
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Delete ${persona.name}`}
                        disabled={busy}
                        onClick={() => removing.mutate(persona.name)}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </SettingsGroup>

      {editable && !open ? (
        <SettingsGroup
          title="New persona"
          description="Written to .ai/cezar/agents/<name>.md — commit it to share it with the team."
          bare
        >
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (newName !== '' && !nameIssue) {
                setError(null)
                setOpen({ name: newName, markdown: personaTemplate(newName), isNew: true })
                setNewName('')
              }
            }}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                aria-label="Persona name"
                value={newName}
                onChange={(event) => setNewName(event.target.value.trim())}
                placeholder="reviewer"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={nameIssue ? true : undefined}
                className="font-mono"
              />
              {nameIssue ? <SettingsNote tone="danger">{nameIssue}</SettingsNote> : null}
            </div>
            <Button type="submit" variant="outline" disabled={busy || newName === '' || !!nameIssue}>
              <PlusIcon aria-hidden="true" /> New persona
            </Button>
          </form>
        </SettingsGroup>
      ) : null}

      {open ? (
        <SettingsGroup
          title={<code className="font-mono">{open.name}</code>}
          description={open.isNew ? 'A new persona file in .ai/cezar/agents/.' : 'Saved over its file in .ai/cezar/agents/.'}
          bare
        >
          <Card flush>
            <CodeEditor
              value={open.markdown}
              language="markdown"
              onChange={(markdown) => setOpen({ ...open, markdown })}
              aria-label={`${open.name} persona file`}
              className="h-[22rem] rounded-none border-0 shadow-none"
            />
          </Card>
          {error ? (
            <SettingsNote tone="danger" role="alert" data-slot="persona-error">
              {error}
            </SettingsNote>
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => saving.mutate({ name: open.name, markdown: open.markdown })}>
              {open.isNew ? 'Create' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setOpen(null)
                setError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </SettingsGroup>
      ) : null}
    </SettingsPane>
  )
}
