import { useMemo } from 'react'

import { useProjects } from '@/api/queries'
import { useActiveProjectId } from '@/lib/project-router'
import type { ApiRun } from '@open-mercato/cezar-api-client'

/**
 * The directories a picked element's source path may be reported relative to (spec
 * `2026-10-24-design-mode-third-cut` §3.3): the task's worktree first, then the project
 * checkout. A path under neither is not shown and not sent.
 */
export function useSourceRoots(run?: Pick<ApiRun, 'worktreePath'> | null): readonly string[] {
  const projects = useProjects()
  const active = useActiveProjectId()
  const id = active ?? projects.data?.bootProject
  const root = projects.data?.projects?.find((project) => project.id === id)?.root
  const worktree = run?.worktreePath
  return useMemo(() => [worktree, root].filter((each): each is string => typeof each === 'string' && each !== ''), [root, worktree])
}
