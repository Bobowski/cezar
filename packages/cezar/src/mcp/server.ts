import { Server } from '@modelcontextprotocol/server';
import type { Catalog, CatalogTool } from './catalog.ts';
import { callTool, type CallContext } from './execute.ts';
import { readResource, ResourceError, RESOURCE_TEMPLATES, STATIC_RESOURCES } from './resources.ts';

/**
 * One MCP server instance over a tool selection (spec 2026-10-24-cezar-mcp-server §3). The
 * low-level `Server`, not `McpServer`: the schemas are JSON Schema generated from the contract,
 * and a fresh instance is built per HTTP request, so registration must cost nothing.
 */

const INSTRUCTIONS = `cezar runs coding-agent tasks in git worktrees and stops each at a review gate.
Every tool is one cezar HTTP route. Project tools take an optional projectId (from projects_list;
omit it for the project the cockpit was started in). To start work: runs_create, then poll
runs_get until the status is review or done, and read runs_history or the
cezar://p/{projectId}/runs/{runId}/thread resource. Never land, merge or delete unless asked.`;

export const PROMPTS = [
  {
    name: 'new-task',
    title: 'New task',
    description: 'Start a cezar task and follow it to review.',
    arguments: [
      { name: 'objective', description: 'What the task should do.', required: true },
      { name: 'projectId', description: 'The project (projects_list); omit for the default one.', required: false },
    ],
  },
  {
    name: 'write-workflow',
    title: 'Write a workflow',
    description: 'Draft, check and save a cezar workflow.',
    arguments: [
      { name: 'goal', description: 'What the workflow is for.', required: true },
      { name: 'projectId', description: 'The project (projects_list); omit for the default one.', required: false },
    ],
  },
];

/** The tool names the prompts mention; `catalog.test.ts` checks they exist. */
export const PROMPT_TOOLS = ['projects_list', 'workflows_list', 'runs_create', 'runs_get', 'runs_history', 'runs_changes', 'skills_list', 'workflows_nodes', 'workflows_parse', 'workflows_put'];

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
}

export function createCezarMcpServer(options: McpServerOptions): Server {
  const { tools, context } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: 'cezar', title: 'cezar', version: options.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler('tools/list', () => ({
    tools: tools.map((tool) => ({
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

  server.setRequestHandler('prompts/list', () => ({ prompts: PROMPTS }));
  server.setRequestHandler('prompts/get', (request) => {
    const text = promptText(request.params.name, (request.params.arguments ?? {}) as Record<string, string | undefined>);
    if (text === null) throw new Error(`unknown prompt: ${request.params.name}`);
    const prompt = PROMPTS.find((entry) => entry.name === request.params.name)!;
    return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
  });

  return server;
}
