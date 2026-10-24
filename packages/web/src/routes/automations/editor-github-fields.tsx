import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'

import type { AutomationDeliver, AutomationEvent } from '@open-mercato/cezar-api-client'
import { Chip } from '@/components/chip'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

import { GITHUB_EVENTS, POLL_MINUTES, clamp, hasPullRequestEvent, needsChangedLabels, type DraftFilters } from './editor-draft'

const COMMENT_EVENTS: readonly AutomationEvent[] = ['pull_request.commented', 'pull_request.review_commented', 'issue.commented']

/**
 * The "When GitHub changes" half of the When section (spec 2026-09-14-automations-redesign
 * § UI/UX 4.3): the event chips (multi-select — the contract is `events[]`), the poll line,
 * where a pull request's event goes (spec 2026-10-23-github-events §5), and the filters under a
 * Collapsible the export does not draw — each activity filter only once its event is picked.
 */
export function EditorGithubFields({
  events,
  intervalSeconds,
  filters,
  deliver,
  onChange,
}: {
  events: readonly AutomationEvent[]
  intervalSeconds: number
  filters: DraftFilters
  deliver?: AutomationDeliver
  onChange: (patch: { events?: AutomationEvent[]; intervalSeconds?: number; filters?: DraftFilters; deliver?: AutomationDeliver }) => void
}) {
  const hasList = (['authors', 'assignees', 'anyLabels', 'allLabels', 'excludeLabels', 'changedLabels', 'reviewers', 'mentions', 'branches', 'tags'] as const)
    .some((key) => filters[key].trim().length > 0)
  const activityFilter = filters.conclusion !== 'any' || filters.prerelease !== 'both' || filters.includeOwnPushes
  const [open, setOpen] = useState(hasList || activityFilter || filters.lookbackDays !== 7 || filters.maxRecords !== 25)
  const comments = events.some((event) => COMMENT_EVENTS.includes(event))
  const branchEvents = events.includes('pull_request.synchronize') || events.includes('push')
  const checks = events.includes('check_suite.completed')
  const releases = events.includes('release.published')
  const setFilter = <K extends keyof DraftFilters>(key: K, value: DraftFilters[K]) =>
    onChange({ filters: { ...filters, [key]: value } })
  const toggleEvent = (event: AutomationEvent) => {
    const next = events.includes(event) ? events.filter((item) => item !== event) : [...events, event]
    onChange({ events: GITHUB_EVENTS.filter((item) => next.includes(item)) })
  }
  const changedRequired = needsChangedLabels(events)
  const changedMissing = changedRequired && filters.changedLabels.trim().length === 0

  return (
    <div data-slot="editor-github" className="flex flex-col gap-4">
      <div role="group" aria-label="GitHub events" className="flex flex-wrap gap-1.5">
        {GITHUB_EVENTS.map((event) => (
          <Chip
            key={event}
            active={events.includes(event)}
            aria-pressed={events.includes(event)}
            className="font-mono"
            onClick={() => toggleEvent(event)}
          >
            {event}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        Poll every
        <Select value={String(Math.round(intervalSeconds / 60))} onValueChange={(value) => onChange({ intervalSeconds: Number(value) * 60 })}>
          <SelectTrigger size="sm" aria-label="Poll interval" className="text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLL_MINUTES.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>· last {filters.lookbackDays} days · maximum {filters.maxRecords} records</span>
      </div>
      {hasPullRequestEvent(events) ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          A pull request’s event goes to
          <Select value={deliver ?? 'new-run'} onValueChange={(value) => onChange({ deliver: value as AutomationDeliver })}>
            <SelectTrigger size="sm" aria-label="Deliver to" className="text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new-run">a new task</SelectItem>
              <SelectItem value="owning-run">the task that owns the PR</SelectItem>
            </SelectContent>
          </Select>
          {deliver === 'owning-run' ? <span>· a new task only when no task owns it</span> : null}
        </div>
      ) : null}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 self-start rounded-none p-0 hover:bg-transparent active:translate-y-0"
          >
            <ChevronDownIcon aria-hidden="true" className={cn('size-3.5 transition-transform', open ? '' : '-rotate-90')} />
            Filters
            {changedMissing ? <span className="text-danger">· changed labels required</span> : null}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div data-slot="editor-github-filters" className="grid grid-cols-1 gap-x-4 gap-y-4 pt-3 sm:grid-cols-2">
            <FilterField id="filter-authors" label="Authors" value={filters.authors} onChange={(value) => setFilter('authors', value)} />
            <FilterField id="filter-assignees" label="Assignees" value={filters.assignees} onChange={(value) => setFilter('assignees', value)} />
            <FilterField id="filter-any-labels" label="Any of labels" value={filters.anyLabels} onChange={(value) => setFilter('anyLabels', value)} />
            <FilterField id="filter-all-labels" label="All of labels" value={filters.allLabels} onChange={(value) => setFilter('allLabels', value)} />
            <FilterField id="filter-exclude-labels" label="Exclude labels" value={filters.excludeLabels} onChange={(value) => setFilter('excludeLabels', value)} />
            <FilterField
              id="filter-changed-labels"
              label={changedRequired ? 'Changed labels (required)' : 'Changed labels'}
              value={filters.changedLabels}
              invalid={changedMissing}
              onChange={(value) => setFilter('changedLabels', value)}
            />
            <FilterField id="filter-reviewers" label="Reviewers" value={filters.reviewers} onChange={(value) => setFilter('reviewers', value)} />
            {comments ? (
              <FilterField id="filter-mentions" label="Mentions (@login in the comment)" value={filters.mentions} onChange={(value) => setFilter('mentions', value)} />
            ) : null}
            {branchEvents ? (
              <FilterField id="filter-branches" label="Branches (exact or * glob)" value={filters.branches} onChange={(value) => setFilter('branches', value)} />
            ) : null}
            {releases ? (
              <FilterField id="filter-tags" label="Release tags (exact or * glob)" value={filters.tags} onChange={(value) => setFilter('tags', value)} />
            ) : null}
            {releases ? (
              <ChoiceField
                id="filter-prerelease"
                label="Prereleases"
                value={filters.prerelease}
                options={[['both', 'Releases and prereleases'], ['none', 'Releases only'], ['only', 'Prereleases only']]}
                onChange={(value) => setFilter('prerelease', value)}
              />
            ) : null}
            {checks ? (
              <ChoiceField
                id="filter-conclusion"
                label="CI result"
                value={filters.conclusion}
                options={[['any', 'Any result'], ['failure', 'Failed'], ['success', 'Passed']]}
                onChange={(value) => setFilter('conclusion', value)}
              />
            ) : null}
            {checks ? (
              <div className="flex items-center gap-2 self-end">
                <Checkbox
                  id="filter-own-pushes"
                  checked={filters.includeOwnPushes}
                  onCheckedChange={(checked) => setFilter('includeOwnPushes', checked === true)}
                />
                <Label htmlFor="filter-own-pushes" className="text-[13px] font-normal">Also react to CI on commits cezar pushed</Label>
              </div>
            ) : null}
            <NumberField id="filter-lookback" label="Lookback days (1–90)" value={filters.lookbackDays} min={1} max={90} onChange={(value) => setFilter('lookbackDays', value)} />
            <NumberField id="filter-max-records" label="Max records (1–100)" value={filters.maxRecords} min={1} max={100} onChange={(value) => setFilter('maxRecords', value)} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function FilterField({ id, label, value, invalid = false, onChange }: {
  id: string
  label: string
  value: string
  invalid?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px] font-medium">{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder="comma-separated"
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="text-[13px]"
      />
    </div>
  )
}

function ChoiceField<V extends string>({ id, label, value, options, onChange }: {
  id: string
  label: string
  value: V
  options: ReadonlyArray<readonly [V, string]>
  onChange: (value: V) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px] font-medium">{label}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as V)}>
        <SelectTrigger id={id} size="sm" className="text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

function NumberField({ id, label, value, min, max, onChange }: {
  id: string
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px] font-medium">{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
        className="w-28 text-[13px] tabular-nums"
      />
    </div>
  )
}
