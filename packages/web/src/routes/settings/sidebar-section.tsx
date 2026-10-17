import { useMutation, useQueryClient } from '@tanstack/react-query'

import { putUiState } from '@/api/client'
import { queryKeys, useHealth, useProjects, useUiState } from '@/api/queries'
import type { UiState } from '@open-mercato/cezar-api-client'
import { NAV_ITEMS, PINNED_NAV, type NavItem } from '@/components/nav-items'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { useActiveProjectId } from '@/lib/project-router'
import { TRACKER_PROVIDERS } from '@/lib/tracker-providers'
import { SettingsError, SettingsField, SettingsGroup, SettingsLoading, SettingsPane } from './settings-field'

/**
 * Project settings → Sidebar: which pages this project lists. Stored as the HIDDEN set
 * (`uiState.hiddenNav`), so a page added later shows up by default. A gated page the server
 * cannot back is still listed here — marked "not connected" — so the switch is honest about
 * why it would not appear even when on.
 */
export function SidebarSection() {
  const uiState = useUiState()
  const health = useHealth()
  const projects = useProjects()
  const projectId = useActiveProjectId()
  const queryClient = useQueryClient()
  const key = queryKeys.uiState

  const save = useMutation({
    mutationFn: (hiddenNav: string[]) => putUiState({ hiddenNav }),
    onMutate: (hiddenNav) => {
      const previous = queryClient.getQueryData<UiState>(key)
      queryClient.setQueryData<UiState>(key, (prev) => ({ ...prev, hiddenNav }))
      return { previous }
    },
    onError: (error: Error, _next, context) => {
      queryClient.setQueryData(key, context?.previous)
      toast(error.message, { tone: 'danger' })
    },
    onSuccess: (result) => queryClient.setQueryData(key, result),
  })

  if (uiState.isPending) return <SettingsLoading data-slot="sidebar-loading" label="Loading sidebar settings…" />
  if (uiState.isError) return <SettingsError title="Sidebar settings did not load">{uiState.error.message}</SettingsError>

  const hidden = uiState.data.hiddenNav ?? []
  const project = projects.data?.projects.find((entry) => entry.id === projectId)
  const capabilities = health.data?.capabilities

  /** Why a gated page would not show even when switched on; null when nothing is missing. */
  const missing = (item: NavItem): string | null => {
    if (item.forge && project?.forge !== 'github') return 'GitHub not connected'
    if (item.tracker && project?.tracker === undefined) return 'No tracker connected'
    if (item.inbox && capabilities?.followups !== true) return 'Off (CEZ_FOLLOWUPS)'
    if (item.automations && capabilities?.automations !== true) return 'Off (CEZ_AUTOMATIONS)'
    return null
  }

  const toggle = (to: string, visible: boolean) =>
    save.mutate(visible ? hidden.filter((entry) => entry !== to) : [...hidden, to])

  return (
    <SettingsPane data-slot="sidebar-section">
      <SettingsGroup title="Pages" description="Choose which pages this project shows in the sidebar.">
        {NAV_ITEMS.filter((item) => !PINNED_NAV.has(item.to)).map((item) => {
          const Icon = item.icon
          const reason = missing(item)
          const id = `nav-visible-${item.to.slice(1)}`
          const label = item.tracker && project?.tracker ? TRACKER_PROVIDERS[project.tracker].label : item.label
          return (
            <SettingsField
              key={item.to}
              htmlFor={id}
              title={
                <span className="inline-flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  {label}
                  {reason ? <Badge variant="outline" className="font-normal text-muted-foreground">{reason}</Badge> : null}
                </span>
              }
              control={
                <Switch
                  id={id}
                  checked={!hidden.includes(item.to)}
                  onCheckedChange={(checked) => toggle(item.to, checked)}
                />
              }
            />
          )
        })}
      </SettingsGroup>
    </SettingsPane>
  )
}
