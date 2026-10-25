import type { PrivateMcpServer } from '../core/private-mcp.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { WorkflowDef } from '../workflows/types.ts';

/**
 * The cockpit chat (spec 2026-10-24-cockpit-chat): an ordinary run with `kind: 'chat'`, in the
 * checkout, that knows cezar and drives it through cezar's own MCP server. This module is what a
 * chat has that a task does not — its workflow, prompt, tools and MCP entry; the engine reads them
 * through `isChatRun` at both `ActiveRun` construction sites.
 */

/** The MCP server's name in every backend's config, and so `mcp__cezar` in Claude's allow rules. */
export const CHAT_MCP_SERVER = 'cezar';

/** A chat is one conversation: one agent step on the user's first message. */
export const CHAT_WORKFLOW: WorkflowDef = {
  name: 'chat',
  description: 'The project chat: ask cezar about this project, or have it set things up.',
  source: 'built-in',
  steps: [{ id: 'chat', name: 'Chat', prompt: '{{task}}' }],
};

/**
 * What a chat may touch where the backend honours `allowedTools` (Claude): read the repository,
 * write only under `.ai/cezar/`, call cezar's MCP (added by the runner). No Bash — a shell would
 * write anywhere. Codex/OpenCode/Cursor ignore this list (#430); the prompt says the same thing.
 */
export const CHAT_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'Edit(.ai/cezar/**)', 'Write(.ai/cezar/**)', 'MultiEdit(.ai/cezar/**)',
];

export function isChatRun(run: Pick<RunRecord, 'kind'> | undefined): boolean {
  return run?.kind === 'chat';
}

export function chatCreatedBy(chatRunId: string): string {
  return `chat:${chatRunId}`;
}

/** The chat a `createdBy` names, or undefined. */
export function chatIdOf(createdBy: string | undefined): string | undefined {
  return createdBy?.startsWith('chat:') ? createdBy.slice(5) : undefined;
}

/**
 * The spec's `builtin/cezar-chat.md`. A TS module rather than a Markdown file because `tsc`
 * ships only what it compiles, and a prompt that is missing from the tarball is a chat that
 * silently forgot what it is.
 */
export function cezarChatPrompt(options: { projectId?: string; mcp: boolean }): string {
  const project = options.projectId ? ` Its projectId is "${options.projectId}"; every project tool defaults to it.` : '';
  return [
    '## You are the cezar chat for this project',
    '',
    'cezar is the local cockpit that runs coding-agent tasks on this repository: each task runs a workflow (a chain of agent and check steps) in its own git worktree, or in the checkout, and stops for the user\'s review.',
    `You are not a task. You are the project's chat: the user asks you about cezar and this project, and asks you to set cezar up — workflows, skills, automations, personas, and new tasks.${project}`,
    '',
    options.mcp
      ? 'Your tools for cezar are the `cezar` MCP server: one tool per cockpit route — runs_list, runs_get, runs_create, runs_history, workflows_list, workflows_parse, workflows_put, skills_list, automations_list, automations_create, repo_changes and the rest. Every action you take through it is something the user could do in the cockpit; prefer it to editing cezar\'s files by hand.'
      : 'cezar\'s MCP server is not attached to this session (the backend has no launch-time MCP channel, or the cockpit gave no address). Say so when the user asks for something only it can do; you can still read the repository and write under .ai/cezar/.',
    '',
    'Rules:',
    '- Application code is out of bounds. To change anything outside .ai/cezar/, create a task (runs_create, with the workflow that fits — quick-task when nothing else does) and tell the user it exists. Never edit, create, move or delete a file outside .ai/cezar/ yourself, even where your tools would let you, and never run a shell command that writes.',
    '- You may write under .ai/cezar/ directly: workflows (.ai/cezar/workflows/*.yaml), skills (.ai/cezar/skills/), automations and personas. Validate a workflow with workflows_parse before you save it. The user commits or reverts those files from the chat\'s Changes panel; do not commit, branch or push.',
    '- You cannot open pull requests, push, change Settings or read secrets; do not try to work around a refusal — report it.',
    '- Tasks you start are linked to this chat, and their status changes appear here as notes. Use runs_get or runs_history to answer questions about them.',
    '- This conversation stays open between messages: end every answer plainly. Never end a message with CEZ:DONE.',
  ].join('\n');
}

/**
 * cezar's own MCP server for a chat session (spec §3): the stdio bridge `cezar mcp --tools all
 * --as-run`, authenticated with the chat's run token. Undefined without an address or an
 * entrypoint (a headless `cezar run`): there is no cockpit for it to reach.
 */
export function chatMcpServer(input: {
  runId: string;
  projectId?: string;
  token: string;
  apiUrl: string | undefined;
  bin: string | undefined;
  node: string;
}): PrivateMcpServer | undefined {
  if (!input.apiUrl || !input.bin) return undefined;
  return {
    name: CHAT_MCP_SERVER,
    transport: 'stdio',
    command: input.node,
    args: [input.bin, 'mcp', '--tools', 'all', '--as-run'],
    env: {
      CEZ_API_URL: input.apiUrl,
      CEZ_API_TOKEN: input.token,
      CEZ_TASK_ID: input.runId,
      ...(input.projectId ? { CEZ_PROJECT_ID: input.projectId } : {}),
    },
    headers: {},
  };
}

/** The note a chat gets when a task it started changes status; null for a change worth no note. */
export function chatStatusNote(task: Pick<RunRecord, 'id' | 'title' | 'titleSummary' | 'status'>): string | null {
  const name = `task ${task.id.slice(0, 8)} "${task.titleSummary ?? task.title}"`;
  switch (task.status) {
    case 'waiting': return `${name} is waiting for the user`;
    case 'review': return `${name} reached review`;
    case 'done': return `${name} finished`;
    case 'failed': return `${name} failed`;
    case 'cancelled': return `${name} was cancelled`;
    default: return null;
  }
}

/**
 * Status notes from a chat's tasks into the chat's own thread (spec §3: "task ffp-612 reached
 * review"). The store is the bus; the first sighting of a task after boot is its baseline, so a
 * restart replays nothing. Answers the unsubscribe.
 */
export function relayChatStatusNotes(store: RunStore): () => void {
  const seen = new Map<string, RunRecord['status']>();
  const onRun = (run: RunRecord) => {
    const chatId = chatIdOf(run.createdBy);
    if (!chatId) return;
    const before = seen.get(run.id);
    seen.set(run.id, run.status);
    if (before === undefined || before === run.status) return;
    const note = chatStatusNote(run);
    if (!note || !store.getRun(chatId)) return;
    store.appendEvent(chatId, { type: 'note', message: note, taskId: run.id });
  };
  const onDeleted = (id: string) => seen.delete(id);
  store.on('run', onRun);
  store.on('deleted', onDeleted);
  return () => {
    store.off('run', onRun);
    store.off('deleted', onDeleted);
  };
}
