import { PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { getStartApp, setStartApp } from '@/api/client'
import type { StartAppRecipe, StartAppScope, StartAppState } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

const MAX_SERVICES = 5

const SCOPES: Array<{ scope: StartAppScope; title: string; detail: string }> = [
  {
    scope: 'project',
    title: 'Team',
    detail: "Saved in the repo's .ai/cezar/config.json. Commit it and everyone gets the same Start app.",
  },
  {
    scope: 'personal',
    title: 'Only me',
    detail: 'Saved in your ~/.cezar/config.json, and used instead of the team recipe.',
  },
]

/**
 * Edit a project's start recipe (spec `2026-10-09-design-mode` §7c): the services that start the
 * app, each in its own terminal tab, and optionally the address to show. Team and personal
 * recipes are edited separately; the personal one wins.
 */
export function StartAppEditor({
  open,
  onOpenChange,
  suggestion,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the form starts with when the chosen scope has no recipe yet. */
  suggestion: { services: string[]; url?: string }
  onSaved: () => void
}) {
  const [state, setState] = useState<StartAppState | null>(null)
  const [scope, setScope] = useState<StartAppScope>('project')
  const [services, setServices] = useState<string[]>([''])
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const fill = (recipe: StartAppRecipe | null) => {
    const source = recipe ?? suggestion
    setServices(source.services.length > 0 ? [...source.services] : [''])
    setUrl(source.url ?? '')
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    let cancelled = false
    void getStartApp()
      .then((loaded) => {
        if (cancelled) return
        setState(loaded)
        // Open on the recipe in force: yours when you have one.
        const initial: StartAppScope = loaded.personal ? 'personal' : 'project'
        setScope(initial)
        fill(loaded[initial])
      })
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
    // `suggestion` is read once per opening, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const save = async (recipe: StartAppRecipe | null) => {
    setSaving(true)
    setError(null)
    try {
      setState(await setStartApp({ scope, recipe }))
      onSaved()
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const cleaned = services.map((service) => service.trim()).filter(Boolean)
  const address = url.trim()
  const addressInvalid = address !== '' && !/^https?:\/\/\S+$/.test(address)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start recipe</DialogTitle>
          <DialogDescription>
            What starts this project's app for the Preview. Each command runs in its own terminal tab of the task.
            Installing dependencies is not part of it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Radio cards, as in Settings → Appearance: a single-mode ToggleGroup is a real radiogroup. */}
          <ToggleGroup
            type="single"
            aria-label="Who uses this recipe"
            value={scope}
            // Radix reports '' when the chosen card is clicked again; a radio card cannot be released.
            onValueChange={(next) => {
              if (next !== 'project' && next !== 'personal') return
              setScope(next)
              fill(state?.[next] ?? null)
            }}
            spacing={2}
            className="grid w-full grid-cols-2 gap-2"
          >
            {SCOPES.map((entry) => {
              const disabled = entry.scope === 'personal' && state?.personalAvailable === false
              const selected = scope === entry.scope
              return (
                <ToggleGroupItem
                  key={entry.scope}
                  value={entry.scope}
                  disabled={disabled}
                  className={cn(
                    'flex h-auto w-full min-w-0 flex-col items-start gap-1 rounded-md border bg-card p-2.5 text-left text-xs whitespace-normal shadow-xs transition-colors',
                    'hover:bg-card hover:text-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground',
                    selected ? 'border-foreground/40' : 'border-border hover:border-soft-foreground',
                  )}
                >
                  <span className="font-medium text-foreground">
                    {entry.title}
                    {state?.[entry.scope] ? <span className="ml-1.5 font-normal text-muted-foreground">· saved</span> : null}
                  </span>
                  <span className="font-normal text-muted-foreground">
                    {disabled ? 'This project is not in your project list.' : entry.detail}
                  </span>
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>

          <FieldSet className="gap-1.5">
            <FieldLegend variant="label" className="mb-1.5 text-xs">Services</FieldLegend>
            {services.map((service, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={service}
                  onChange={(event) =>
                    setServices((current) => current.map((entry, at) => (at === index ? event.target.value : entry)))
                  }
                  placeholder={index === 0 ? 'npm run dev' : 'npm run api'}
                  aria-label={`Service ${index + 1}`}
                  spellCheck={false}
                  className="h-8 font-mono text-xs md:text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove service ${index + 1}`}
                  disabled={services.length === 1}
                  onClick={() => setServices((current) => current.filter((_, at) => at !== index))}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="self-start text-muted-foreground"
              disabled={services.length >= MAX_SERVICES}
              onClick={() => setServices((current) => [...current, ''])}
            >
              <PlusIcon aria-hidden="true" />
              Add service
            </Button>
          </FieldSet>

          <Field className="gap-1.5" data-invalid={addressInvalid || undefined}>
            <FieldLabel htmlFor="start-app-address" className="text-xs">Address to show (optional)</FieldLabel>
            <Input
              id="start-app-address"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://localhost:5173 — empty: the first address a service prints"
              aria-label="Address to show"
              aria-invalid={addressInvalid}
              spellCheck={false}
              className="h-8 font-mono text-xs md:text-xs"
            />
            {addressInvalid ? <FieldDescription className="text-xs text-danger">Start it with http:// or https://</FieldDescription> : null}
          </Field>

          {error ? <FieldError className="text-xs">{error}</FieldError> : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {state?.[scope] ? (
            <Button type="button" variant="ghost" disabled={saving} onClick={() => void save(null)}>
              Remove {scope === 'project' ? 'team' : 'your'} recipe
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={saving || cleaned.length === 0 || addressInvalid}
              onClick={() => void save({ services: cleaned, ...(address ? { url: address } : {}) })}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
