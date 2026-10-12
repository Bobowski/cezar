import { useEffect, useMemo, useState } from 'react'

import { createCodeFile, deleteCodeFile, renameCodeFile, type CodeTree } from '@/api/code'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { matchPaths } from '@/routes/repo-git/match-paths'

/** One thing the page can do, as the palette lists it. */
export interface CodeCommand {
  id: string
  title: string
  shortcut?: string
  disabled?: boolean
  run: () => void
}

/** A filter-as-you-type list in a dialog: the shape quick open and the command palette share. */
function Picker<T>({
  open, slot, title, placeholder, items, render, onClose, onPick,
}: {
  open: boolean
  slot: string
  title: string
  placeholder: string
  items: (query: string) => T[]
  render: (item: T) => { key: string; label: React.ReactNode; hint?: string; disabled?: boolean }
  onClose: () => void
  onPick: (item: T) => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  useEffect(() => { if (open) { setQuery(''); setIndex(0) } }, [open])
  const results = useMemo(() => (open ? items(query) : []), [items, open, query])
  const pick = (item: T | undefined) => { if (item !== undefined && !render(item).disabled) onPick(item) }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent data-slot={slot} className="top-[18%] translate-y-0 gap-2 p-3">
        <DialogHeader className="sr-only"><DialogTitle>{title}</DialogTitle><DialogDescription>{placeholder}</DialogDescription></DialogHeader>
        <Input
          autoFocus
          aria-label={title}
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(results.length - 1, value + 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)) }
            else if (event.key === 'Enter') { event.preventDefault(); pick(results[index]) }
          }}
        />
        <ul role="listbox" aria-label={title} className="max-h-80 overflow-y-auto text-[13px]">
          {results.map((item, at) => {
            const row = render(item)
            return (
              <li key={row.key} role="option" aria-selected={at === index} aria-disabled={row.disabled}>
                <button
                  type="button"
                  disabled={row.disabled}
                  className={cn('flex w-full items-center justify-between gap-4 rounded-md px-2 py-1 text-left disabled:opacity-40', at === index ? 'bg-accent text-foreground' : 'text-muted-foreground')}
                  onMouseEnter={() => setIndex(at)}
                  onClick={() => pick(item)}
                >
                  <span className="min-w-0 truncate">{row.label}</span>
                  {row.hint ? <span className="shrink-0 font-mono text-[11px] text-soft-foreground">{row.hint}</span> : null}
                </button>
              </li>
            )
          })}
          {results.length === 0 ? <li className="px-2 py-1 text-xs text-muted-foreground">{query.trim() === '' ? 'Type to search.' : 'Nothing matches.'}</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** Ctrl/Cmd+P: a client-side match over the path index — the same matcher the tree's filter uses. */
export function QuickOpen({ open, paths, recent, onClose, onPick }: { open: boolean; paths: readonly string[]; recent: readonly string[]; onClose: () => void; onPick: (path: string) => void }) {
  const items = useMemo(() => (query: string) => (query.trim() === '' ? [...recent] : matchPaths(paths, query, 40).results), [paths, recent])
  return (
    <Picker
      open={open}
      slot="code-quick-open"
      title="Go to File"
      placeholder="Search files by name"
      items={items}
      render={(path) => ({ key: path, label: <span className="font-mono">{path.slice(path.lastIndexOf('/') + 1)}<span className="pl-2 text-soft-foreground">{path.slice(0, Math.max(0, path.lastIndexOf('/')))}</span></span> })}
      onClose={onClose}
      onPick={(path) => { onClose(); onPick(path) }}
    />
  )
}

/** Ctrl/Cmd+Shift+P: everything the page can do, by name. */
export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: readonly CodeCommand[]; onClose: () => void }) {
  const items = useMemo(() => (query: string) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return commands.filter((command) => words.every((word) => command.title.toLowerCase().includes(word)))
  }, [commands])
  return (
    <Picker
      open={open}
      slot="code-command-palette"
      title="Command Palette"
      placeholder="Type a command"
      items={items}
      render={(command) => ({ key: command.id, label: command.title, hint: command.shortcut, disabled: command.disabled })}
      onClose={onClose}
      // After the dialog has closed: a command that focuses the editor must not lose to the
      // dialog handing focus back.
      onPick={(command) => { onClose(); setTimeout(command.run, 0) }}
    />
  )
}

export type FileAction =
  | { kind: 'create'; dir: string }
  | { kind: 'folder'; dir: string }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }

/** The file a new folder is created through: git tracks files, so an empty directory is nothing. */
const FOLDER_KEEPER = '.gitkeep'

/** Create, rename, delete — files only. The server's refusal is shown in its own words. */
export function FileDialog({
  tree, action, dirty, clean, onClose, onDone,
}: {
  tree: CodeTree
  action: FileAction | null
  /** The file has unsaved edits in an editor. */
  dirty: boolean
  /** Disk equals the committed version: a delete loses nothing git does not have. */
  clean: boolean
  onClose: () => void
  /** `from` is the path that went away (rename, delete); `to` the one to show next. */
  onDone: (from: string | null, to: string | null) => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const seed = action === null || action.kind === 'delete' ? '' : action.kind === 'rename' ? action.path : action.dir ? `${action.dir}/` : ''
  useEffect(() => { setValue(seed); setError(null) }, [seed, action?.kind])
  if (action === null) return null

  const run = async () => {
    const path = value.trim().replace(/\/+$/, '')
    setPending(true)
    setError(null)
    try {
      if (action.kind === 'create') {
        await createCodeFile(tree, path)
        onDone(null, path)
      } else if (action.kind === 'folder') {
        await createCodeFile(tree, `${path}/${FOLDER_KEEPER}`)
        onDone(null, null)
      } else if (action.kind === 'rename') {
        await renameCodeFile(tree, { from: action.path, to: path })
        onDone(action.path, path)
      } else {
        await deleteCodeFile(tree, action.path)
        onDone(action.path, null)
      }
      onClose()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setPending(false)
    }
  }
  const title = { create: 'New File', folder: 'New Folder', rename: 'Rename', delete: 'Delete this file?' }[action.kind]
  const description = action.kind === 'delete'
    ? clean ? 'It is removed from this checkout. Git still has the committed version.' : 'It is removed from this checkout. Changes that were never committed cannot be recovered from git.'
    : action.kind === 'folder' ? `A path inside this checkout. It is created with a ${FOLDER_KEEPER} file in it — git does not keep an empty folder.`
      : 'A path inside this checkout. Missing folders are created.'
  const unchanged = action.kind !== 'delete' && (value.trim().replace(/\/+$/, '') === seed.replace(/\/+$/, '') || value.trim() === '')
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose() }}>
      <DialogContent data-slot="code-file-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}{dirty ? ' Unsaved edits in the editor are discarded.' : ''}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void run() }} className="flex flex-col gap-3">
          {action.kind === 'delete' ? (
            <code className="block truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">{action.path}</code>
          ) : (
            <Input autoFocus aria-label="Path" value={value} onChange={(event) => setValue(event.target.value)} placeholder={action.kind === 'folder' ? 'src/new-folder' : 'src/new-file.ts'} spellCheck={false} autoComplete="off" className="font-mono" />
          )}
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={action.kind === 'delete' ? 'destructive' : 'primary'} disabled={pending || unchanged}>
              {{ create: 'Create', folder: 'Create', rename: 'Rename', delete: 'Delete' }[action.kind]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
