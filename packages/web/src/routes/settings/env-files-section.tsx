import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { envFilePathIssue, queryScope, type EnvFileContent, type EnvFileEntry } from '@open-mercato/cezar-api-client'
import { getEnvFileContent, removeEnvFile, saveEnvFile } from '@/api/client'
import { queryKeys, useEnvFiles } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EnvVariablesEditor } from './env-variables-editor'
import { SettingsGroup, SettingsNote, SettingsPane } from './settings-field'

/** The line under a path: what is in the file, or what it is waiting for. Names only. */
function fileSummary(file: EnvFileEntry): string {
  const plural = (n: number) => `${n} variable${n === 1 ? '' : 's'}`
  if (!file.exists) return file.template ? `Not created — ${file.template} asks for ${plural(file.missing.length)}` : 'Not created'
  const count = plural(file.variables.length)
  return file.missing.length > 0 ? `${count} · missing from the example: ${file.missing.join(', ')}` : count
}

/**
 * Settings → project → Environment (spec 2026-10-12-project-env-files): the project's own
 * gitignored env files, one per service. The listing carries names; a file's text is fetched when
 * it is opened and lives in this component only — never in the query cache.
 */
export function EnvFilesSection() {
  const queryClient = useQueryClient()
  const list = useEnvFiles()
  const [open, setOpen] = useState<EnvFileContent | null>(null)
  const [draft, setDraft] = useState('')
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Both views edit the same text, so switching between them loses nothing.
  const [view, setView] = useState<'variables' | 'raw'>('variables')

  const refresh = (projectId: string | null) =>
    queryClient.invalidateQueries({ queryKey: queryKeys.envFiles.allFor(projectId ?? '') })

  const opening = useMutation({
    mutationFn: (path: string) => getEnvFileContent(path),
    onSuccess: (file) => { setOpen(file); setDraft(file.content); setError(null) },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })
  const saving = useMutation({
    mutationFn: async () => {
      const projectId = queryScope()
      return { projectId, file: await saveEnvFile({ path: open?.path ?? '', content: draft, version: open?.version ?? null }) }
    },
    onSuccess: async ({ projectId, file }) => {
      if (queryScope() === projectId) { setOpen(null); setDraft(''); setError(null) }
      await refresh(projectId)
      toast(`${file.path} saved`)
    },
    // The draft stays: a conflict must not cost the user what they pasted.
    onError: (e: Error) => setError(e.message),
  })
  const removing = useMutation({
    mutationFn: async (path: string) => { const projectId = queryScope(); await removeEnvFile(path); return { projectId, path } },
    onSuccess: async ({ projectId, path }) => {
      if (open?.path === path) { setOpen(null); setDraft('') }
      await refresh(projectId)
      toast(`${path} removed`)
    },
    onError: (e: Error) => toast(e.message, { tone: 'danger' }),
  })

  const files = list.data?.files ?? []
  const suggestions = list.data?.suggestions ?? []
  const editable = list.data?.editable ?? false
  const newPathIssue = newPath === '' ? null : envFilePathIssue(newPath)
  const busy = opening.isPending || saving.isPending || removing.isPending

  return (
    <SettingsPane data-slot="env-files-settings">
      <SettingsGroup
        title="Environment files"
        description="This project’s own gitignored .env files, one per service. They live in the main checkout; every new task’s worktree gets a copy."
        bare
      >
        {list.isPending ? <SettingsNote>Loading…</SettingsNote> : null}
        {list.isError ? <SettingsNote tone="danger" role="alert">{list.error?.message}</SettingsNote> : null}
        {list.data && !editable ? (
          <SettingsNote role="note">
            This cockpit shows variable names only: it is hosted without sign-in (CEZ_AUTH=0), so contents are edited on the machine that owns the checkout.
          </SettingsNote>
        ) : null}
        {list.data && files.length === 0 ? (
          <SettingsNote>No env files yet, and no tracked .env.example asking for one.</SettingsNote>
        ) : null}
        {files.length > 0 ? (
          <Card flush>
            <ul className="divide-y divide-border" aria-label="Environment files">
              {files.map((file) => (
                <li key={file.path} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <code className="font-mono text-[13px] break-all text-foreground">{file.path}</code>
                    <p className="text-xs text-pretty text-muted-foreground">{fileSummary(file)}</p>
                  </div>
                  {editable ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => opening.mutate(file.path)}>
                        {file.exists ? 'Edit' : 'Create'}
                      </Button>
                      {file.exists ? (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Delete ${file.path}`}
                          disabled={busy}
                          onClick={() => removing.mutate(file.path)}
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      ) : null}
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
          title="Add a file"
          description="A path inside the repository that git ignores. Services without an env file are offered below."
          bare
        >
          {suggestions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((path) => (
                <Button key={path} variant="outline" size="sm" disabled={busy} onClick={() => opening.mutate(path)}>
                  <PlusIcon aria-hidden="true" /> <code className="font-mono text-xs">{path}</code>
                </Button>
              ))}
            </div>
          ) : null}
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (newPath !== '' && !newPathIssue) opening.mutate(newPath)
            }}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                aria-label="Path"
                value={newPath}
                onChange={(event) => setNewPath(event.target.value.trim())}
                placeholder="apps/api/.env"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={newPathIssue ? true : undefined}
                className="font-mono"
              />
              {newPathIssue ? <SettingsNote tone="danger">{newPathIssue}</SettingsNote> : null}
            </div>
            <Button type="submit" variant="outline" disabled={busy || newPath === '' || !!newPathIssue}>
              Open
            </Button>
          </form>
        </SettingsGroup>
      ) : null}

      {open ? (
        <form
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault()
            saving.mutate()
          }}
        >
          <SettingsGroup
            title={<code className="font-mono">{open.path}</code>}
            description={open.version === null ? 'A new file. It is written private (0600) and never committed.' : 'Saved to the main checkout. Tasks that already have a worktree keep their own copy.'}
            bare
          >
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label="Editor view"
              value={view}
              onValueChange={(next) => {
                // Radio semantics: re-clicking the shown view keeps it.
                if (next === 'variables' || next === 'raw') setView(next)
              }}
            >
              <ToggleGroupItem value="variables">Variables</ToggleGroupItem>
              <ToggleGroupItem value="raw">Raw text</ToggleGroupItem>
            </ToggleGroup>
            {view === 'variables' ? (
              <EnvVariablesEditor key={open.path} path={open.path} text={draft} template={open.template} onChange={(text) => { setDraft(text); setError(null) }} />
            ) : (
            <Textarea
              aria-label={`Contents of ${open.path}`}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setError(null) }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={'DATABASE_URL=\nAPI_KEY='}
              className="max-h-[60vh] min-h-48 overflow-auto font-mono text-[13px] whitespace-pre md:text-[13px]"
            />
            )}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {error ? <SettingsNote tone="danger" role="alert" className="mr-auto">{error}</SettingsNote> : null}
              {open.template !== null && draft.trim() === '' && view === 'raw' ? (
                <Button type="button" variant="outline" onClick={() => setDraft(open.template ?? '')}>
                  Start from the example
                </Button>
              ) : null}
              <Button type="button" variant="outline" disabled={saving.isPending} onClick={() => { setOpen(null); setDraft(''); setError(null) }}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving.isPending}>Save file</Button>
            </div>
          </SettingsGroup>
        </form>
      ) : null}
    </SettingsPane>
  )
}
