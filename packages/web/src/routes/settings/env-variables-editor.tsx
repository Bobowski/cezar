import { BracesIcon, CheckIcon, EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { renderEnvFile } from '@/api/client'
import { useRuns } from '@/api/queries'
import {
  ENV_KEY_PATTERN,
  addVariable,
  duplicateKeys,
  parseEnv,
  serializeEnv,
} from '@/lib/dotenv-lines'
import { directiveFor, hasReference, isDirectiveLine, nextPortOffset, removeVariable, renameVariable, setSource } from '@/lib/env-directives'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SettingsNote, SettingsSelect } from './settings-field'

/** Masked like a password, but not one: password managers must not offer to save it. */
const MASKED = { type: 'password', autoComplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true' } as const
const MAIN = ''

export interface OtherEnvFile { path: string; variables: string[] }

/**
 * Settings → Environment, variable by variable (spec 2026-10-12-project-env-files). Edits the
 * file's TEXT through `lib/dotenv-lines`, so a line nobody touched — a comment, a quoted value —
 * is saved exactly as it was, and switching to the raw text view loses nothing.
 *
 * A value may hold `${{ … }}` references (spec 2026-10-21-env-references): the row then edits the
 * `#cezar` directive above the line, and shows what it renders to — in the main checkout, or for
 * a chosen task — from a dry render on the server.
 */
export function EnvVariablesEditor({ path, text, template, otherFiles = [], onChange }: {
  path: string
  text: string
  template: string | null
  /** The project's other env files and their variable names, for cross-file references. */
  otherFiles?: OtherEnvFile[]
  onChange: (text: string) => void
}) {
  const lines = useMemo(() => parseEnv(text), [text])
  // By name, not line: adding a reference inserts a directive line and shifts every index below.
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  // A name being typed may be briefly invalid ("", "1"); it reaches the text only once valid,
  // or the line would stop parsing as a variable and its row would vanish mid-keystroke.
  const [nameDrafts, setNameDrafts] = useState<Map<number, string>>(new Map())
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [adding, setAdding] = useState(false)
  const valueInputs = useRef(new Map<string, HTMLInputElement>())

  const dupes = duplicateKeys(lines)
  const keys = new Set(lines.flatMap((line) => (line.kind === 'var' ? [line.key] : [])))
  const missing = template === null ? [] : parseEnv(template).flatMap((line) => (line.kind === 'var' && !keys.has(line.key) ? [line] : []))
  const kept = lines.filter((line) => line.kind === 'other' && line.raw.trim() !== '' && !isDirectiveLine(line)).length
  const newKeyIssue = newKey === '' ? null
    : !ENV_KEY_PATTERN.test(newKey) ? 'Letters, digits and _ . - only, not starting with a digit.'
    : keys.has(newKey) ? `${newKey} is already set — edit it above.` : null

  const usesReferences = lines.some(isDirectiveLine)
  const [context, setContext] = useState(MAIN)
  const preview = useRenderPreview(path, text, context, usesReferences)
  const tasks = useRuns((runs) => runs.filter((run) => !!run.worktreePath && !run.archivedAt))
  const contextOptions = [
    { value: MAIN, label: 'Main checkout' },
    ...(tasks.data ?? []).map((run) => ({ value: run.id, label: run.title || run.id.slice(0, 8) })),
  ]

  const toggle = (key: string) => setRevealed((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const add = () => {
    if (newKey === '' || newKeyIssue) return
    onChange(serializeEnv(addVariable(lines, newKey, newValue)))
    setNewKey(''); setNewValue(''); setAdding(false)
  }
  // The add row sits inside the file's form: Enter adds a variable, it does not save the file.
  const onAddKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); add() }
    if (event.key === 'Escape') { event.preventDefault(); setNewKey(''); setNewValue(''); setAdding(false) }
  }
  /** Put `reference` into the row's value, over the selection (or at the cursor). */
  const insert = (index: number, key: string, source: string, reference: string | ((selected: string) => string)) => {
    const input = valueInputs.current.get(key)
    let start = input?.selectionStart ?? source.length
    let end = input?.selectionEnd ?? start
    // A value that is only a port is replaced whole — `9000${{ … }}` is never what was meant.
    if (start === end && /^\d{1,5}$/.test(source.trim())) { start = 0; end = source.length }
    const piece = typeof reference === 'string' ? reference : reference(source.slice(start, end).trim())
    onChange(serializeEnv(setSource(lines, index, key, source.slice(0, start) + piece + source.slice(end))))
    setRevealed((current) => new Set(current).add(key))
  }
  // The port the main checkout keeps is the one being replaced: the selection, else the whole
  // value when it is a port. Never a made-up default — that would move the main checkout's service.
  const portReference = (fallback: string) => (selected: string) =>
    `\${{ task.port(${nextPortOffset(text)}, ${/^\d{1,5}$/.test(selected) ? selected : fallback}) }}`

  const rows = lines.flatMap((line, index) => (line.kind === 'var' ? [{ line, index }] : []))

  return (
    <div className="flex flex-col gap-3" data-slot="env-variables-editor">
      {usesReferences ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SettingsNote>References show what they render to for</SettingsNote>
          <SettingsSelect aria-label="Render references for" size="sm" value={context} options={contextOptions} onChange={setContext} />
        </div>
      ) : null}
      {usesReferences && context !== MAIN && !preview.loading && !preview.error && preview.slot === null ? (
        <SettingsNote>This task holds no slot yet — it renders like the main checkout until its app or agent first runs.</SettingsNote>
      ) : null}
      {preview.error ? <SettingsNote tone="danger" role="alert">{preview.error}</SettingsNote> : null}

      {rows.length > 0 ? (
        <Card flush>
          <ul className="divide-y divide-border" aria-label={`Variables in ${path}`}>
            {rows.map(({ line, index }) => {
              const name = nameDrafts.get(index) ?? line.key
              const invalid = !ENV_KEY_PATTERN.test(name)
              const directive = directiveFor(lines, index)
              const source = directive?.source ?? line.value
              const shown = revealed.has(line.key)
              const multiline = !directive && line.value.includes('\n')
              const rendered = directive ? preview.values.get(line.key) : undefined
              const portDefault = /^\d{2,5}$/.test(line.value.trim()) ? line.value.trim() : '3000'
              return (
                <li key={`${index}:${line.key}`} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-start">
                  <div className="min-w-0 sm:w-2/5">
                    <Input
                      aria-label={`Name of variable ${line.key}`}
                      value={name}
                      aria-invalid={invalid || dupes.has(line.key) ? true : undefined}
                      onChange={(event) => {
                        const next = event.target.value.trim()
                        setNameDrafts((current) => {
                          const drafts = new Map(current)
                          if (ENV_KEY_PATTERN.test(next)) drafts.delete(index); else drafts.set(index, next)
                          return drafts
                        })
                        if (ENV_KEY_PATTERN.test(next)) onChange(serializeEnv(renameVariable(lines, index, next)))
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono text-[13px]"
                    />
                    {invalid ? <SettingsNote tone="danger">Letters, digits and _ . - only, not starting with a digit.</SettingsNote> : null}
                    {dupes.has(line.key) ? <SettingsNote tone="danger">Set more than once — the last one wins.</SettingsNote> : null}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Input
                        ref={(element) => { if (element) valueInputs.current.set(line.key, element); else valueInputs.current.delete(line.key) }}
                        aria-label={`Value of ${line.key}`}
                        value={source}
                        readOnly={multiline}
                        title={multiline ? 'A multi-line value — edit it in Raw text.' : undefined}
                        onChange={(event) => onChange(serializeEnv(setSource(lines, index, line.key, event.target.value)))}
                        spellCheck={false}
                        className="font-mono text-[13px]"
                        {...(shown ? { type: 'text', autoComplete: 'off' } : MASKED)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" aria-label={`Add reference to ${line.key}`} disabled={multiline}>
                            <BracesIcon aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          <DropdownMenuLabel>This task</DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => insert(index, line.key, source, portReference(portDefault))}>
                            Port for a service <span className="ml-auto text-xs text-muted-foreground">replaces the selected port</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => insert(index, line.key, source, '${{ task.suffix }}')}>Suffix <span className="ml-auto font-mono text-xs text-muted-foreground">_3</span></DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => insert(index, line.key, source, '${{ task.slot }}')}>Slot number <span className="ml-auto font-mono text-xs text-muted-foreground">3</span></DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => insert(index, line.key, source, '${{ task.id }}')}>Task id</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>Paths</DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => insert(index, line.key, source, '${{ worktree.path }}')}>Worktree path</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => insert(index, line.key, source, '${{ project.root }}')}>Project root</DropdownMenuItem>
                          {[...keys].filter((key) => key !== line.key).length > 0 || otherFiles.length > 0 ? <DropdownMenuSeparator /> : null}
                          {[...keys].filter((key) => key !== line.key).length > 0 ? (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>This file</DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                                {[...keys].filter((key) => key !== line.key).map((key) => (
                                  <DropdownMenuItem key={key} className="font-mono text-xs" onSelect={() => insert(index, line.key, source, `\${{ ${key} }}`)}>{key}</DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          ) : null}
                          {otherFiles.filter((file) => file.variables.length > 0).map((file) => (
                            <DropdownMenuSub key={file.path}>
                              <DropdownMenuSubTrigger className="font-mono text-xs">{file.path}</DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                                {file.variables.map((key) => (
                                  <DropdownMenuItem key={key} className="font-mono text-xs" onSelect={() => insert(index, line.key, source, `\${{ ${file.path}:${key} }}`)}>{key}</DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button type="button" variant="ghost" size="icon" aria-label={`${shown ? 'Hide' : 'Show'} ${line.key}`} aria-pressed={shown} onClick={() => toggle(line.key)}>
                        {shown ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${line.key}`} onClick={() => { onChange(serializeEnv(removeVariable(lines, index))); setNameDrafts(new Map()) }}>
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </div>
                    {directive && hasReference(directive.source) ? (
                      <p className="truncate pl-1 font-mono text-xs text-muted-foreground" data-slot="env-rendered-value" aria-label={`${line.key} renders to`}>
                        → {rendered === undefined ? (preview.loading ? '…' : '—') : shown ? (rendered || '(empty)') : '••••••'}
                      </p>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      ) : (
        <SettingsNote>No variables yet.</SettingsNote>
      )}

      {adding ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start" data-slot="env-add-variable">
          <div className="min-w-0 sm:w-2/5">
            <Input
              aria-label="New variable name"
              placeholder="VARIABLE_NAME"
              value={newKey}
              autoFocus
              aria-invalid={newKeyIssue ? true : undefined}
              onChange={(event) => setNewKey(event.target.value.trim())}
              onKeyDown={onAddKey}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[13px]"
            />
            {newKeyIssue ? <SettingsNote tone="danger">{newKeyIssue}</SettingsNote> : null}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Input
              aria-label="New variable value"
              placeholder="VALUE or ${{ REF }}"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              onKeyDown={onAddKey}
              spellCheck={false}
              className="font-mono text-[13px]"
              {...MASKED}
            />
            <Button type="button" disabled={newKey === '' || !!newKeyIssue} onClick={add}>
              <CheckIcon aria-hidden="true" /> Add
            </Button>
            <Button type="button" variant="outline" onClick={() => { setNewKey(''); setNewValue(''); setAdding(false) }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" /> New variable
          </Button>
          {missing.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(serializeEnv(missing.reduce((acc, line) => (line.kind === 'var' ? addVariable(acc, line.key, line.value) : acc), lines)))}
            >
              <PlusIcon aria-hidden="true" /> Add {missing.length} missing from the example
            </Button>
          ) : null}
        </div>
      )}

      {kept > 0 ? (
        <SettingsNote>{kept} comment line{kept === 1 ? '' : 's'} kept as written — visible in Raw text.</SettingsNote>
      ) : null}
    </div>
  )
}

/**
 * The server's dry render of the draft, debounced: what each directive's variable becomes in the
 * main checkout or for one task. Only asked for while the file holds directives; the latest
 * answer wins, so a slow response for an older draft never overwrites a newer one.
 */
function useRenderPreview(path: string, text: string, runId: string, enabled: boolean) {
  const [state, setState] = useState<{ values: Map<string, string>; error: string | null; loading: boolean; slot: number | null }>({ values: new Map(), error: null, loading: false, slot: null })
  const latest = useRef(0)
  useEffect(() => {
    if (!enabled) { setState({ values: new Map(), error: null, loading: false, slot: null }); return }
    const ticket = ++latest.current
    setState((current) => ({ ...current, loading: true }))
    const timer = setTimeout(() => {
      renderEnvFile({ path, content: text, ...(runId ? { runId } : {}) })
        .then((result) => {
          if (ticket !== latest.current) return
          setState({ values: new Map(result.values.map(({ key, value }) => [key, value])), error: null, loading: false, slot: result.slot })
        })
        .catch((error: unknown) => {
          if (ticket !== latest.current) return
          setState({ values: new Map(), error: error instanceof Error ? error.message : String(error), loading: false, slot: null })
        })
    }, 350)
    return () => clearTimeout(timer)
  }, [path, text, runId, enabled])
  return state
}
