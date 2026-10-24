import { useState, type ReactNode } from 'react'

import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface DockerConfirmRequest {
  title: string
  /** What will happen, in a sentence. */
  body: ReactNode
  /** In red: what is in use (`task ffp-570 is running in it`). Nothing is refused for it. */
  warnings?: string[]
  /** Names the action takes with it (volumes, containers). */
  items?: { label: string; names: string[] }
  /** An opt-in extra, e.g. "also remove its volumes". */
  option?: { label: string; names?: string[] }
  /** Typed confirm: the action stays disabled until this is typed (spec §3.3 — data with no undo). */
  typeToConfirm?: string
  confirmLabel: string
  onConfirm: (option: boolean) => void
}

/**
 * The confirm every Docker removal goes through (spec 2026-10-23-docker-management §3.1) — the
 * whole safety: it names what is in use and by which task, and refuses nothing.
 */
export function DockerConfirm({ request, onClose }: { request: DockerConfirmRequest | null; onClose: () => void }) {
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      {request ? <ConfirmBody key={request.title} request={request} onClose={onClose} /> : null}
    </AlertDialog>
  )
}

function ConfirmBody({ request, onClose }: { request: DockerConfirmRequest; onClose: () => void }) {
  const [option, setOption] = useState(false)
  const [typed, setTyped] = useState('')
  const blocked = request.typeToConfirm !== undefined && typed !== request.typeToConfirm
  return (
    <AlertDialogContent data-slot="docker-confirm">
      <AlertDialogHeader>
        <AlertDialogTitle>{request.title}</AlertDialogTitle>
        <AlertDialogDescription>{request.body}</AlertDialogDescription>
      </AlertDialogHeader>
      {request.warnings && request.warnings.length > 0 ? (
        <ul data-slot="docker-confirm-warnings" className="space-y-1 text-sm font-medium text-danger">
          {request.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      {request.items && request.items.names.length > 0 ? (
        <div className="text-sm">
          <p className="text-muted-foreground">{request.items.label}</p>
          <ul data-slot="docker-confirm-items" className="mt-1 space-y-0.5 font-mono text-xs">
            {request.items.names.map((name) => <li key={name}>{name}</li>)}
          </ul>
        </div>
      ) : null}
      {request.option ? (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Checkbox id="docker-confirm-option" checked={option} onCheckedChange={(checked) => setOption(checked === true)} />
            <Label htmlFor="docker-confirm-option">{request.option.label}</Label>
          </div>
          {option && request.option.names && request.option.names.length > 0 ? (
            <ul data-slot="docker-confirm-option-names" className="ml-6 space-y-0.5 font-mono text-xs text-danger">
              {request.option.names.map((name) => <li key={name}>{name}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
      {request.typeToConfirm !== undefined ? (
        <div className="grid gap-1.5">
          <Label htmlFor="docker-confirm-typed">Type <span className="font-mono">{request.typeToConfirm}</span> to delete its data for good</Label>
          <Input id="docker-confirm-typed" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button
          className="bg-danger text-danger-foreground hover:brightness-[0.96]"
          disabled={blocked}
          onClick={() => { request.onConfirm(option); onClose() }}
        >
          {request.confirmLabel}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}
