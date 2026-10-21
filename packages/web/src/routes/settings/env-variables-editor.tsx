import { CheckIcon, EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'

import {
  ENV_KEY_PATTERN,
  addVariable,
  duplicateKeys,
  parseEnv,
  removeLine,
  serializeEnv,
  setVariable,
} from '@/lib/dotenv-lines'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SettingsNote } from './settings-field'

/** Masked like a password, but not one: password managers must not offer to save it. */
const MASKED = { type: 'password', autoComplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true' } as const

/**
 * Settings → Environment, variable by variable (spec 2026-10-12-project-env-files). Edits the
 * file's TEXT through `lib/dotenv-lines`, so a line nobody touched — a comment, a quoted value —
 * is saved exactly as it was, and switching to the raw text view loses nothing.
 */
export function EnvVariablesEditor({ path, text, template, onChange }: {
  path: string
  text: string
  template: string | null
  onChange: (text: string) => void
}) {
  const lines = useMemo(() => parseEnv(text), [text])
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  // A name being typed may be briefly invalid ("", "1"); it reaches the text only once valid,
  // or the line would stop parsing as a variable and its row would vanish mid-keystroke.
  const [nameDrafts, setNameDrafts] = useState<Map<number, string>>(new Map())
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [adding, setAdding] = useState(false)

  const dupes = duplicateKeys(lines)
  const keys = new Set(lines.flatMap((line) => (line.kind === 'var' ? [line.key] : [])))
  const missing = template === null ? [] : parseEnv(template).flatMap((line) => (line.kind === 'var' && !keys.has(line.key) ? [line] : []))
  const kept = lines.filter((line) => line.kind === 'other' && line.raw.trim() !== '').length
  const newKeyIssue = newKey === '' ? null
    : !ENV_KEY_PATTERN.test(newKey) ? 'Letters, digits and _ . - only, not starting with a digit.'
    : keys.has(newKey) ? `${newKey} is already set — edit it above.` : null

  const toggle = (index: number) => setRevealed((current) => {
    const next = new Set(current)
    if (next.has(index)) next.delete(index); else next.add(index)
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

  const rows = lines.flatMap((line, index) => (line.kind === 'var' ? [{ line, index }] : []))

  return (
    <div className="flex flex-col gap-3" data-slot="env-variables-editor">
      {rows.length > 0 ? (
        <Card flush>
          <ul className="divide-y divide-border" aria-label={`Variables in ${path}`}>
            {rows.map(({ line, index }) => {
              const name = nameDrafts.get(index) ?? line.key
              const invalid = !ENV_KEY_PATTERN.test(name)
              const shown = revealed.has(index)
              const multiline = line.value.includes('\n')
              return (
                <li key={index} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-start">
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
                        if (ENV_KEY_PATTERN.test(next)) onChange(serializeEnv(setVariable(lines, index, next, line.value)))
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono text-[13px]"
                    />
                    {invalid ? <SettingsNote tone="danger">Letters, digits and _ . - only, not starting with a digit.</SettingsNote> : null}
                    {dupes.has(line.key) ? <SettingsNote tone="danger">Set more than once — the last one wins.</SettingsNote> : null}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Input
                      aria-label={`Value of ${line.key}`}
                      value={line.value}
                      readOnly={multiline}
                      title={multiline ? 'A multi-line value — edit it in Raw text.' : undefined}
                      onChange={(event) => onChange(serializeEnv(setVariable(lines, index, line.key, event.target.value)))}
                      spellCheck={false}
                      className="font-mono text-[13px]"
                      {...(shown ? { type: 'text', autoComplete: 'off' } : MASKED)}
                    />
                    <Button type="button" variant="ghost" size="icon" aria-label={`${shown ? 'Hide' : 'Show'} ${line.key}`} aria-pressed={shown} onClick={() => toggle(index)}>
                      {shown ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                    </Button>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${line.key}`} onClick={() => { onChange(serializeEnv(removeLine(lines, index))); setRevealed(new Set()); setNameDrafts(new Map()) }}>
                      <Trash2Icon aria-hidden="true" />
                    </Button>
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
              placeholder="VALUE"
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
