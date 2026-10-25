import { ChevronDownIcon, PlayIcon } from 'lucide-react'
import { useCallback, useState } from 'react'

import type { DiscoveredCommandEntry } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'

import { scopeKey, terminalCommands, type TerminalScope } from './scope'

/**
 * The commands a scope's project defines (spec `.ai/specs/2026-10-07-task-workspace.md` §6,
 * lifted for the Code page by `2026-10-24-code-page-terminal.md` §3.1). Discovery only: a command
 * runs when the user picks it, and then in a NEW terminal tab — never the one being looked at.
 */
export function DiscoveredCommandsStrip({
  scope,
  onRun,
}: {
  scope: TerminalScope
  onRun: (command: string) => void
}) {
  const [commands, setCommands] = useState<DiscoveredCommandEntry[]>([])
  const [manual, setManual] = useState('')

  const key = scopeKey(scope)
  const load = useCallback(() => {
    void terminalCommands(scope)
      .then((state) => setCommands(state.commands))
      .catch(() => {})
    // `scope` is identified by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs text-muted-foreground">
          <PlayIcon aria-hidden="true" className="size-3" />
          Run
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
        <DropdownMenuLabel>Project commands</DropdownMenuLabel>
        {commands.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-soft-foreground">
            No commands found in package.json or a Makefile. Type your own below.
          </p>
        ) : (
          commands.map((entry) => (
            <DropdownMenuItem
              key={`${entry.source}:${entry.command}`}
              onSelect={() => onRun(entry.command)}
              className="flex-col items-start gap-0"
            >
              <span className="font-mono text-xs">{entry.command}</span>
              {/* The source file travels with the command: `dev` means one thing in a Makefile
                  and another in npm, and you are about to hand a shell one of them. */}
              <span className="text-[11px] text-soft-foreground">
                {entry.source}
                {entry.detail ? ` — ${entry.detail}` : ''}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-soft-foreground">Custom command</DropdownMenuLabel>
        <form
          className="px-2 pb-1"
          onSubmit={(event) => {
            event.preventDefault()
            const command = manual.trim()
            if (command === '') return
            setManual('')
            onRun(command)
          }}
        >
          <Input
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            // Radix would treat typing as menu type-ahead and steal the keystrokes.
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="e.g. npm run dev"
            aria-label="Custom command"
            spellCheck={false}
            className="h-8 px-2 font-mono text-xs shadow-none focus-visible:ring-0 md:text-xs dark:bg-card"
          />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
