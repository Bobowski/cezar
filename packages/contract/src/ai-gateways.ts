import { z } from 'zod';

import type { Runner } from './health.ts';
import { secretKeyBackendSchema, secretNameIssue, secretValueIssue } from './secrets.ts';

/**
 * AI gateways (spec `.ai/specs/2026-10-28-app-spec-ai-gateways.md`).
 * Public command spelling is `ai-gateways`. Persisted rows stay tolerant; command input is strict.
 * A malformed provisioning key or pending marker fails closed — it is not rewritten into a ready row.
 */

export const AI_GATEWAY_MAX_RECORDS = 100;
export const AI_GATEWAY_APPLY_MAX_BYTES = 1024 * 1024;
export const AI_GATEWAY_SEED_KEY = 'openrouter';

export const AI_GATEWAY_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export const aiGatewayProtocolSchema = z.enum(AI_GATEWAY_PROTOCOLS);
export type AiGatewayProtocol = z.infer<typeof aiGatewayProtocolSchema>;

export const AI_GATEWAY_AUTH_MODES = ['bearer', 'x-api-key'] as const;
export const aiGatewayAuthModeSchema = z.enum(AI_GATEWAY_AUTH_MODES);
export type AiGatewayAuthMode = z.infer<typeof aiGatewayAuthModeSchema>;

/** Workspace provisioning identity. Names and URLs are not identity. */
export const aiGatewayProvisioningKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const BASE_URL_SHAPE = /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/;

/** HTTP(S) API base with no credentials, query, or fragment. Callers strip a trailing slash first. */
export const aiGatewayBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .regex(BASE_URL_SHAPE, 'Use an HTTP(S) API base URL without credentials, query parameters or fragment')
  .refine((value) => !value.endsWith('/'), 'API base URL has no trailing slash');

export const aiGatewayNameSchema = z.string().trim().min(1).max(80);

export const aiGatewayAuthSchema = z
  .object({
    protocols: z.partialRecord(aiGatewayProtocolSchema, aiGatewayAuthModeSchema),
    catalog: aiGatewayAuthModeSchema,
  })
  .strict();
export type AiGatewayAuth = z.infer<typeof aiGatewayAuthSchema>;

export const aiGatewayProtocolsSchema = z
  .array(aiGatewayProtocolSchema)
  .min(1)
  .max(AI_GATEWAY_PROTOCOLS.length)
  .refine((protocols) => new Set(protocols).size === protocols.length, 'protocols are listed once');

function authCoversProtocols(protocols: readonly AiGatewayProtocol[], auth: AiGatewayAuth, ctx: z.RefinementCtx, path: (string | number)[]): void {
  for (const protocol of protocols) {
    if (auth.protocols[protocol] === undefined) {
      ctx.addIssue({ code: 'custom', message: `auth.protocols.${protocol} is required`, path: [...path, protocol] });
    }
  }
  for (const key of Object.keys(auth.protocols)) {
    if (!protocols.includes(key as AiGatewayProtocol)) {
      ctx.addIssue({ code: 'custom', message: `auth.protocols.${key} is not a selected protocol`, path: [...path, key] });
    }
  }
}

/** Write-only. Omission preserves the stored key; a blank value is not a deletion. */
export const aiGatewayApiKeySchema = z.string().superRefine((value, ctx) => {
  const issue = secretValueIssue(value);
  if (issue) ctx.addIssue({ code: 'custom', message: issue });
});

export const aiGatewaySchema = z
  .object({
    id: z.string().uuid(),
    provisioningKey: aiGatewayProvisioningKeySchema.optional(),
    pendingWrite: z.boolean().optional(),
    name: aiGatewayNameSchema,
    baseUrl: aiGatewayBaseUrlSchema,
    protocols: aiGatewayProtocolsSchema,
    auth: aiGatewayAuthSchema,
    enabled: z.boolean(),
    routingRevision: z.string().min(1).max(128),
  })
  .passthrough()
  .superRefine((gateway, ctx) => {
    authCoversProtocols(gateway.protocols, gateway.auth, ctx, ['auth', 'protocols']);
  });
export type AiGateway = z.infer<typeof aiGatewaySchema>;

export const aiGatewayViewSchema = aiGatewaySchema.extend({
  hasApiKey: z.boolean(),
});
export type AiGatewayView = z.infer<typeof aiGatewayViewSchema>;

export const aiGatewaysResponseSchema = z.object({
  gateways: z.array(aiGatewayViewSchema),
  unavailable: z.array(z.object({ id: z.string().uuid() }).strict()),
  keyBackend: secretKeyBackendSchema,
  secretsSkipped: z.string().optional(),
  registryError: z.string().optional(),
});
export type AiGatewaysResponse = z.infer<typeof aiGatewaysResponseSchema>;

export const createAiGatewaySchema = z
  .object({
    name: aiGatewayNameSchema,
    baseUrl: aiGatewayBaseUrlSchema,
    protocols: aiGatewayProtocolsSchema,
    auth: aiGatewayAuthSchema,
    enabled: z.boolean().optional(),
    apiKey: aiGatewayApiKeySchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    authCoversProtocols(input.protocols, input.auth, ctx, ['auth', 'protocols']);
    if (input.enabled === true && input.apiKey === undefined) {
      ctx.addIssue({ code: 'custom', message: 'An enabled gateway needs an API key', path: ['apiKey'] });
    }
  });
export type CreateAiGateway = z.infer<typeof createAiGatewaySchema>;

export const updateAiGatewaySchema = z
  .object({
    name: aiGatewayNameSchema.optional(),
    baseUrl: aiGatewayBaseUrlSchema.optional(),
    protocols: aiGatewayProtocolsSchema.optional(),
    auth: aiGatewayAuthSchema.optional(),
    enabled: z.boolean().optional(),
    apiKey: aiGatewayApiKeySchema.optional(),
  })
  .strict();
export type UpdateAiGateway = z.infer<typeof updateAiGatewaySchema>;

export const aiGatewayParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const removeAiGatewayResponseSchema = z.object({ removed: z.literal(true) }).strict();
export type RemoveAiGatewayResponse = z.infer<typeof removeAiGatewayResponseSchema>;

const applyEntrySchema = z
  .object({
    key: aiGatewayProvisioningKeySchema,
    name: aiGatewayNameSchema.optional(),
    baseUrl: aiGatewayBaseUrlSchema.optional(),
    protocols: aiGatewayProtocolsSchema.optional(),
    auth: aiGatewayAuthSchema.optional(),
    enabled: z.boolean().optional(),
    apiKey: aiGatewayApiKeySchema.optional(),
  })
  .strict();
export type AiGatewayApplyEntry = z.infer<typeof applyEntrySchema>;

export const aiGatewayApplyManifestSchema = z
  .object({
    version: z.literal(1),
    gateways: z.array(applyEntrySchema).min(1).max(AI_GATEWAY_MAX_RECORDS),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.gateways.forEach((entry, index) => {
      if (seen.has(entry.key)) {
        ctx.addIssue({ code: 'custom', message: 'provisioning key is duplicated', path: ['gateways', index, 'key'] });
      }
      seen.add(entry.key);
    });
  });
export type AiGatewayApplyManifest = z.infer<typeof aiGatewayApplyManifestSchema>;

export const AI_GATEWAY_ERROR_CODES = [
  'usage',
  'invalid_json',
  'invalid_input',
  'state_conflict',
  'key_unavailable',
  'repair_required',
  'input_io',
  'lock_timeout',
  'storage_error',
] as const;
export const aiGatewayErrorCodeSchema = z.enum(AI_GATEWAY_ERROR_CODES);

export const AI_GATEWAY_ERROR_FIELDS = ['version', 'gateways', 'key', 'name', 'baseUrl', 'protocols', 'auth', 'enabled', 'apiKey'] as const;

export const aiGatewayApplyErrorSchema = z
  .object({
    code: aiGatewayErrorCodeSchema,
    index: z.number().int().nonnegative().optional(),
    field: z.enum(AI_GATEWAY_ERROR_FIELDS).optional(),
  })
  .strict();
export type AiGatewayApplyError = z.infer<typeof aiGatewayApplyErrorSchema>;

export const AI_GATEWAY_APPLY_OUTCOMES = ['created', 'updated', 'unchanged', 'failed', 'not_attempted'] as const;

export const aiGatewayApplyResultSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['ok', 'invalid', 'failed', 'partial']),
    results: z.array(z.object({
      index: z.number().int().nonnegative(),
      key: aiGatewayProvisioningKeySchema,
      id: z.string().uuid().optional(),
      outcome: z.enum(AI_GATEWAY_APPLY_OUTCOMES),
      error: aiGatewayApplyErrorSchema.optional(),
    }).strict()),
    error: aiGatewayApplyErrorSchema.optional(),
  })
  .strict();
export type AiGatewayApplyResult = z.infer<typeof aiGatewayApplyResultSchema>;

/**
 * Ordinary OpenRouter seed: disabled, keyless, bearer on every protocol it advertises.
 * Anthropic uses bearer here so Claude sends `ANTHROPIC_AUTH_TOKEN` from auth data, not from a provider kind.
 */
export const AI_GATEWAY_OPENROUTER_SEED = {
  provisioningKey: AI_GATEWAY_SEED_KEY,
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  auth: {
    protocols: {
      'openai-completions': 'bearer',
      'openai-responses': 'bearer',
      'anthropic-messages': 'bearer',
    },
    catalog: 'bearer',
  },
  enabled: false,
} as const;

/** Strip a trailing slash. Does not trim credential bytes and is not applied to API keys. */
export function normalizeAiGatewayBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function normalizeAiGatewayName(value: string): string {
  return value.trim();
}

/** Vault slot for a gateway key. Audience is `cezar`; the value never goes in config or `process.env`. */
export function aiGatewaySecretName(id: string): string {
  return `LLM_PROVIDER_${id.replaceAll('-', '_').toUpperCase()}`;
}

export function aiGatewaySecretNameIssue(id: string): string | null {
  return secretNameIssue(aiGatewaySecretName(id));
}

/**
 * One protocol for this launch, pinned on the binding afterwards.
 * Claude is Messages, Codex is Responses, Cursor is native-only.
 * Other runners prefer Completions, then Responses, then Messages (spec §1.4).
 */
const PROTOCOL_PREFERENCE: Record<Runner, readonly AiGatewayProtocol[]> = {
  claude: ['anthropic-messages'],
  codex: ['openai-responses'],
  cursor: [],
  pi: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  opencode: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  junie: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  copilot: ['openai-completions', 'openai-responses', 'anthropic-messages'],
};

export function preferredGatewayProtocol(runner: string, protocols: readonly AiGatewayProtocol[]): AiGatewayProtocol | null {
  const key = runner === 'claude-cli' ? 'claude' : runner;
  const order = PROTOCOL_PREFERENCE[key as Runner];
  if (!order) return null;
  return order.find((protocol) => protocols.includes(protocol)) ?? null;
}

const HANDOFF_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9_./:@+~-]*$/;

/** Copyable handoff. References only — never a credential. `null` when the pieces are not safe to interpolate. */
export function aiGatewayCommand(id: string, runner: string, model: string, nativeCommand: string): string | null {
  if (!z.string().uuid().safeParse(id).success) return null;
  if (preferredGatewayProtocol(runner, AI_GATEWAY_PROTOCOLS) === null || runner === 'cursor') return null;
  if (!HANDOFF_MODEL.test(model)) return null;
  const rest = nativeCommand.replace(/^\S+\s?/, '');
  return `cez ai-gateways exec ${id} ${runner} --model ${model} -- ${rest}`.trimEnd();
}

export type ClassifiedGateway =
  | { kind: 'drop' }
  | { kind: 'invalid'; id: string }
  | { kind: 'gateway'; gateway: AiGateway };

/** Drop a row that is not a gateway. Keep a broken identity or pending marker unavailable. */
export function classifyPersistedGateway(value: unknown): ClassifiedGateway {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'drop' };
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !z.string().uuid().safeParse(row.id).success) return { kind: 'drop' };
  if ('provisioningKey' in row && row.provisioningKey !== undefined && !aiGatewayProvisioningKeySchema.safeParse(row.provisioningKey).success) {
    return { kind: 'invalid', id: row.id };
  }
  if ('pendingWrite' in row && row.pendingWrite !== undefined && typeof row.pendingWrite !== 'boolean') {
    return { kind: 'invalid', id: row.id };
  }
  const parsed = aiGatewaySchema.safeParse(row);
  if (!parsed.success) return { kind: 'invalid', id: row.id };
  return { kind: 'gateway', gateway: parsed.data };
}
