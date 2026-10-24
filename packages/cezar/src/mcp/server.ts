import { Server } from '@modelcontextprotocol/server';
import type { Catalog, CatalogTool } from './catalog.ts';
import { callTool, type CallContext } from './execute.ts';
import { readResource, ResourceError, RESOURCE_TEMPLATES, STATIC_RESOURCES } from './resources.ts';

/**
 * One MCP server instance over a tool selection (spec 2026-10-24-cezar-mcp-server §3). The
 * low-level `Server`, not `McpServer`: the schemas are JSON Schema generated from the contract,
 * and a fresh instance is built per HTTP request, so registration must cost nothing.
 */

/**
 * The server's instructions for the tools this connection lists: a pointer to a tool the client
 * cannot call (a `read` token, a narrow `?tools=`) would only send it into a refusal.
 */
export function instructionsFor(names: ReadonlySet<string>): string {
  const lines = [
    'cezar runs coding-agent tasks in git worktrees and stops each at a review gate.',
    'Every tool is one cezar HTTP route. Project tools take an optional projectId (from projects_list;',
    'omit it for the project the cockpit was started in).',
  ];
  const thread = names.has('runs_history') ? ', and read runs_history or the cezar://p/{projectId}/runs/{runId}/thread resource' : '';
  if (names.has('runs_create') && names.has('runs_get')) {
    lines.push(`To start work: runs_create, then poll runs_get until the status is review or done${thread}.`);
    lines.push('Never land, merge or delete unless asked.');
  } else if (names.has('runs_get')) {
    lines.push(`This connection follows tasks: ${names.has('runs_list') ? 'runs_list and ' : ''}runs_get report their status${thread}.`);
  }
  return lines.join('\n');
}

export const PROMPTS = [
  {
    name: 'new-task',
    title: 'New task',
    description: 'Start a cezar task and follow it to review.',
    arguments: [
      { name: 'objective', description: 'What the task should do.', required: true },
      { name: 'projectId', description: 'The project (projects_list); omit for the default one.', required: false },
    ],
    tools: ['projects_list', 'workflows_list', 'runs_create', 'runs_get', 'runs_history', 'runs_changes'],
  },
  {
    name: 'write-workflow',
    title: 'Write a workflow',
    description: 'Draft, check and save a cezar workflow.',
    arguments: [
      { name: 'goal', description: 'What the workflow is for.', required: true },
      { name: 'projectId', description: 'The project (projects_list); omit for the default one.', required: false },
    ],
    tools: ['workflows_list', 'skills_list', 'workflows_nodes', 'workflows_parse', 'workflows_put'],
  },
];

/** The tool names the prompts mention; `catalog.test.ts` checks they exist. */
export const PROMPT_TOOLS = [...new Set(PROMPTS.flatMap((prompt) => prompt.tools))];

/** The prompts whose every tool this connection lists. */
function promptsFor(names: ReadonlySet<string>) {
  return PROMPTS.filter((prompt) => prompt.tools.every((tool) => names.has(tool)));
}

export function promptText(name: string, args: Record<string, string | undefined>): string | null {
  const project = args.projectId ? ` in project ${args.projectId} (pass projectId: "${args.projectId}")` : '';
  switch (name) {
    case 'new-task':
      return [
        `Start a cezar task${project} for this objective:`,
        '',
        args.objective ?? '',
        '',
        'Steps: if the project is unclear, call projects_list. Call workflows_list and pick a workflow',
        '(quick-task when nothing fits). Call runs_create with { task, workflow }. Then poll runs_get every',
        'minute or so until the status is review, done or failed. Report what it did from runs_history (or the',
        'cezar://p/{projectId}/runs/{runId}/thread resource) and runs_changes. Do not land or merge it.',
      ].join('\n');
    case 'write-workflow':
      return [
        `Write a cezar workflow${project} for this goal:`,
        '',
        args.goal ?? '',
        '',
        'Steps: call workflows_list to see the existing ones and skills_list for the skills a step can use;',
        'workflows_nodes lists the node kinds. A workflow is up to eight steps — an agent step has a prompt',
        'or a skill, a check step has a command; {{task}} is the task text. Draft it, check YAML with',
        'workflows_parse, then save it with workflows_put { name, description, steps }. Show the result.',
      ].join('\n');
    default:
      return null;
  }
}

export interface McpServerOptions {
  catalog: Catalog;
  tools: CatalogTool[];
  context: CallContext;
  version: string;
  /** Whether the caller's credential reaches this tool's route; absent = every tool (the owner). */
  allows?: (tool: CatalogTool) => boolean;
}

export function createCezarMcpServer(options: McpServerOptions): Server {
  const { tools, context } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // What is listed, not what may be called: a call still goes to its route, and the guard decides.
  const listed = options.allows ? tools.filter(options.allows) : tools;
  const names = new Set(listed.map((tool) => tool.name));
  const server = new Server(
    { name: 'cezar', title: 'cezar', version: options.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: instructionsFor(names) },
  );

  server.setRequestHandler('tools/list', () => ({
    tools: listed.map((tool) => ({
      name: tool.name,
      title: tool.annotations.title,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as { type: 'object'; [key: string]: unknown } } : {}),
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      // A tool outside the selection is a mistake, not a privilege boundary: the guard decides that.
      const known = options.catalog.byName.get(request.params.name);
      const text = known
        ? `${request.params.name} is in the "${known.set}" tool set, which this connection did not ask for (add it with ?tools= or --tools).`
        : `unknown tool: ${request.params.name}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
    const result = await callTool(tool, (request.params.arguments ?? {}) as Record<string, unknown>, context);
    return server.projectCallToolResult(result as never, tool.outputSchema);
  });

  server.setRequestHandler('resources/list', () => ({ resources: STATIC_RESOURCES }));
  server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
  server.setRequestHandler('resources/read', async (request) => {
    try {
      return { contents: [await readResource(context, request.params.uri)] };
    } catch (error) {
      if (error instanceof ResourceError) throw new Error(error.message);
      throw error;
    }
  });

  const prompts = promptsFor(names);
  server.setRequestHandler('prompts/list', () => ({ prompts: prompts.map(({ tools: _tools, ...prompt }) => prompt) }));
  server.setRequestHandler('prompts/get', (request) => {
    const prompt = prompts.find((entry) => entry.name === request.params.name);
    const text = prompt ? promptText(prompt.name, (request.params.arguments ?? {}) as Record<string, string | undefined>) : null;
    if (!prompt || text === null) throw new Error(`unknown prompt: ${request.params.name}`);
    return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
  });

  return server;
}
