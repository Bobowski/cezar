import { GitBranchIcon, TriangleAlertIcon } from 'lucide-react'
import { useParams } from 'react-router'

import { useRepo } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@open-mercato/cezar-api-client'
import { Page } from '@/components/page'
import { useNavigate } from '@/lib/project-router'

import { RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { RepoEmpty } from './repo-empty'
import { RepoFilesSection } from './repo-files'
import { RepoGitLoading } from './repo-git-loading'
import { RepoSidebarHeader, type RepoTab } from './repo-sidebar'
import { RepoSyncBar } from './repo-sync-bar'

/**
 * `/git` — the repo view rebuilt on the task git view's own components (spec §"Session git
 * view — Changes & Files tabs (#390)" last bullet, R5 Step 1.7): the MAIN working tree's
 * structured diff through the same `<Diff>` facade and tree, the recent-commit log with a
 * structured per-commit diff, and the branch list with switch/create + the agents'
 * base-branch picker. Forge-specific rows (PR links, checks) render only when
 * `/api/health` says the forge driver is available.
 *
 * Master–detail: the contextual sidebar holds the section switch and the section's list (the
 * changed-files tree, the commit log, the branches); the main area is the detail only. Each
 * section is a URL (`/git`, `/git/commits[/:sha]`, `/git/branches`, `/git/files[/*path]`), so every
 * surface deep-links and survives a refresh.
 *
 * `files` (#1279) is the one section that is not a view of a diff: the repository's own tree and
 * the file under the cursor.
 */
export type { RepoTab }

export function RepoGitRoute({ tab }: { tab: RepoTab }) {
  const repo = useRepo()

  if (repo.isPending) return <RepoGitLoading />
  if (repo.isError) {
    return (
      <Page data-route="repo-git" width="wide">
        <RepoEmpty
          icon={<TriangleAlertIcon />}
          tone="danger"
          title="Could not load the repository"
          description={repo.error.message}
        />
      </Page>
    )
  }
  const info = repo.data.info
  if (!info) {
    return (
      <Page data-route="repo-git" width="wide">
        <RepoEmpty
          icon={<GitBranchIcon />}
          title="Not a git repository"
          description="The cockpit is running outside a git repository — start it inside one to browse changes, commits and branches."
        />
      </Page>
    )
  }
  return <RepoView repo={repo.data} info={info} tab={tab} />
}

function RepoView({ repo, info, tab }: { repo: RepoResponse; info: RepoInfo; tab: RepoTab }) {
  // Each section renders its own `<ContextSidebar>` (list and detail share state), led by this.
  const header = (extra?: React.ReactNode) => (
    <RepoSidebarHeader info={info} tab={tab}>
      {/* Source-Control strip (spec 2026-10-19-repo-git-sync) beside the header's behind-chip. */}
      <RepoSyncBar />
      {extra}
    </RepoSidebarHeader>
  )
  return (
    <Page data-route="repo-git" width="full">
      {tab === 'changes' ? (
        <RepoChangesSection header={header()} />
      ) : tab === 'commits' ? (
        <RepoCommitsSection log={repo.log} header={header()} />
      ) : tab === 'files' ? (
        <RepoFilesPane header={header()} />
      ) : (
        <RepoBranchesSection repo={repo} info={info} header={header} />
      )}
    </Page>
  )
}

/**
 * The Files segment's URL binding: `/git/files/<path>` IS the file's address, so a selection
 * survives a refresh and can be pasted to a colleague.
 *
 * Selection REPLACES history rather than pushing it — arrow-keying down a folder would otherwise
 * bury the previous tab under twenty selections, and Back should leave the Files tab, not walk
 * backwards through it.
 */
function RepoFilesPane({ header }: { header: React.ReactNode }) {
  const params = useParams()
  const navigate = useNavigate()
  const selected = params['*'] !== undefined && params['*'] !== '' ? params['*'] : null
  return (
    <RepoFilesSection
      header={header}
      selected={selected}
      onSelect={(path) =>
        navigate(path === null ? '/git/files' : `/git/files/${encodePathSegments(path)}`, {
          replace: true,
        })
      }
    />
  )
}

/** Per-SEGMENT encoding, so the slashes stay structural while a `#`, `?` or space in a file name
 *  cannot truncate the URL. React Router decodes the splat on the way back in. */
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
