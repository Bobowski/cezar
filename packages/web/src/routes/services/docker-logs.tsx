import { useMemo, useState } from 'react'

import type { DockerContainer } from '@open-mercato/cezar-api-client'
import { readDockerLogs } from '@/api/client'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { TerminalPane, type TerminalIo } from '@/routes/task-workspace/terminal-pane'

/**
 * A container's logs in the pane pinned services use (spec 2026-10-23-docker-management §3.4).
 * The `docker-logs:<id>` topic rings with a cursor; the redacted bytes come over HTTP. Read-only:
 * `docker logs` has no stdin, so keystrokes go nowhere.
 */
export function DockerLogsSheet({ container, onClose }: { container: DockerContainer | null; onClose: () => void }) {
  return (
    <Sheet open={container !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="bottom" data-slot="docker-logs" className="h-[70vh] gap-0">
        {container ? <LogsBody container={container} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function LogsBody({ container }: { container: DockerContainer }) {
  // The topic arrives with the first read; until then the pane reads once and waits.
  const [topic, setTopic] = useState<string | null>(null)
  const io = useMemo<TerminalIo>(() => ({
    read: async (cursor) => {
      const logs = await readDockerLogs(container.id, cursor)
      setTopic(logs.topic)
      // Docker's own newlines, made the emulator's; no PTY sits between it and us.
      return { data: logs.data.replace(/\r?\n/g, '\r\n'), cursor: logs.cursor, truncated: logs.truncated, exitCode: logs.following ? null : 0 }
    },
    write: async () => undefined,
    resize: async () => undefined,
  }), [container.id])
  return (
    <>
      <SheetHeader className="border-b border-border px-4 py-3">
        <SheetTitle className="font-mono text-sm">{container.name}</SheetTitle>
        <SheetDescription className="text-xs">{container.image} · {container.status} · last 500 lines, then live</SheetDescription>
      </SheetHeader>
      <div className="relative min-h-0 flex-1 bg-card-2">
        <TerminalPane runId="" io={io} active session={{ id: `docker-logs:${container.id}`, topic, exitCode: null }} />
      </div>
    </>
  )
}
