import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadPersonas, personaStepChecks } from '../personas.ts';
import { graphIssues, graphToSteps, workflowGraphFileSchema, type WorkflowGraph } from './graph.ts';
import { BUILT_IN_GRAPH_WORKFLOWS } from './templates.ts';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  stepsIssue,
  unknownPersonaIssue,
  workflowDefSchema,
  workflowFileSchema,
  type WorkflowDef,
} from './types.ts';

export const WORKFLOWS_DIR = '.ai/cezar/workflows';

export interface WorkflowLoadIssue {
  path: string;
  message: string;
}

/** `cezar run`'s stderr lines for the load issues: a file that still loaded is a warning, not a skip. */
export function loadIssueLines(workflows: readonly WorkflowDef[], issues: readonly WorkflowLoadIssue[]): string[] {
  const loaded = new Set(workflows.flatMap((w) => (w.path ? [w.path] : [])));
  return issues.map((issue) => `! ${loaded.has(issue.path) ? 'warning' : 'skipped'} ${issue.path}: ${issue.message}`);
}

const graphAgentNodes =(graph: Pick<WorkflowGraph, 'nodes'>) =>
  graph.nodes.flatMap((n) =>
    n.type === 'agent' ? [{ id: n.id, agent: n.agent, runner: n.runner, allowedTools: n.allowedTools, bashAllowlist: n.bashAllowlist }] : [],
  );

/** A graph's agent nodes (fork branches included) whose `agent:` names no persona (skipped when
 *  `personas` is undefined) — or, given the loaded personas' checks, one that leaves the node no tools. */
export function graphPersonaIssues(
  graph: Pick<WorkflowGraph, 'nodes'>,
  personas: ReadonlySet<string> | undefined,
  personaToolsIssue?: ReturnType<typeof personaStepChecks>['personaToolsIssue'],
): string[] {
  const agents = graphAgentNodes(graph);
  const issue = personas ? unknownPersonaIssue(agents, personas, 'agent node') : null;
  if (issue) return [issue];
  for (const node of personaToolsIssue ? agents : []) {
    const toolsIssue = personaToolsIssue!(node);
    if (toolsIssue) return [`agent node "${node.id}": ${toolsIssue}`];
  }
  return [];
}

/** A committed workflow may name a global persona this machine lacks: it stays in the catalog with
 *  this warning, and the step fails when it runs (`executeAgentStep`). */
function missingPersonaWarning(
  steps: ReadonlyArray<{ id: string; agent?: string }>,
  personas: ReadonlySet<string>,
  noun?: string,
): string | null {
  const unknown = unknownPersonaIssue(steps, personas, noun);
  return unknown
    ? `${unknown} — loaded anyway: a global persona (~/.cezar/agents) may be missing on this machine; the step fails when it runs until it exists`
    : null;
}

/**
 * Load the workflow catalog: the built-in `quick-task` plus every
 * `.ai/cezar/workflows/*.{yaml,yml}` in the repo. File workflows win name
 * collisions with built-ins. Invalid files are reported, never fatal.
 */
export async function loadWorkflows(
  repoRoot: string,
): Promise<{ workflows: WorkflowDef[]; issues: WorkflowLoadIssue[] }> {
  const dir = resolve(repoRoot, WORKFLOWS_DIR);
  const issues: WorkflowLoadIssue[] = [];
  const fromFiles: WorkflowDef[] = [];
  // A step's `agent:` is checked against the personas (spec 2026-10-24-personas): one that leaves
  // a step no tools hides the file; an unknown one — perhaps a global persona this machine lacks —
  // is a warning, and that step fails when it runs.
  let personas: ReturnType<typeof personaStepChecks> | undefined;
  const knownPersonas = async () => (personas ??= personaStepChecks((await loadPersonas(repoRoot)).personas));

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // no workflows dir — built-ins only
  }

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const path = join(dir, entry);
    try {
      const raw = await readFile(path, 'utf8');
      const doc: unknown = parseYaml(raw);
      // `version: 2` is a graph workflow (spec 2026-09-30-workflow-node-editor); anything else
      // is the v1 `steps`/`skills` format, loaded exactly as before. A hand-edited file may
      // quote the version (`version: "2"`) — treated the same as the numeric literal, or this
      // falls through to a confusing v1 "missing steps" error instead.
      const docVersion = doc && typeof doc === 'object' ? (doc as { version?: unknown }).version : undefined;
      if (doc && typeof doc === 'object' && (docVersion === 2 || docVersion === '2')) {
        const graphDoc = workflowGraphFileSchema.safeParse({ ...(doc as object), version: 2 });
        if (!graphDoc.success) {
          issues.push({ path, message: graphDoc.error.issues.map((i) => i.message).join('; ') });
          continue;
        }
        const problems = graphIssues(graphDoc.data);
        let warning: string | null = null;
        if (!problems.length && graphDoc.data.nodes.some((n) => n.type === 'agent' && n.agent)) {
          const checks = await knownPersonas();
          problems.push(...graphPersonaIssues(graphDoc.data, undefined, checks.personaToolsIssue));
          warning = missingPersonaWarning(graphAgentNodes(graphDoc.data), checks.personas, 'agent node');
        }
        if (problems.length) {
          issues.push({ path, message: problems.join('; ') });
          continue;
        }
        if (warning) issues.push({ path, message: warning });
        const { version, name, description, nodes, edges, layout } = graphDoc.data;
        void version;
        fromFiles.push({
          name,
          ...(description ? { description } : {}),
          steps: graphToSteps(graphDoc.data),
          graph: { nodes, edges, ...(layout ? { layout } : {}) },
          source: 'file',
          path,
        });
        continue;
      }
      const parsed = workflowFileSchema.safeParse(doc);
      if (!parsed.success) {
        issues.push({ path, message: parsed.error.issues.map((i) => i.message).join('; ') });
        continue;
      }
      // `skills:` shorthand files become plain agent steps here (spec 012).
      const normalized = normalizeWorkflowDoc(parsed.data);
      // Steps referenced by onFail.retry must exist and come earlier; ids unique.
      const checks = normalized.steps.some((s) => s.agent) ? await knownPersonas() : undefined;
      const issue = stepsIssue(normalized.steps, checks ? { personaToolsIssue: checks.personaToolsIssue } : {});
      if (issue) {
        issues.push({ path, message: issue });
        continue;
      }
      const warning = checks ? missingPersonaWarning(normalized.steps, checks.personas) : null;
      if (warning) issues.push({ path, message: warning });
      fromFiles.push({ ...normalized, source: 'file', path });
    } catch (err) {
      issues.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const fileNames = new Set(fromFiles.map((w) => w.name));
  const workflows = [
    ...fromFiles,
    ...[QUICK_TASK_WORKFLOW, ...BUILT_IN_GRAPH_WORKFLOWS].filter((w) => !fileNames.has(w.name)),
  ];
  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows, issues };
}

/**
 * The catalog's CURRENT entry under a queued run's snapshot name, when it differs from the
 * snapshot (#1078) — the definition that run should start with instead.
 *
 * `startRun` snapshots the workflow at creation (the record's `workflowDef`, #367), so a run that
 * waited in the queue while its file gained a step would otherwise run the old chain — while a
 * run started at that same instant gets the new one, because the loader has no cache. Only a
 * catalog entry is re-resolved: a workflow file, or the built-in `quick-task`. The ad-hoc chains
 * ("(planned)", "(inbox)") are `built-in` too but live on the record alone, so a file that
 * happens to share their name must never replace them. A file deleted or made invalid since the
 * run was queued is absent from the catalog, and the snapshot runs as before. That includes a file
 * that overrode `quick-task`: the loader then restores the built-in under the same name, so a
 * snapshot never moves from a file to a built-in — the file's steps would be silently dropped.
 *
 * Returns `undefined` when there is nothing newer to take. Compared through the persisted
 * schema, so a snapshot read back from `runs.json` (keys in schema order) and the same file
 * freshly loaded are equal.
 */
export function newerCatalogWorkflow(snapshot: WorkflowDef, catalog: readonly WorkflowDef[]): WorkflowDef | undefined {
  if (snapshot.source !== 'file' && snapshot.name !== QUICK_TASK_WORKFLOW.name) return undefined;
  const current = catalog.find((w) => w.name === snapshot.name);
  if (!current || (snapshot.source === 'file' && current.source !== 'file')) return undefined;
  const canonical = (def: WorkflowDef): string | undefined => {
    const parsed = workflowDefSchema.safeParse(def);
    return parsed.success ? JSON.stringify(parsed.data) : undefined;
  };
  const next = canonical(current);
  if (next === undefined || next === canonical(snapshot)) return undefined;
  return current;
}
