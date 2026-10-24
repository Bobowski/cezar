import { stringify } from 'yaml';
import { isSafeSegment, type CallContext } from './execute.ts';

/**
 * The read-often shapes an agent browses rather than calls (spec 2026-10-24-cezar-mcp-server
 * §3): the project list, a task's thread as Markdown, a workflow as YAML. Each is a GET through
 * the cockpit with the caller's credential, like a tool.
 */

export const STATIC_RESOURCES = [
  {
    uri: 'cezar://projects',
    name: 'projects',
    title: 'Projects',
    description: 'Every project this cockpit serves, with its id (the projectId every tool takes).',
    mimeType: 'application/json',
  },
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'cezar://p/{projectId}/runs/{runId}/thread',
    name: 'task-thread',
    title: 'Task thread',
    description: 'A task\'s conversation and steps as Markdown, oldest first.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'cezar://p/{projectId}/workflows/{name}',
    name: 'workflow',
    title: 'Workflow',
    description: 'One workflow of a project, as YAML.',
    mimeType: 'application/yaml',
  },
];

/** A thread longer than this many history pages is cut at its oldest end. */
const MAX_PAGES = 20;

export class ResourceError extends Error {}

async function getJson(context: CallContext, path: string): Promise<unknown> {
  const headers = new Headers(context.headers);
  headers.set('accept', 'application/json');
  const response = await context.dispatch(new Request(new URL(`/api/v1${path}`, context.origin), { headers }));
  const text = await response.text();
  if (!response.ok) throw new ResourceError(`${response.status} ${text}`);
  return JSON.parse(text) as unknown;
}

type Event = { type?: string; seq?: number; [key: string]: unknown };

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One transcript event as Markdown, or null for the ones a reader does not need. */
export function eventMarkdown(event: Event): string | null {
  switch (event.type) {
    case 'user-message':
      return `**You:** ${str(event.text)}`;
    case 'text':
      return str(event.text) || null;
    case 'step-start':
      return `## ${str(event.name) || str(event.stepId) || 'Step'}`;
    case 'tool-call':
      return `- \`${str(event.tool)}\``;
    case 'error':
      return `> **Error:** ${str(event.message)}`;
    case 'note':
      return `> ${str(event.message)}`;
    default:
      return null;
  }
}

export async function threadMarkdown(context: CallContext, projectId: string, runId: string): Promise<string> {
  const base = `/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
  const run = (await getJson(context, base)) as { title?: string; status?: string; branch?: string };
  const pages: Event[][] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const page = (await getJson(context, `${base}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)) as {
      events: Event[];
      hasOlder: boolean;
      olderCursor?: string;
    };
    pages.unshift(page.events);
    if (!page.hasOlder || !page.olderCursor) break;
    cursor = page.olderCursor;
    if (index === MAX_PAGES - 1) truncated = true;
  }
  const lines = [
    `# ${run.title ?? runId}`,
    '',
    `Status: ${run.status ?? 'unknown'}${run.branch ? ` · branch \`${run.branch}\`` : ''}`,
    '',
    ...(truncated ? ['_(older history cut)_', ''] : []),
  ];
  for (const event of pages.flat().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    const line = eventMarkdown(event);
    if (line !== null) lines.push(line, '');
  }
  return lines.join('\n');
}

export async function workflowYaml(context: CallContext, projectId: string, name: string): Promise<string> {
  const listing = (await getJson(context, `/p/${encodeURIComponent(projectId)}/workflows`)) as {
    workflows: Array<{ name: string; description?: string; steps: unknown; graph?: unknown; source: string }>;
  };
  const workflow = listing.workflows.find((entry) => entry.name === name);
  if (!workflow) throw new ResourceError(`no workflow named ${name}`);
  const { source: _source, ...definition } = workflow;
  return stringify(definition);
}

/** A URI segment as the id it names; one that could leave its route segment is a ResourceError. */
function segment(raw: string, uri: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw new ResourceError(`invalid resource: ${uri}`);
  }
  if (value === '' || !isSafeSegment(value)) throw new ResourceError(`invalid resource: ${uri}`);
  return value;
}

/** `cezar://…` → its contents; a URI that names nothing is a ResourceError. */
export async function readResource(context: CallContext, uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
  if (uri === 'cezar://projects') {
    return { uri, mimeType: 'application/json', text: JSON.stringify(await getJson(context, '/projects'), null, 2) };
  }
  const thread = /^cezar:\/\/p\/([^/]+)\/runs\/([^/]+)\/thread$/.exec(uri);
  if (thread) {
    return { uri, mimeType: 'text/markdown', text: await threadMarkdown(context, segment(thread[1]!, uri), segment(thread[2]!, uri)) };
  }
  const workflow = /^cezar:\/\/p\/([^/]+)\/workflows\/([^/]+)$/.exec(uri);
  if (workflow) {
    return { uri, mimeType: 'application/yaml', text: await workflowYaml(context, segment(workflow[1]!, uri), segment(workflow[2]!, uri)) };
  }
  throw new ResourceError(`unknown resource: ${uri}`);
}
