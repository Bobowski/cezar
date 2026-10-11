import { renderTrackerContext, trackerContextLosses, type CreateRunInput, type TrackerComments, type TrackerItem } from '@open-mercato/cezar-api-client'

import { MAX_CHAIN_STEPS, skillChainSteps } from './github-task'

export const TRACKER_TASK_LIMIT = 100_000

export type TrackerPromptOptions = {
  skills?: readonly string[]
  supplemental?: string
  instruction?: string
}

/** Every way the snapshot handed to the agent is less than the ticket; each needs acknowledging. */
export function trackerLosses(item: TrackerItem, comments: TrackerComments): string[] {
  return trackerContextLosses(item, comments)
}

/**
 * The task a handoff launches: the ticket block — rendered by the contract's one renderer, so it
 * is what a tracker automation attaches too — then the user's own additions, instruction last.
 */
export function trackerTaskPrompt(item: TrackerItem, comments: TrackerComments, options: TrackerPromptOptions = {}): string {
  const parts = [renderTrackerContext(item, comments)]
  if (options.skills?.length) parts.push(`Use these skills where relevant: ${options.skills.join(', ')}.`)
  if (options.supplemental?.trim()) parts.push(`Supplemental context:\n${options.supplemental.trim()}`)
  if (options.instruction?.trim()) parts.push(options.instruction.trim())
  const task = parts.join('\n\n')
  if (task.length > TRACKER_TASK_LIMIT) {
    throw new Error('The final task exceeds the 100,000 character limit. Shorten the supplemental context or instruction.')
  }
  return task
}

export function trackerRunBody(
  item: TrackerItem,
  comments: TrackerComments,
  workflow: string | null,
  skills: readonly string[],
  backend: Pick<CreateRunInput, 'model' | 'runner' | 'agentProfile'>,
  /** `expectedScope` (the association's `trackerReadScope`) makes the server record the ticket link. */
  options: TrackerPromptOptions & { acknowledgeLoss?: boolean; expectedScope?: string },
): CreateRunInput {
  if (!workflow && skills.length > MAX_CHAIN_STEPS) {
    throw new Error(`A skill chain can contain at most ${MAX_CHAIN_STEPS} skills. Remove a skill before launching.`)
  }
  if (trackerLosses(item, comments).length > 0 && !options.acknowledgeLoss) {
    throw new Error('Acknowledge the snapshot limitations before handing this issue to an agent.')
  }
  const task = trackerTaskPrompt(item, comments, {
    ...options,
    skills: workflow ? skills : [],
  })
  const link = options.expectedScope ? { tracker: { itemId: item.id, expectedScope: options.expectedScope } } : {}
  if (workflow) return { ...backend, ...link, workflow, task }
  if (skills.length) return { ...backend, ...link, steps: skillChainSteps(skills), task }
  return { ...backend, ...link, workflow: 'quick-task', task }
}
