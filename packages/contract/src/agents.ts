import { z } from 'zod';
import { DISPATCH_MAX_IN_FLIGHT, DISPATCH_MAX_SUBTASKS } from './dispatch.ts';
import { runnerSchema } from './health.ts';

/**
 * The AGENTS family (spec `.ai/specs/2026-10-24-personas.md`): a project's personas — named
 * agents (system prompt + runner, model, tools, skills) that workflow steps (`agent:`) and
 * dispatch children (`--as`) run as. `GET /agents`, `GET/PUT/DELETE /agents/:name`.
 */

/** A persona's name is its file's name, so it is a safe file stem. */
export const PERSONA_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const personaNameSchema = z
  .string()
  .regex(PERSONA_NAME_PATTERN, 'a persona name is letters, digits, "-" and "_" (at most 64), starting with a letter or digit');

/**
 * Defaults and limits for the children a run spawns while it runs as this persona. Same fields
 * as the composer's dispatch intent, except `maxSubtasks` counts this run's own children and may
 * be `0` — a persona that never dispatches.
 */
export const personaDispatchSchema = z.strictObject({
  maxSubtasks: z.number().int().min(0).max(DISPATCH_MAX_SUBTASKS).optional(),
  inFlight: z.number().int().min(1).max(DISPATCH_MAX_IN_FLIGHT).optional(),
  runner: runnerSchema.optional(),
  model: z.string().max(120).optional(),
  budgetUsd: z.number().positive().max(10_000).optional(),
});
export type PersonaDispatch = z.infer<typeof personaDispatchSchema>;

/** `project`: `.ai/cezar/agents/` (committable). `global`: `~/.cezar/agents/`. `claude`: the
 *  repo's `.claude/agents/` — Claude Code's own subagents, read-only, Claude backend only. */
export const personaSourceSchema = z.enum(['project', 'global', 'claude']);
export type PersonaSource = z.infer<typeof personaSourceSchema>;

export const personaSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  runner: runnerSchema.optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  dispatch: personaDispatchSchema.optional(),
  /** The system prompt: the file's Markdown body. */
  body: z.string(),
  path: z.string(),
  source: personaSourceSchema,
});
export type Persona = z.infer<typeof personaSchema>;

/** What a hosted cockpit without sign-in lists in place of each global persona: it lives in the
 *  host's home, so neither its name nor anything else about it is served. Never a valid name. */
export const HIDDEN_PERSONA_NAME = 'global persona (hidden)';

/** A persona file that did not load — reported, never fatal. The message names the file. */
export const personaIssueSchema = z.object({ path: z.string(), message: z.string() });
export type PersonaIssue = z.infer<typeof personaIssueSchema>;

/** `GET /agents`. */
export const personasResponseSchema = z.object({
  personas: z.array(personaSchema),
  issues: z.array(personaIssueSchema),
  /** Whether `PUT`/`DELETE` are allowed here: a trusted operator (a local cockpit, or a hosted
   *  one enforcing sign-in). Global and `.claude/agents` personas are never editable. */
  editable: z.boolean(),
});
export type PersonasResponse = z.infer<typeof personasResponseSchema>;

/** `GET /agents/:name` — one persona and its file exactly as written, for the editor. */
export const personaFileResponseSchema = z.object({ persona: personaSchema, markdown: z.string() });
export type PersonaFileResponse = z.infer<typeof personaFileResponseSchema>;

/** `PUT /agents/:name` — the whole file, frontmatter and body. */
export const putPersonaSchema = z.strictObject({ markdown: z.string().max(200_000) });
export type PutPersonaInput = z.infer<typeof putPersonaSchema>;

export const putPersonaResponseSchema = z.object({ persona: personaSchema });
export type PutPersonaResponse = z.infer<typeof putPersonaResponseSchema>;

export const deletePersonaResponseSchema = z.object({ ok: z.literal(true), path: z.string() });
export type DeletePersonaResponse = z.infer<typeof deletePersonaResponseSchema>;
