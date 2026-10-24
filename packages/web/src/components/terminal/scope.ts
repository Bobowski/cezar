import type { DiscoveredCommandsResponse, ProjectDetectedUrlsResponse } from '@open-mercato/cezar-api-client'

import { getRunTerminalCommands, getRunTerminalUrls } from '@/api/client'
import { getProjectTerminalCommands, getProjectTerminalUrls } from '@/api/code'

/**
 * Whose terminals a strip speaks for (spec `.ai/specs/2026-10-24-code-page-terminal.md` §3.1): a
 * task's, in its worktree, or the project's own, in the main checkout.
 */
export type TerminalScope = { kind: 'run'; runId: string } | { kind: 'project' }

export const scopeKey = (scope: TerminalScope): string => (scope.kind === 'run' ? `run:${scope.runId}` : 'project')

export function terminalUrls(scope: TerminalScope): Promise<ProjectDetectedUrlsResponse> {
  return scope.kind === 'run' ? getRunTerminalUrls(scope.runId) : getProjectTerminalUrls()
}

export function terminalCommands(scope: TerminalScope): Promise<DiscoveredCommandsResponse> {
  return scope.kind === 'run' ? getRunTerminalCommands(scope.runId) : getProjectTerminalCommands()
}
