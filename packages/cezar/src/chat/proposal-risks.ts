import { parse as parseYaml } from 'yaml';
import type { ChatProposalRisk } from '@open-mercato/cezar-contract';

/**
 * What Apply's confirm names (spec 2026-10-24-cockpit-chat §3), read from the PARSED proposal as
 * it would be applied — never from diff lines, which miss a quoted key, a `command: |` block edited
 * in place and everything past the diff cap. Walks the whole document rather than one schema, so a
 * file the loader would reject, or a shape added later, still shows what it holds.
 */

const NODE_RISKS: Record<string, ChatProposalRisk['kind']> = {
  'git.push': 'push',
  'github.draft-pr': 'pull-request',
  'github.pr-update': 'pull-request',
  'github.pr-comment': 'comment',
  'github.issue-comment': 'comment',
  'notify.webhook': 'webhook',
};
const PERSONA_KEYS = ['runner', 'model', 'allowedTools', 'disallowedTools', 'bashAllowlist', 'tools', 'permissionMode'] as const;

type Doc = Record<string, unknown>;
const isDoc = (value: unknown): value is Doc => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const shown = (value: unknown) => (Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : JSON.stringify(value));

export function proposalRisks(path: string, applied: string, live: string | undefined): ChatProposalRisk[] {
  if (path.startsWith('.ai/cezar/workflows/')) return workflowRisks(applied);
  if (path.startsWith('.ai/cezar/agents/')) return personaRisks(path, applied);
  if (path === '.ai/cezar/automations.json') return automationRisks(applied, live);
  if (path === '.ai/cezar/mcp.json') return mcpRisks(applied);
  return [];
}

function parsed(text: string, parse: (text: string) => unknown): { doc: unknown } | ChatProposalRisk {
  try {
    return { doc: parse(text) };
  } catch (error) {
    return { kind: 'unreadable', detail: `does not parse (${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}) — what it runs cannot be listed` };
  }
}

function workflowRisks(text: string): ChatProposalRisk[] {
  const read = parsed(text, (t) => parseYaml(t));
  if (!('doc' in read)) return [read];
  const risks: ChatProposalRisk[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!isDoc(value)) return;
    const id = typeof value.id === 'string' ? value.id : '?';
    if (typeof value.command === 'string') risks.push({ kind: 'command', detail: `${id}: ${value.command}` });
    const kind = typeof value.type === 'string' ? NODE_RISKS[value.type] : undefined;
    if (kind) {
      const url = kind === 'webhook' && typeof value.url === 'string' ? ` ${value.url}` : '';
      risks.push({ kind, detail: `${id}: ${value.type}${url}` });
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'command') walk(child);
  };
  walk(read.doc);
  return risks;
}

function personaRisks(path: string, text: string): ChatProposalRisk[] {
  let source: string | undefined = text;
  if (path.endsWith('.md')) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    source = match?.[1];
  }
  if (source === undefined) return [];
  const read = parsed(source, (t) => parseYaml(t));
  if (!('doc' in read)) return [read];
  if (!isDoc(read.doc)) return [];
  const doc = read.doc;
  return PERSONA_KEYS.filter((key) => doc[key] !== undefined).map((key) => ({ kind: 'persona', detail: `${key}: ${shown(doc[key])}` }));
}

function mcpRisks(text: string): ChatProposalRisk[] {
  const read = parsed(text, (t) => JSON.parse(t));
  if (!('doc' in read)) return [read];
  const servers = isDoc(read.doc) ? (read.doc.mcpServers ?? read.doc.servers ?? read.doc.mcp) : undefined;
  if (!isDoc(servers)) return [];
  return Object.entries(servers).map(([name, server]) => {
    const entry = isDoc(server) ? server : {};
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    const target = typeof entry.command === 'string' ? [entry.command, ...args].join(' ') : typeof entry.url === 'string' ? entry.url : JSON.stringify(server);
    return { kind: 'mcp', detail: `${name}: ${target}` };
  });
}

const TRIGGER_KEYS = ['events', 'schedule', 'intervalSeconds', 'trackerTrigger', 'filters', 'deliver', 'kind'] as const;

function rowsOf(text: string | undefined): Doc[] {
  if (text === undefined) return [];
  try {
    const doc = JSON.parse(text) as unknown;
    return isDoc(doc) && Array.isArray(doc.automations) ? doc.automations.filter(isDoc) : [];
  } catch {
    return [];
  }
}

function automationRisks(applied: string, live: string | undefined): ChatProposalRisk[] {
  const read = parsed(applied, (t) => JSON.parse(t));
  if (!('doc' in read)) return [read];
  const before = new Map(rowsOf(live).map((row) => [row.id, row] as const));
  const risks: ChatProposalRisk[] = [];
  for (const row of rowsOf(applied)) {
    const label = `${typeof row.name === 'string' ? row.name : '?'} (${String(row.id)})`;
    const current = before.get(row.id);
    if (!current) {
      risks.push({ kind: 'automation', detail: `${label}: added, ${row.enabled === true ? 'enabled' : 'paused'} (${shown(row.kind ?? '?')})` });
      continue;
    }
    if (current.enabled !== row.enabled) risks.push({ kind: 'automation', detail: `${label}: enabled ${String(current.enabled)} → ${String(row.enabled)}` });
    for (const key of TRIGGER_KEYS) {
      if (JSON.stringify(current[key]) !== JSON.stringify(row[key])) risks.push({ kind: 'automation', detail: `${label}: ${key} ${shown(row[key] ?? '(none)')}` });
    }
    if (JSON.stringify(current.task) !== JSON.stringify(row.task)) risks.push({ kind: 'automation', detail: `${label}: the task it launches changes` });
  }
  return risks;
}
