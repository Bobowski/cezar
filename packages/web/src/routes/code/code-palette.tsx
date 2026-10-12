import { useEffect, useMemo, useState } from 'react'

import { createCodeFile, deleteCodeFile, renameCodeFile, type CodeTree } from '@/api/code'
import { Button } from '@/components/ui/button'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { matchPaths } from '@/routes/repo-git/match-paths'

/** One thing the page can do, as the palette lists it. */
export interface CodeCommand {
  id: string
  title: string
  shortcut?: string
  disabled?: boolean
  run: () => void
}

/** Every item is already the answer to the query: cmdk must not filter or reorder it again. */
const keepAll = () => 1

/** Ctrl/Cmd+P: a client-side match over the path index — the same matcher the tree's filter uses. */
export function QuickOpen({ open, paths, recent, onClose, onPick }: { open: boolean; paths: readonly string[]; recent: readonly string[]; onClose: () => void; onPick: (path: string) => void }) {
  const [query, setQuery] = useState('')
  useEffect(() => { if (open) setQuery('') }, [open])
  const results = useMemo(() => (!open ? [] : query.trim() === '' ? [...recent] : matchPaths(paths, query, 40).results), [open, paths, query, recent])
  return (
    <CommandDialog open={open} onOpenChange={(next) => { if (!next) onClose() }} title="Go to File" description="Search files by name" filter={keepAll} showCloseButton={false} className="top-[22%] translate-y-0">
      <div data-slot="code-quick-open" className="contents">
        <CommandInput value={query} onValueChange={setQuery} placeholder="Search files by name" />
        <CommandList>
          <CommandEmpty>{query.trim() === '' ? 'Type to search.' : 'No file matches.'}</CommandEmpty>
          {results.length > 0 ? (
            <CommandGroup heading={query.trim() === '' ? 'Open files' : 'Files'}>
              {results.map((path) => (
                <CommandItem key={path} value={path} onSelect={() => { onClose(); onPick(path) }}>
                  <span className="truncate font-mono text-[13px]">{path.slice(path.lastIndexOf('/') + 1)}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{path.slice(0, Math.max(0, path.lastIndexOf('/')))}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </div>
    </CommandDialog>
  )
}

/** Ctrl/Cmd+Shift+P: everything the page can do, by name. */
export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: readonly CodeCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  useEffect(() => { if (open) setQuery('') }, [open])
  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return commands.filter((command) => words.every((word) => command.title.toLowerCase().includes(word)))
  }, [commands, query])
  return (
    <CommandDialog open={open} onOpenChange={(next) => { if (!next) onClose() }} title="Command Palette" description="Type a command" filter={keepAll} showCloseButton={false} className="top-[22%] translate-y-0">
      <div data-slot="code-command-palette" className="contents">
        <CommandInput value={query} onValueChange={setQuery} placeholder="Type a command" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {results.length > 0 ? (
            <CommandGroup heading="Commands">
              {results.map((command) => (
                <CommandItem
                  key={command.id}
                  value={command.id}
                  disabled={command.disabled}
                  // After the dialog has closed: a command that focuses the editor must not lose
                  // to the dialog handing focus back.
                  onSelect={() => { onClose(); setTimeout(command.run, 0) }}
                >
                  {command.title}
                  {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </div>
    </CommandDialog>
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
