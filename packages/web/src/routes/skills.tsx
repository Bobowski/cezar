import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, RefreshCwIcon, SearchIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { Link, useActiveProjectId } from '@/lib/project-router'

import { putUiState, refreshSkills } from '@/api/client'
import {
  queryKeys,
  useImportableSkills,
  useSkills,
  useSkillsUpdate,
  useUiState,
  useWorkflows,
} from '@/api/queries'
import type { Skill, UiState } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { ContextSidebar } from '@/components/context-sidebar'
import { Page, PageBody } from '@/components/page'
import { SkillDetailBody, SkillSourceTag } from '@/components/skill-detail'
import type { SkillActivation } from '@/components/skill-detail'
import { SkillEmptyHint } from '@/components/skill-empty-hint'
import { SkillsUpdateCard } from '@/components/skills-update-card'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { filterSkills, isProjectSkill, orderSkills, skillUsedBy } from '@/lib/skills'
import { cn } from '@/lib/utils'

type SkillCatalogItem = Skill & { enabled: boolean }

function effectiveImported(uiState: UiState | undefined, allNames: readonly string[]): string[] {
  const value = uiState?.importedSkills
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string' && !!name)
    : [...allNames]
}

function skillActivation(
  skill: SkillCatalogItem,
  importableNames: ReadonlySet<string>,
  pending: boolean,
  onToggle: (name: string) => void,
  importableUnavailable = false,
): SkillActivation | undefined {
  const alwaysEnabled =
    skill.source === 'ai' ||
    skill.source === 'cezar' ||
    skill.source === 'agents' ||
    skill.source === 'global'
  const canToggle = skill.source === 'team' && (importableNames.has(skill.name) || importableUnavailable)
  if (!alwaysEnabled && !canToggle) return undefined

  return {
    ariaLabel: alwaysEnabled
      ? `${skill.name} is always enabled`
      : `${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`,
    checked: alwaysEnabled || skill.enabled,
    disabled: alwaysEnabled || pending || importableUnavailable,
    onCheckedChange: () => onToggle(skill.name),
  }
}

/**
 * `/skills` — the skills catalog and selected skill preview. Open Mercato activation stays inline
 * in the catalog; bookmarklets live in the skill preview that launches them.
 *
 * Master–detail: the catalog (filter, refresh, update status, the rows with their switches) is the
 * contextual sidebar; the main area is the selected skill. On a phone that sidebar is a sheet, so
 * the bare `/skills` URL renders the catalog in main instead.
 *
 * The standing feedback items stay built in:
 *  - #377 project-first and bold: the list renders through `orderSkills`/`filterSkills`, the
 *    same pure module every picker uses;
 *  - #384 stable scroll/selection: selection lives in the URL (`?skill=<name>`), the rows are
 *    keyed React elements inside one persistent scroll container — a refresh re-renders rows
 *    in place instead of rebuilding the pane, so neither the selection nor the scroll
 *    position can be lost (the legacy innerHTML rebuild lost both).
 */

export function SkillsRoute() {
  return (
    <Page width="full" data-route="skills">
      <SkillsCatalog />
    </Page>
  )
}

function SkillsCatalog() {
  const projectId = useActiveProjectId() ?? ''
  const updateQuery = useSkillsUpdate(projectId, Boolean(projectId))
  const skillsQuery = useSkills()
  const workflowsQuery = useWorkflows()
  const importableQuery = useImportableSkills()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const queryClient = useQueryClient()
  const uiState = useUiState()
  // Phones have no sidebar column (it is a sheet), so the bare list URL renders the catalog in main.
  const { isMobile } = useSidebar()
  const importable = importableQuery.data ?? []
  const allImportableNames = useMemo(() => importable.map((skill) => skill.name), [importable])
  const importableNames = useMemo(() => new Set(allImportableNames), [allImportableNames])
  const enabledImportable = useMemo(
    () => new Set(effectiveImported(uiState.data, allImportableNames)),
    [uiState.data, allImportableNames],
  )
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const latestWrite = useRef(0)
  const toggleImportedSkill = useCallback((name: string) => {
    const key = queryKeys.uiState
    const skillsKey = queryKeys.skills
    const current = queryClient.getQueryData<UiState>(key)
    const previous = effectiveImported(current, allImportableNames)
    const next = previous.includes(name) ? previous.filter((entry) => entry !== name) : [...previous, name]

    queryClient.setQueryData(key, { ...current, importedSkills: next })
    const sequence = ++latestWrite.current
    writeChain.current = writeChain.current.then(async () => {
      try {
        const merged = await putUiState({ importedSkills: next }, projectId)
        if (sequence !== latestWrite.current) return
        queryClient.setQueryData(key, merged)
        void queryClient.invalidateQueries({ queryKey: skillsKey })
      } catch (error: unknown) {
        if (sequence !== latestWrite.current) return
        toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
        void queryClient.invalidateQueries({ queryKey: key })
      }
    })
  }, [allImportableNames, projectId, queryClient])

  const refresh = useMutation({
    mutationFn: () => refreshSkills(),
    onSuccess: (catalog) => {
      // The POST answers the merged catalog — seed the shared query instead of refetching.
      queryClient.setQueryData(queryKeys.skills, catalog)
      toast('Team skills refreshed.')
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })

  if (skillsQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load skills"
        subtitle={skillsQuery.error.message}
      />
    )
  }

  const skills = orderSkills(skillsQuery.data ?? [])
  const activeNames = new Set(skills.map((skill) => skill.name))
  const catalog = orderSkills<SkillCatalogItem>([
    ...skills.map((skill) => ({
      ...skill,
      enabled: skill.source === 'team' && importableNames.has(skill.name) ? enabledImportable.has(skill.name) : true,
    })),
    ...importable
      .filter((skill) => !activeNames.has(skill.name))
      .map((skill) => ({ ...skill, enabled: enabledImportable.has(skill.name) })),
  ].sort((a, b) => a.name.localeCompare(b.name)))
  const param = searchParams.get('skill')
  const selected = catalog.find((skill) => skill.name === param) ?? (param === null ? catalog.find((skill) => skill.enabled) : null) ?? null
  const selection = selected?.name ?? null
  const selectedActivation = selected
    ? skillActivation(selected, importableNames, uiState.isPending, toggleImportedSkill, importableQuery.isError)
    : undefined
  const shown = filterSkills(catalog, query)

  const listHeader = (
    <>
      <div className="min-w-0 px-1">
        <h2 className="text-[15px] font-semibold text-foreground">Skills</h2>
        <p className="truncate text-xs text-muted-foreground">Markdown playbooks agents can follow.</p>
      </div>
      <div className="flex items-center gap-1">
        <InputGroup className="bg-background shadow-none">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            data-slot="skills-filter"
            placeholder="Filter skills…"
            aria-label="Filter skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <Button
          variant="ghost"
          size="icon-sm"
          data-slot="skills-refresh"
          aria-label="Refresh team skills"
          title="git fetch the team skills repos"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
          className="shrink-0"
        >
          <RefreshCwIcon aria-hidden="true" className={cn(refresh.isPending && 'motion-safe:animate-spin')} />
        </Button>
      </div>
    </>
  )

  const listRows = (
    <>
      {projectId ? (
        <div className="pb-2">
          <SkillsUpdateCard projectId={projectId} state={updateQuery.data} loadError={updateQuery.error} />
        </div>
      ) : null}
      {importableQuery.isError ? (
        <div
          data-slot="skills-importable-error"
          role="alert"
          className="mb-2 flex items-center justify-between gap-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <p className="min-w-0">
            Could not load the Open Mercato skills catalog. Team skills may be missing until it loads.{' '}
            {importableQuery.error.message}
          </p>
          <Button
            type="button"
            data-action="skills-importable-retry"
            variant="ghost"
            size="sm"
            disabled={importableQuery.isFetching}
            onClick={() => void importableQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <ul data-slot="skill-rows" className="flex flex-col gap-0.5">
        {skillsQuery.isPending ? (
          <li className="px-2 py-1.5 text-[13px] text-muted-foreground">Loading…</li>
        ) : shown.length > 0 ? (
          shown.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              active={selection === skill.name}
              activation={skillActivation(
                skill,
                importableNames,
                uiState.isPending,
                toggleImportedSkill,
                importableQuery.isError,
              )}
            />
          ))
        ) : (
          <li className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
            {catalog.length > 0 ? '(no skills match)' : <SkillEmptyHint />}
          </li>
        )}
      </ul>
    </>
  )

  // Phones: the bare URL shows the catalog itself; a selected skill shows only its detail.
  const bare = param === null || !selected
  const listInMain = isMobile && bare

  return (
    <>
      <ContextSidebar>
        <SidebarHeader className="gap-3 p-3">{listHeader}</SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="pt-0">
            <SidebarGroupContent data-slot="skills-list">{listRows}</SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </ContextSidebar>

      {listInMain ? (
        <section data-slot="skills-list" aria-label="Skills" className="flex flex-col">
          <div className="flex flex-col gap-3 p-3">{listHeader}</div>
          <div className="px-2 pb-6">{listRows}</div>
        </section>
      ) : null}

      {/* The selected skill. Hidden below md on the bare URL, where the catalog above is the page. */}
      <PageBody
        data-slot="skills-detail"
        className={cn('min-w-0 flex-col pt-6', bare ? 'hidden md:flex' : 'flex')}
      >
        {selected ? (
          <>
            {param !== null ? (
              <Button asChild variant="ghost" size="sm" className="mb-3 self-start md:hidden">
                <Link to="/skills" data-slot="skills-back">
                  <ArrowLeftIcon aria-hidden="true" />
                  Back to skills
                </Link>
              </Button>
            ) : null}
            <SkillDetailBody
              skill={selected}
              enabled={selected.enabled}
              activation={selectedActivation}
              usedBy={skillUsedBy(workflowsQuery.data?.workflows ?? [], selected.name)}
            />
          </>
        ) : skillsQuery.isPending ? null : (
          <CenteredState
            icon={<SparklesIcon />}
            tone="neutral"
            heading="h2"
            title="No skill selected"
            subtitle="Pick a skill from the catalog."
          />
        )}
      </PageBody>
    </>
  )
}

function SkillRow({
  skill,
  active,
  activation,
}: {
  skill: SkillCatalogItem
  active: boolean
  activation?: SkillActivation
}) {
  const project = isProjectSkill(skill)
  const rowClassName = 'flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5'
  const contents = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {/* Enabled skills read bold; inactive importable skills are muted. */}
        <span
          className={cn(
            'min-w-0 truncate font-mono text-[13px]',
            skill.enabled ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
          )}
        >
          {skill.name}
        </span>
        <SkillSourceTag source={skill.source} teamRepo={skill.team?.repo} className="ml-auto" />
      </span>
      {skill.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span> : null}
    </>
  )
  return (
    <li
      className={cn(
        'flex min-w-0 items-start gap-0 rounded-md transition-colors hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent',
      )}
    >
      {activation ? (
        <Switch
          data-slot="skill-activation"
          aria-label={activation.ariaLabel}
          checked={activation.checked}
          disabled={activation.disabled}
          onCheckedChange={activation.onCheckedChange}
          size="sm"
          className="mt-2 ml-2 shrink-0"
        />
      ) : null}
      <Link
        to={`/skills?skill=${encodeURIComponent(skill.name)}`}
        data-slot="skill-row"
        data-skill={skill.name}
        data-project={project ? 'true' : undefined}
        data-enabled={skill.enabled ? 'true' : 'false'}
        aria-current={active ? 'page' : undefined}
        className={rowClassName}
      >
        {contents}
      </Link>
    </li>
  )
}
