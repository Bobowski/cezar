import type { PrivateMcpServer } from '../core/private-mcp.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { DATA_GITIGNORE_ENTRIES } from '../data-gitignore.ts';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cezarHomeDir } from '../paths.ts';
import { CHAT_PROPOSALS_DIR, CHAT_WRITABLE, chatMayWrite, chatProposalRoot } from '@open-mercato/cezar-contract';

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

// The list is the contract's, so the cockpit's Changes panel shows exactly what the chat may propose.
export { CHAT_WRITABLE, chatMayWrite };

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const;
/** Whole tools a chat never has, whatever a repo's own settings allow: a shell or a sub-agent writes
 *  anywhere, and the network is how a prompt injection would leave with what the chat read. */
const CHAT_DENIED_WHOLE_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'] as const;
const ruleOf = (path: string) => (path.endsWith('/') ? `${path}**` : path);
/** Writes that would run code on the owner's next session — agent settings and hooks, MCP config,
 *  agent instructions, CI, git hooks, npm scripts — denied whether or not the checkout has them yet. */
const CHAT_UNWRITABLE = [
  './.claude/**', '**/.claude/**', './.mcp.json', '**/CLAUDE.md', '**/AGENTS.md', './.github/**',
  '**/.envrc', './.husky/**', '**/package.json',
] as const;

/** Secrets a chat's file tools never read, wherever they sit: env files, cezar's per-user home, the
 *  agent's own settings (hooks, allow rules), SSH keys and tool credentials. `.ai/cezar/` beyond its
 *  five paths is added per tree, the resolved `CEZ_HOME` per launch. */
const CHAT_UNREADABLE = [
  './.env*', '**/.env*', '~/.cezar/**', './.claude/**', '**/.claude/**', '~/.claude/**', '~/.ssh/**', '~/.config/**',
] as const;

/** An absolute path as a Claude permission rule (`//` = filesystem root; Windows `C:\x` is `/c/x`). */
function absoluteRule(path: string): string {
  const posix = resolve(path).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
  return `/${posix.replace(/\/+$/, '')}/**`;
}

/** What a chat's tool policy is built from: the entries beside the path to its proposals. */
export interface ChatTreeListing {
  /** Top-level entries of the checkout, directories with a trailing `/`. */
  repo: readonly string[];
  /** Entries of `.ai/`, of `.ai/cezar/` and of `.ai/cezar/proposals/`, the same way. */
  ai: readonly string[];
  cezar: readonly string[];
  proposals: readonly string[];
}

/** Read a checkout's listing for {@link chatToolPolicy}; a missing directory lists nothing. */
export function listChatTree(repoRoot: string): ChatTreeListing {
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    } catch {
      return [];
    }
  };
  return {
    repo: list(repoRoot),
    ai: list(join(repoRoot, '.ai')),
    cezar: list(join(repoRoot, '.ai/cezar')),
    proposals: list(join(repoRoot, '.ai/cezar/proposals')),
  };
}

/**
 * A chat's tool policy where the backend honours it (Claude). It reads the repository and writes
 * only its own proposals (spec 2026-10-24-cockpit-chat §3, §5): `allowedTools` grants the mirror of
 * {@link CHAT_WRITABLE} under `.ai/cezar/proposals/<id>/`, and because a repo's own
 * `.claude/settings.json` may allow more and deny rules beat every allow rule, `disallowedTools`
 * names the whole tools above and EVERY sibling on the path to the proposals — the checkout's
 * top-level entries, `.ai/`'s, `.ai/cezar/`'s (the live configuration included) and other chats'
 * proposals. Codex/OpenCode/Cursor ignore both lists (#430); the prompt says the same thing.
 */
export function chatToolPolicy(chatId: string, tree: ChatTreeListing): {
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: 'dontAsk';
  settings: Record<string, unknown>;
} {
  const root = chatProposalRoot(chatId);
  // Reads are scoped to the checkout (`./` = the session's cwd): under `dontAsk` a read no allow
  // rule names is refused. Claude applies Read rules to Grep and Glob, so `Read(./**)` is the rule
  // that binds; the Grep/Glob spellings only keep a bare whole-tool allow from coming back.
  const allowedTools = [
    'Read(./**)', 'Grep(./**)', 'Glob(./**)',
    ...WRITE_TOOLS.flatMap((tool) =>
      CHAT_WRITABLE.map((path) => `${tool}(${ruleOf(`${root}${path.slice('.ai/cezar/'.length)}`)})`)),
  ];
  // `./` anchors a top-level name: a bare `src` would also match `.ai/cezar/proposals/<id>/skills/src`.
  const anchored = (prefix: string, entries: readonly string[], keep: string) =>
    entries.filter((entry) => entry !== keep).map((entry) => (prefix ? `${prefix}${ruleOf(entry)}` : `./${ruleOf(entry)}`));
  const writable = CHAT_WRITABLE.map((path) => path.slice('.ai/cezar/'.length));
  const known = ['config.json', '.gitignore', ...DATA_GITIGNORE_ENTRIES, ...writable];
  // Everything in `.ai/cezar/` but its five paths and the proposals: config, run state, worktrees.
  const deniedReads = [
    ...CHAT_UNREADABLE,
    absoluteRule(cezarHomeDir()),
    ...anchored('.ai/cezar/', [...new Set([...known, ...tree.cezar])].filter((entry) => !writable.includes(entry)), 'proposals/'),
  ];
  const deniedWrites = [...new Set([
    ...CHAT_UNWRITABLE,
    ...anchored('', tree.repo, '.ai/'),
    ...anchored('.ai/', tree.ai, 'cezar/'),
    ...anchored('.ai/cezar/', [...new Set([...known, ...tree.cezar])], 'proposals/'),
    ...anchored(CHAT_PROPOSALS_DIR, tree.proposals, `${chatId}/`),
  ])];
  return {
    allowedTools,
    disallowedTools: [
      ...CHAT_DENIED_WHOLE_TOOLS,
      ...WRITE_TOOLS.flatMap((tool) => deniedWrites.map((path) => `${tool}(${path})`)),
      ...deniedReads.map((path) => `Read(${path})`),
    ],
    // `dontAsk` whatever `CEZ_APPROVAL_GATE` says: `acceptEdits` would let an edit through that no
    // allow rule names. The settings add no allow rule of their own; the deny rules above win anyway.
    permissionMode: 'dontAsk',
    settings: { permissions: { allow: [], defaultMode: 'dontAsk' } },
  };
}

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
export function cezarChatPrompt(options: { chatId: string; projectId?: string; mcp: boolean }): string {
  const proposals = chatProposalRoot(options.chatId);
  const project = options.projectId ? ` Its projectId is "${options.projectId}"; every project tool defaults to it.` : '';
  return [
    '## You are the cezar chat for this project',
    '',
    'cezar is the local cockpit that runs coding-agent tasks on this repository: each task runs a workflow (a chain of agent and check steps) in its own git worktree, or in the checkout, and stops for the user\'s review.',
    `You are not a task. You are the project's chat: the user asks you about cezar and this project, and asks you to set cezar up — workflows, skills, automations, personas, and new tasks.${project}`,
    '',
    options.mcp
      ? 'Your tools for cezar are the `cezar` MCP server: one tool per cockpit route — runs_list, runs_get, runs_create, runs_history, workflows_list, workflows_parse, workflows_put, skills_list, automations_list, automations_create, repo_changes and the rest. Every action you take through it is something the user could do in the cockpit; prefer it to editing cezar\'s files by hand.'
      : 'cezar\'s MCP server is not attached to this session (the backend has no launch-time MCP channel, or the cockpit gave no address). Say so when the user asks for something only it can do; you can still read the repository and write the cezar files listed below.',
    '',
    'Rules:',
    `- Everything you write is a PROPOSAL. Write cezar configuration under ${proposals} only, mirroring .ai/cezar/: ${CHAT_WRITABLE.map((path) => path.replace('.ai/cezar/', proposals)).join(', ')} — for ${CHAT_WRITABLE.join(', ')}. Nothing loads a proposal: the user reviews it in the chat's Changes panel and applies (and commits) it or discards it. workflows_put and automations_create save proposals too. Validate a workflow with workflows_parse before you save it. Do not commit, branch or push.`,
    '- A proposed workflow cannot run until the user applies it: runs_create takes only a workflow that is live now (workflows_list), never inline steps. An automation you propose is always paused; only the user switches one on, and you cannot edit, run or pause a live one.',
    '- Everything else is out of bounds: application code, the live .ai/cezar/ files and the rest of .ai/cezar/ (config.json, config.local.json, mcp.local.json, runs.json, run events, worktrees). To change application code, create a task (runs_create, with the workflow that fits — quick-task when nothing else does) and tell the user it exists. Never edit, create, move or delete any other file yourself, even where your tools would let you, and never run a shell command.',
    `- You cannot open pull requests, push, change Settings or read secrets: an env file's values, the secret store and the tracker's credentials are refused to you (the env-file listing shows paths and variable names only), and you must not open .env files or other credentials with your file tools either. Do not try to work around a refusal — report it.`,
    '- The cezar MCP server is your only way to cezar: never call the cockpit\'s HTTP API yourself (curl, fetch, a script, the cez CLI), even if you find its address. On a local cockpit without sign-in such a call would act as the owner, and these rules are the only thing that stops it.',
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
