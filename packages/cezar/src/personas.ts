import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  personaDispatchSchema,
  personaNameSchema,
  type Persona,
  type PersonaIssue,
} from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type RunnerId } from './core/agent-runner.ts';
import { piTools } from './core/pi-runner.ts';
import { cezarHomeDir } from './paths.ts';
import { DEFAULT_ALLOWED_TOOLS, type WorkflowStepDef } from './workflows/types.ts';

export type { Persona, PersonaIssue };

/**
 * Personas (spec `.ai/specs/2026-10-24-personas.md`): named agents of a project — a system
 * prompt plus launch options (runner, model, tools, skills) — used by workflow steps
 * (`agent: <name>`) and dispatch children (`cez task create --as <name>`).
 *
 * Discovery is local-first, like skills: `.ai/cezar/agents/` (committable) → `~/.cezar/agents/`
 * → the repo's `.claude/agents/` (Claude's own subagent files, read-only, mapped onto the
 * Claude backend). The first source to name a persona wins. No directory → no personas, and
 * nothing anywhere changes.
 */
export const PERSONAS_DIR = '.ai/cezar/agents';
export const CLAUDE_AGENTS_DIR = '.claude/agents';

export function globalPersonasDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'agents');
}

/** A persona file's frontmatter. Unknown keys are ignored (a newer cezar's field must not
 *  make an older one refuse the file); every known key is validated. */
const frontmatterSchema = z.object({
  name: personaNameSchema.optional(),
  description: z.string().trim().min(1).optional(),
  runner: z.enum(RUNNER_IDS, { message: `must be one of ${RUNNER_IDS.join(', ')}` }).optional(),
  model: z.string().trim().min(1).optional(),
  allowedTools: z.array(z.string().trim().min(1)).optional(),
  skills: z.array(z.string().trim().min(1)).optional(),
  dispatch: personaDispatchSchema.optional(),
});

/** `---\n…\n---` at the top of the file, CRLF- and BOM-tolerant (as `skills.ts` reads it). */
function splitFrontmatter(raw: string): { block: string | null; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { block: null, body: text };
  return { block: match[1] ?? '', body: text.slice(match[0].length) };
}

function readYamlBlock(block: string | null): Record<string, unknown> | string {
  if (block === null || block.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch (err) {
    return `frontmatter is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return 'frontmatter must be a YAML mapping';
  return parsed as Record<string, unknown>;
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ');
}

/**
 * Parse one cezar persona file. `fallbackName` (the file's basename) names it when the
 * frontmatter does not; a frontmatter `name` that differs is honoured, as skills do.
 */
export function parsePersona(
  raw: string,
  path: string,
  source: 'project' | 'global',
  fallbackName = basename(path, extname(path)),
): Persona | { error: string } {
  const { block, body } = splitFrontmatter(raw);
  const yaml = readYamlBlock(block);
  if (typeof yaml === 'string') return { error: yaml };
  const fm = frontmatterSchema.safeParse(yaml);
  if (!fm.success) return { error: zodMessage(fm.error) };
  const name = fm.data.name ?? fallbackName;
  if (!personaNameSchema.safeParse(name).success) {
    return { error: `"${name}" is not a valid persona name (letters, digits, "-" and "_", at most 64)` };
  }
  return {
    name,
    ...(fm.data.description ? { description: fm.data.description } : {}),
    ...(fm.data.runner ? { runner: fm.data.runner } : {}),
    ...(fm.data.model ? { model: fm.data.model } : {}),
    ...(fm.data.allowedTools ? { allowedTools: fm.data.allowedTools } : {}),
    ...(fm.data.skills ? { skills: fm.data.skills } : {}),
    ...(fm.data.dispatch ? { dispatch: fm.data.dispatch } : {}),
    body: body.trim(),
    path,
    source,
  };
}

/**
 * Map a Claude Code subagent file (`.claude/agents/<name>.md`): `tools` (a comma list or an
 * array) → `allowedTools`, `model` kept unless `inherit`, runner fixed to `claude`. Claude's
 * own tool names are cezar's `allowedTools` grammar, so nothing is translated.
 */
export function parseClaudeAgent(raw: string, path: string): Persona | { error: string } {
  const { block, body } = splitFrontmatter(raw);
  const yaml = readYamlBlock(block);
  if (typeof yaml === 'string') return { error: yaml };
  const fallback = basename(path, extname(path));
  const name = typeof yaml.name === 'string' && yaml.name.trim() ? yaml.name.trim() : fallback;
  if (!personaNameSchema.safeParse(name).success) {
    return { error: `"${name}" is not a valid persona name (letters, digits, "-" and "_", at most 64)` };
  }
  const tools = Array.isArray(yaml.tools)
    ? yaml.tools.filter((t): t is string => typeof t === 'string')
    : typeof yaml.tools === 'string'
      ? yaml.tools.split(',')
      : [];
  const allowedTools = tools.map((t) => t.trim()).filter(Boolean);
  const model = typeof yaml.model === 'string' && yaml.model.trim() && yaml.model.trim() !== 'inherit' ? yaml.model.trim() : undefined;
  const description = typeof yaml.description === 'string' && yaml.description.trim() ? yaml.description.trim() : undefined;
  return {
    name,
    ...(description ? { description } : {}),
    runner: 'claude',
    ...(model ? { model } : {}),
    ...(allowedTools.length ? { allowedTools } : {}),
    body: body.trim(),
    path,
    source: 'claude',
  };
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** Every persona the project can use, project-first, plus the files that failed to load. */
export async function loadPersonas(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ personas: Persona[]; issues: PersonaIssue[] }> {
  const sources: Array<{ dir: string; source: Persona['source'] }> = [
    { dir: resolve(repoRoot, PERSONAS_DIR), source: 'project' },
    { dir: globalPersonasDir(env), source: 'global' },
    { dir: resolve(repoRoot, CLAUDE_AGENTS_DIR), source: 'claude' },
  ];
  const personas: Persona[] = [];
  const issues: PersonaIssue[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of sources) {
    for (const path of await markdownFiles(dir)) {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      const parsed = source === 'claude' ? parseClaudeAgent(raw, path) : parsePersona(raw, path, source);
      if ('error' in parsed) {
        issues.push({ path, message: `${basename(path)}: ${parsed.error}` });
        continue;
      }
      if (seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      personas.push(parsed);
    }
  }
  personas.sort((a, b) => a.name.localeCompare(b.name));
  return { personas, issues };
}

/** What a persona adds to a step beyond its launch fields: its prompt and its skills. */
export interface PersonaResolution {
  /** The step with the persona's runner, model and tools filled in wherever the step left a gap. */
  step: WorkflowStepDef;
  persona?: Persona;
  /** The persona's own system-prompt part, prepended to the step's. */
  systemPrompt?: string;
  /** The persona's skills the step does not already name — added after the step's own skill. */
  extraSkills: string[];
  /** Persona tools outside the step's own allowlist, so not granted (§7: narrow only). */
  droppedTools?: string[];
  /** The persona or its step asked for Claude's sub-agent tool, which a persona never gets. */
  subagentToolRefused?: boolean;
  /** The narrowing left the step NO tools — the step fails closed (`personaNoToolsIssue`). */
  noToolsLeft?: boolean;
}

/** Claude's sub-agent tool (`Task`, renamed `Agent`): never granted to a persona — dispatch is the
 *  budgeted, visible path (AGENTS.md, the dispatch exception). Leaving it out of `allowedTools`
 *  does not stop it under `dontAsk`, so a persona-driven run also DENIES it (`disallowedTools`). */
export const PERSONA_DENIED_TOOLS: readonly string[] = ['Task', 'Agent'];
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(PERSONA_DENIED_TOOLS);
const isSubagentTool = (entry: string) => SUBAGENT_TOOLS.has(entry.replace(/\(.*$/s, '').trim());

/** `narrow` admits nothing `wide` does not: the same entry, a pattern of a bare tool
 *  (`Bash(git *)` ⊂ `Bash`), or one tool of a whole MCP server (`mcp__s__t` ⊂ `mcp__s`). */
function within(narrow: string, wide: string): boolean {
  if (narrow === wide) return true;
  if (wide.includes('(')) return false;
  if (narrow.startsWith(`${wide}(`)) return true;
  return wide.startsWith('mcp__') && wide.split('__').length === 2 && narrow.startsWith(`${wide}__`);
}

/**
 * A persona's tools INTERSECTED with the list the step would otherwise run with (spec §7): a
 * persona can only narrow. Each persona entry keeps the narrower of itself and what it matches.
 */
export function narrowPersonaTools(
  base: readonly string[],
  personaTools: readonly string[],
  bashAllowlist?: readonly string[],
): { tools: string[]; dropped: string[] } {
  const tools: string[] = [];
  const dropped: string[] = [];
  const add = (entry: string) => {
    if (!tools.includes(entry)) tools.push(entry);
  };
  for (const wanted of personaTools) {
    let matched = false;
    for (const allowed of base) {
      if (within(wanted, allowed)) {
        // A step's bashAllowlist bounds `Bash`; a persona's own Bash pattern cannot be compared
        // with it, so the step's bound stands.
        add(allowed === 'Bash' && bashAllowlist?.length ? allowed : wanted);
        matched = true;
        break;
      }
      if (within(allowed, wanted)) {
        add(allowed);
        matched = true;
      }
    }
    if (!matched && !isSubagentTool(wanted)) dropped.push(wanted);
  }
  return { tools, dropped };
}

/**
 * Merge a persona into a step: a runner/model the step sets wins, then the persona's, then — later,
 * at spawn — the project default. A persona's model follows its own runner only: a step that
 * moves the persona to another backend does not inherit a model picked for the first one. Tools
 * only narrow: the persona's list is intersected with the step's (or the default), and the
 * sub-agent tool is never granted.
 */
export function applyPersona(step: WorkflowStepDef, persona: Persona | undefined): PersonaResolution {
  if (!persona) return { step, extraSkills: [] };
  const runner: RunnerId | undefined = step.runner ?? persona.runner;
  const personaModelApplies = !step.runner || !persona.runner || step.runner === persona.runner;
  const model = step.model ?? (personaModelApplies ? persona.model : undefined);
  const { allowedTools, dropped, subagentToolRefused } = personaTools(step, persona);
  const merged: WorkflowStepDef = {
    ...step,
    ...(runner ? { runner } : {}),
    ...(model ? { model } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  };
  const extraSkills = [...new Set(persona.skills ?? [])].filter((name) => name !== step.skill);
  return {
    step: merged,
    persona,
    systemPrompt: personaSystemPrompt(persona),
    extraSkills,
    ...(dropped.length ? { droppedTools: dropped } : {}),
    ...(subagentToolRefused ? { subagentToolRefused } : {}),
    ...(allowedTools?.length === 0 ? { noToolsLeft: true } : {}),
  };
}

type StepTools = Pick<WorkflowStepDef, 'allowedTools' | 'bashAllowlist' | 'runner'>;

/** The step's tools under the persona; `allowedTools` undefined = neither names a list. */
function personaTools(step: StepTools, persona: Persona) {
  const base = step.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const narrowed = persona.allowedTools
    ? narrowPersonaTools(base, persona.allowedTools, step.bashAllowlist)
    : { tools: [...base], dropped: [] };
  const subagentToolRefused = [...(persona.allowedTools ?? []), ...(step.allowedTools ?? [])].some(isSubagentTool);
  const allowedTools = step.allowedTools || persona.allowedTools ? narrowed.tools.filter((t) => !isSubagentTool(t)) : undefined;
  return { allowedTools, dropped: narrowed.dropped, subagentToolRefused };
}

/**
 * A persona that narrows a step to NO tools fails closed — checked after the backend's own
 * mapping, since pi drops a bashAllowlist-bounded Bash and has no verified tool-less mode.
 * `backend` is the runner the step spawns on, when the caller has resolved it; at load, without
 * it, the step's or the persona's own runner is checked.
 */
export function personaNoToolsIssue(
  step: StepTools,
  persona: Persona | undefined,
  backend?: RunnerId,
): string | null {
  if (!persona) return null;
  const { allowedTools } = personaTools(step, persona);
  if (allowedTools === undefined) return null;
  if (allowedTools.length === 0) {
    return `persona "${persona.name}" leaves no tools for this step — its allowedTools share none with the step's`;
  }
  const runner = backend ?? step.runner ?? persona.runner;
  if (runner === 'pi' && piTools(allowedTools, step.bashAllowlist).length === 0) {
    return `persona "${persona.name}" leaves pi no tools for this step — pi cannot bound Bash by a bashAllowlist, so it drops Bash, and nothing else is left`;
  }
  return null;
}

/** `stepsIssue`'s persona options for a project's loaded personas: names, and the no-tools check. */
export function personaStepChecks(personas: readonly Persona[]): {
  personas: Set<string>;
  personaToolsIssue: (step: StepTools & { agent?: string }) => string | null;
} {
  return {
    personas: personaNames(personas),
    personaToolsIssue: (step) => (step.agent ? personaNoToolsIssue(step, personas.find((p) => p.name === step.agent)) : null),
  };
}

/** The persona's part of the system prompt: who it is, then its own instructions. */
export function personaSystemPrompt(persona: Pick<Persona, 'name' | 'description' | 'body'>): string {
  const head = [`Persona: ${persona.name}`, ...(persona.description ? [`Role: ${persona.description}`] : [])];
  return persona.body ? `${head.join('\n')}\n\n${persona.body}` : head.join('\n');
}

/** Where a persona search looked, for a "not found" message. */
export const PERSONA_LOCATIONS = `${PERSONAS_DIR}, ~/.cezar/agents or ${CLAUDE_AGENTS_DIR}`;

/** Why a step naming a missing persona fails at run time — a committed workflow still loads
 *  when it names a global persona this machine lacks. */
export function personaNotFound(name: string): string {
  return `persona "${name}" not found in ${PERSONA_LOCATIONS} — a global persona (~/.cezar/agents) must exist on the machine that runs the workflow`;
}

/** The persona names, for `stepsIssue`. */
export function personaNames(personas: readonly Persona[]): Set<string> {
  return new Set(personas.map((p) => p.name));
}

/**
 * The block a dispatching task reads: which personas `--as` can name. Bounded — it rides in
 * every session's system prompt.
 */
export function personasDispatchPrompt(personas: readonly Persona[]): string | undefined {
  if (!personas.length) return undefined;
  const shown = personas.slice(0, 20);
  const lines = shown.map((p) => {
    const launch = [p.runner, p.model].filter(Boolean).join(', ');
    const description = p.description ? ` — ${p.description.slice(0, 200)}` : '';
    return `- ${p.name}${description}${launch ? ` (${launch})` : ''}`;
  });
  if (personas.length > shown.length) lines.push(`- … and ${personas.length - shown.length} more`);
  return [
    'Personas. This project defines named agents. Dispatch a child as one with cez task create --as <name>: the child runs with that persona\'s runner, model, tools and instructions (an explicit --runner or --model still wins; --tools only narrows). Pick the persona whose role fits the assignment:',
    ...lines,
  ].join('\n');
}
