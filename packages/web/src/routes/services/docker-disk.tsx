import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RecycleIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'

import type { DockerDisk, DockerDiskKind, DockerReclaimItem, DockerReclaimPlan, DockerReclaimResult } from '@open-mercato/cezar-api-client'
import { applyDockerReclaim, planDockerReclaim } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useDockerDisk } from '@/api/services'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'

import { formatBytes } from './docker-format'

const KIND_LABEL: Record<DockerDiskKind, string> = {
  images: 'Images', containers: 'Containers', volumes: 'Volumes', 'build-cache': 'Build cache',
}

/** "Docker 41 GB, 12 GB reclaimable" — the one line Machine glance shows (spec §3.6). */
export const diskSummary = (disk: Pick<DockerDisk, 'totalBytes' | 'reclaimableBytes'>): string =>
  `Docker ${formatBytes(disk.totalBytes)}, ${formatBytes(disk.reclaimableBytes)} reclaimable`

const stepId = (item: DockerReclaimItem): string =>
  item.step.kind === 'stack' ? `stack:${item.step.name}` : item.step.kind === 'container' ? `container:${item.step.id}` : item.step.kind

/** `docker system df` and the Reclaim dialog (spec 2026-10-23-docker-management §3.6). */
export function DockerDiskView() {
  const disk = useDockerDisk()
  const [reclaiming, setReclaiming] = useState(false)
  const data = disk.data
  if (data && !data.available) {
    return <p role="note" className="text-sm text-pretty text-muted-foreground">{data.reason ?? 'Docker is unavailable on this cockpit.'}</p>
  }
  return (
    <div data-slot="docker-disk" className="grid gap-3">
      {disk.isError ? <p role="alert" className="text-sm text-danger">{disk.error.message}</p> : null}
      {data?.warning && data.dataRoot ? (
        <Alert variant="destructive" data-slot="docker-disk-warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Docker’s disk is {Math.round(data.dataRoot.usedPct)} % full</AlertTitle>
          <AlertDescription>{formatBytes(data.dataRoot.freeBytes)} free on {data.dataRoot.path}. Reclaim frees what nothing needs.</AlertDescription>
        </Alert>
      ) : null}
      {data ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-sm">{diskSummary(data)}</CardTitle>
            <Button variant="outline" size="sm" onClick={() => setReclaiming(true)}>
              <RecycleIcon aria-hidden="true" /> Reclaim…
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="font-normal">Kind</th><th className="font-normal">Count</th><th className="text-right font-normal">Size</th><th className="text-right font-normal">Reclaimable</th></tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <tr key={entry.kind} data-slot="docker-disk-entry" data-kind={entry.kind}>
                    <td>{KIND_LABEL[entry.kind]}</td>
                    <td>{entry.count}{entry.active > 0 ? ` (${entry.active} active)` : ''}</td>
                    <td className="text-right">{formatBytes(entry.totalBytes)}</td>
                    <td className="text-right">{formatBytes(entry.reclaimableBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.dataRoot ? (
              <div data-slot="docker-data-root" className="grid gap-1">
                <p className="text-xs text-muted-foreground">
                  Data root {data.dataRoot.path}: {formatBytes(data.dataRoot.sizeBytes - data.dataRoot.freeBytes)} of {formatBytes(data.dataRoot.sizeBytes)} used
                </p>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', data.warning ? 'bg-danger' : 'bg-primary')} style={{ width: `${Math.min(100, data.dataRoot.usedPct)}%` }} />
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">The daemon’s data root is not on this machine’s filesystem, so its free space is not shown.</p>
            )}
          </CardContent>
        </Card>
      ) : null}
      <ReclaimDialog open={reclaiming} onClose={() => setReclaiming(false)} />
    </div>
  )
}

/** Lists exactly what Reclaim will do, with sizes; each line can be unchecked. */
export function ReclaimDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      {open ? <ReclaimBody onClose={onClose} /> : null}
    </Dialog>
  )
}

function ReclaimBody({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  // Planned on open, never cached: the dialog says what it will do now, before anything can run.
  const planning = useQuery({ queryKey: queryKeys.docker.reclaimPlan(), queryFn: planDockerReclaim, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false })
  const plan: DockerReclaimPlan | null = planning.data ?? null
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [result, setResult] = useState<DockerReclaimResult | null>(null)
  const apply = useMutation({
    mutationFn: (items: DockerReclaimItem[]) => applyDockerReclaim(items.map((item) => item.step)),
    onSuccess: setResult,
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.docker.state() }),
  })
  const items = plan?.items ?? []
  const chosen = items.filter((item) => !unchecked.has(stepId(item)))
  const toggle = (id: string, on: boolean) => setUnchecked((current) => {
    const next = new Set(current)
    if (on) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <DialogContent data-slot="docker-reclaim" className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Reclaim Docker disk</DialogTitle>
        <DialogDescription>
          Dangling images, build cache, and the stacks of task worktrees that no longer exist. Never a volume of a stack whose directory exists,
          an image in use, or anything of a running task.
        </DialogDescription>
      </DialogHeader>
      {result ? (
        <div data-slot="docker-reclaim-result" className="grid gap-2 text-sm">
          <p className="font-medium">Freed {formatBytes(result.freedBytes)}.</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">{result.log.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : planning.isError ? (
        <p role="alert" className="text-sm text-danger">{planning.error.message}</p>
      ) : plan === null ? (
        <p className="text-sm text-muted-foreground">Working out what can go…</p>
      ) : !plan.available ? (
        <p role="note" className="text-sm text-muted-foreground">{plan.reason}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to reclaim.</p>
      ) : (
        <ul aria-label="What Reclaim will do" className="grid gap-2">
          {items.map((item) => {
            const id = stepId(item)
            return (
              <li key={id} data-slot="docker-reclaim-item" className="flex items-start gap-2 text-sm">
                <Checkbox id={`reclaim-${id}`} className="mt-0.5" checked={!unchecked.has(id)} onCheckedChange={(checked) => toggle(id, checked === true)} />
                <label htmlFor={`reclaim-${id}`} className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex justify-between gap-2"><span className="truncate">{item.label}</span><span className="shrink-0 tabular-nums">{formatBytes(item.bytes)}</span></span>
                  {item.detail ? <span className="truncate font-mono text-xs text-muted-foreground">{item.detail}</span> : null}
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
        {result ? null : (
          <Button
            className="bg-danger text-danger-foreground hover:brightness-[0.96]"
            disabled={chosen.length === 0 || apply.isPending}
            onClick={() => apply.mutate(chosen)}
          >
            Reclaim {formatBytes(chosen.reduce((sum, item) => sum + item.bytes, 0))}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  )
}
