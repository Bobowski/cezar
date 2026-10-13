import { CircleCheckIcon } from 'lucide-react'

import type { GithubOwner } from '@open-mercato/cezar-api-client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

/** The choice-card look both add-project dialogs give a single-select `ToggleGroupItem`. */
export const choiceCard =
  'h-auto w-full justify-start rounded-lg border-border bg-card text-left font-normal whitespace-normal shadow-none hover:bg-muted/50 hover:text-foreground data-[state=on]:border-primary data-[state=on]:bg-primary/5'

/**
 * The account a repository belongs to — the signed-in user first, then their organisations.
 * Shared by "New project" (where the repository is created) and "Clone from GitHub" (whose
 * repositories are listed). A single-select toggle group, so arrow keys move between cards.
 * `slot` prefixes the `data-slot`s, so each dialog's tests address their own picker.
 */
export function GithubOwnerPicker({
  owners,
  value,
  disabled = false,
  onChange,
  slot,
}: {
  owners: GithubOwner[]
  value: string
  disabled?: boolean
  onChange: (login: string) => void
  slot: string
}) {
  const labelId = `${slot}-owner-label`
  return (
    <div className="grid gap-3 md:flex md:min-h-0 md:flex-1 md:flex-col">
      <span id={labelId} className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        Select organization
      </span>
      <ToggleGroup
        type="single"
        orientation="vertical"
        variant="outline"
        spacing={2}
        value={value}
        disabled={disabled}
        // A single toggle group lets the pressed item be un-pressed; an owner is always chosen.
        onValueChange={(next) => (next ? onChange(next) : undefined)}
        aria-labelledby={labelId}
        data-slot={`${slot}-owner`}
        className="-mx-1 max-h-64 w-auto flex-col items-stretch overflow-y-auto px-1 py-0.5 md:max-h-none md:min-h-0 md:flex-1"
      >
        {owners.map((owner) => (
          <ToggleGroupItem
            key={owner.login}
            value={owner.login}
            data-slot={`${slot}-owner-option`}
            data-owner={owner.login}
            className={cn(choiceCard, 'gap-3 px-3 py-2.5')}
          >
            {/* Organisations are rounded squares and people are circles, as on GitHub. */}
            <Avatar className={cn('size-9', owner.personal ? undefined : 'rounded-md')}>
              {owner.avatarUrl ? <AvatarImage src={owner.avatarUrl} alt="" /> : null}
              <AvatarFallback className={cn('font-semibold uppercase', owner.personal ? undefined : 'rounded-md')}>
                {owner.login.slice(0, 1)}
              </AvatarFallback>
            </Avatar>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-sm font-semibold">{owner.login}</span>
              {owner.personal ? <span className="text-xs text-muted-foreground">Personal account</span> : null}
            </span>
            {owner.login === value ? <CircleCheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/** Placeholder cards while `gh` is asked for the accounts, so the column does not pop in. */
export function GithubOwnerPickerLoading({ slot }: { slot: string }) {
  return (
    <div className="grid gap-3" data-slot={`${slot}-owners-loading`} aria-hidden="true">
      <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Select organization</span>
      {[0, 1].map((index) => (
        <div key={index} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  )
}
