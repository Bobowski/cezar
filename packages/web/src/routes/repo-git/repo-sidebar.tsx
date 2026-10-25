import {
  FileDiffIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitGraphIcon,
  PanelLeftIcon,
  type LucideIcon,
} from 'lucide-react'
import { useContext, type ReactNode } from 'react'

import type { RepoInfo } from '@open-mercato/cezar-api-client'
import { ContextSidebar, ContextSidebarContext } from '@/components/context-sidebar'
import { RepoSyncChip } from '@/components/repo-sync-chip'
import { Button } from '@/components/ui/button'
import { SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Link } from '@/lib/project-router'

import { BranchChip } from '../task-git/diff-controls'
import { useRepoSidebarFrame } from './repo-sidebar-frame'

export type RepoTab = 'changes' | 'graph' | 'commits' | 'branches' | 'files'

const TABS: { value: RepoTab; to: string; label: string; icon: LucideIcon }[] = [
  { value: 'changes', to: '/git', label: 'Changes', icon: FileDiffIcon },
  { value: 'graph', to: '/git/graph', label: 'Graph', icon: GitGraphIcon },
  { value: 'commits', to: '/git/commits', label: 'Commits', icon: GitCommitHorizontalIcon },
  { value: 'branches', to: '/git/branches', label: 'Branches', icon: GitBranchIcon },
  { value: 'files', to: '/git/files', label: 'Files', icon: FolderTreeIcon },
]

/** The query with one key set (or removed, for null) and every other key kept — a selection in
 *  one Git section must not drop another's (`?compare=`). */
export function withParam(params: URLSearchParams, key: string, value: string | null): URLSearchParams {
  const next = new URLSearchParams(params)
  if (value === null) next.delete(key)
  else next.set(key, value)
  return next
}

/**
 * Every Git section's `<ContextSidebar>`: the shell's column on the Git page's own frame, its
 * body hidden while folded to icons, and the section switch as icons in its place.
 */
export function RepoContextSidebar({ tab, children }: { tab: RepoTab; children: ReactNode }) {
  const frame = useRepoSidebarFrame()
  return (
    <ContextSidebar frame={frame}>
      <RepoIconRail tab={tab} />
      <div data-slot="repo-sidebar-body" className="contents group-data-[collapsible=icon]:hidden">
        {children}
      </div>
    </ContextSidebar>
  )
}

/** The section switch while the column is folded: one icon per section, the current one marked. */
function RepoIconRail({ tab }: { tab: RepoTab }) {
  return (
    <SidebarMenu data-slot="repo-icon-rail" className="hidden items-center gap-1 p-2 group-data-[collapsible=icon]:flex">
      {TABS.map((entry) => {
        const Icon = entry.icon
        return (
          <SidebarMenuItem key={entry.value}>
            <SidebarMenuButton asChild isActive={tab === entry.value} tooltip={entry.label}>
              <Link to={entry.to} aria-label={entry.label} aria-current={tab === entry.value ? 'page' : undefined}>
                <Icon aria-hidden="true" />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

/**
 * The Git screen's sidebar header: the title, the checked-out branch, and the
 * Changes | Commits | Branches | Files switch. Each item is a link, so every section stays a URL
 * (`/git`, `/git/commits[/:sha]`, `/git/branches`, `/git/files[/*path]`). `children` is the section's own filter row.
 */
export function RepoSidebarHeader({ info, tab, children }: { info?: RepoInfo; tab: RepoTab; children?: ReactNode }) {
  return (
    <SidebarHeader data-slot="repo-header" className="gap-3 p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="px-1 text-[15px] font-semibold text-foreground">Git</h2>
        {info ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <RepoSyncChip />
            <BranchChip branch={info.branch} />
          </span>
        ) : null}
      </div>
      {info?.remote ? (
        <p data-slot="repo-remote" title={info.remote} className="-mt-1.5 truncate px-1 text-xs text-muted-foreground">
          {info.remote}
        </p>
      ) : null}
      <Tabs value={tab}>
        <TabsList data-slot="repo-tabs" className="w-full">
          {TABS.map((entry) => (
            // Five sections in a 264px column: the default trigger padding clipped the outer ones.
            <TabsTrigger key={entry.value} value={entry.value} asChild className="min-w-0 px-1 text-xs">
              <Link to={entry.to} aria-current={tab === entry.value ? 'page' : undefined}>
                {entry.label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </SidebarHeader>
  )
}

/** Closes the phone sheet after a pick that is not a navigation (a file, a branch). Call only
 *  from inside `<ContextSidebar>`, which renders only under the shell's sidebar provider. */
export function useCloseSidebarSheet(): () => void {
  const { isMobile, setOpenMobile } = useSidebar()
  return () => {
    if (isMobile) setOpenMobile(false)
  }
}

/**
 * "Open the list" for a main area with nothing selected: the sheet on a phone, the collapsed
 * column on desktop. Renders nothing outside the shell, and nothing while the list is on screen.
 */
export function OpenSidebarButton({ children }: { children: ReactNode }) {
  return useContext(ContextSidebarContext) ? <OpenSidebarButtonInner>{children}</OpenSidebarButtonInner> : null
}

function OpenSidebarButtonInner({ children }: { children: ReactNode }) {
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar()
  if (!isMobile && open) return null
  return (
    <Button variant="outline" size="sm" onClick={() => (isMobile ? setOpenMobile(true) : setOpen(true))}>
      <PanelLeftIcon aria-hidden="true" />
      {children}
    </Button>
  )
}
