import { createHash, randomUUID } from 'node:crypto';

import {
  AI_GATEWAY_MAX_RECORDS,
  AI_GATEWAY_OPENROUTER_SEED,
  AI_GATEWAY_SEED_KEY,
  aiGatewaySchema,
  aiGatewaySecretName,
  aiGatewaysResponseSchema,
  classifyPersistedGateway,
  createAiGatewaySchema,
  normalizeAiGatewayBaseUrl,
  normalizeAiGatewayName,
  updateAiGatewaySchema,
  type AiGateway,
  type AiGatewayAuth,
  type AiGatewayProtocol,
  type AiGatewayView,
  type AiGatewaysResponse,
  type CreateAiGateway,
  type UpdateAiGateway,
} from '@open-mercato/cezar-contract';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig, type WorkspaceConfig } from './config.ts';
import { SecretStore } from './secrets.ts';

const WORKSPACE = { kind: 'workspace' } as const;

export class AiGatewayError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'not_found' | 'capacity' | 'unavailable' = 'invalid_input',
  ) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rowsOf(config: WorkspaceConfig): Record<string, unknown>[] | 'invalid' {
  if (config.aiGateways === undefined) return [];
  if (!Array.isArray(config.aiGateways)) return 'invalid';
  return config.aiGateways.filter(isRow);
}

/** `true` once seed initialization finished. Anything else present is corrupt and must not reseed. */
function seedMarker(value: unknown): 'done' | 'absent' | 'invalid' {
  if (value === undefined || value === false) return 'absent';
  if (value === true) return 'done';
  return 'invalid';
}

function invalidInput(prefix: string): AiGatewayError {
  return new AiGatewayError(prefix, 'invalid_input');
}

function normalizeBody(input: unknown): unknown {
  if (!isRow(input)) return input;
  return {
    ...input,
    ...(typeof input.name === 'string' ? { name: normalizeAiGatewayName(input.name) } : {}),
    ...(typeof input.baseUrl === 'string' ? { baseUrl: normalizeAiGatewayBaseUrl(input.baseUrl) } : {}),
  };
}

export function aiGatewayRoutingRevision(parts: {
  baseUrl: string;
  protocols: readonly AiGatewayProtocol[];
  auth: AiGatewayAuth;
}): string {
  const protocols = [...parts.protocols].sort();
  const authKeys = Object.keys(parts.auth.protocols).sort();
  const body = JSON.stringify({
    baseUrl: parts.baseUrl,
    protocols,
    auth: {
      catalog: parts.auth.catalog,
      protocols: Object.fromEntries(authKeys.map((key) => [key, parts.auth.protocols[key as AiGatewayProtocol]])),
    },
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

function toView(gateway: AiGateway, hasApiKey: boolean): AiGatewayView {
  return {
    id: gateway.id,
    ...(gateway.provisioningKey ? { provisioningKey: gateway.provisioningKey } : {}),
    ...(gateway.pendingWrite ? { pendingWrite: true } : {}),
    name: gateway.name,
    baseUrl: gateway.baseUrl,
    protocols: [...gateway.protocols].sort(),
    auth: gateway.auth,
    enabled: gateway.enabled,
    routingRevision: gateway.routingRevision,
    hasApiKey,
  };
}

function sameRecord(left: AiGateway, right: AiGateway): boolean {
  return left.name === right.name
    && left.baseUrl === right.baseUrl
    && left.enabled === right.enabled
    && left.routingRevision === right.routingRevision
    && left.provisioningKey === right.provisioningKey
    && left.pendingWrite === right.pendingWrite
    && JSON.stringify([...left.protocols].sort()) === JSON.stringify([...right.protocols].sort())
    && JSON.stringify(left.auth) === JSON.stringify(right.auth);
}

/**
 * Workspace AI gateways. Secrets stay in the vault under `LLM_PROVIDER_<UUID>`.
 * The pending-write barrier lands with the shared lock; this store still refuses to report
 * a key update that did not land in both places.
 */
export class AiGateways {
  constructor(private readonly secrets = new SecretStore()) {}

  async list(): Promise<AiGatewaysResponse> {
    await this.ensureSeed();
    return this.read();
  }

  async create(input: unknown): Promise<AiGatewayView> {
    const parsed = createAiGatewaySchema.safeParse(normalizeBody(input));
    if (!parsed.success) throw invalidInput('Gateway settings are invalid. Check the name, API base URL, protocols and key.');
    await this.ensureSeed();
    const record = this.newRecord(parsed.data);
    const secret = aiGatewaySecretName(record.id);
    if (parsed.data.apiKey !== undefined) await this.secrets.set(WORKSPACE, secret, parsed.data.apiKey, ['cezar']);
    try {
      await mergeWriteWorkspaceConfig((config) => {
        const rows = rowsOf(config);
        if (rows === 'invalid') throw new AiGatewayError('AI gateway settings could not be read.', 'unavailable');
        if (rows.length >= AI_GATEWAY_MAX_RECORDS) {
          throw new AiGatewayError(`At most ${AI_GATEWAY_MAX_RECORDS} AI gateways can be saved.`, 'capacity');
        }
        config.aiGateways = [...rows, record];
      });
    } catch (error) {
      if (parsed.data.apiKey !== undefined) await this.secrets.unset(WORKSPACE, secret).catch(() => {});
      throw error;
    }
    return toView(record, parsed.data.apiKey !== undefined);
  }

  async update(id: string, input: unknown): Promise<AiGatewayView> {
    if (!zUuid(id)) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
    const parsed = updateAiGatewaySchema.safeParse(normalizeBody(input));
    if (!parsed.success) throw invalidInput('Gateway settings are invalid. Check the name, API base URL, protocols and key.');
    const current = await this.requireGateway(id);
    const next = this.merge(current, parsed.data);
    const secret = aiGatewaySecretName(id);
    const keyChanges = await this.keyChanges(secret, parsed.data.apiKey);
    if (next.enabled && !keyChanges.readable) {
      throw invalidInput('An enabled gateway needs an API key.');
    }
    if (sameRecord(current, next) && !keyChanges.write) return toView(current, keyChanges.readable);
    if (keyChanges.write && parsed.data.apiKey !== undefined) {
      await this.secrets.set(WORKSPACE, secret, parsed.data.apiKey, ['cezar']);
    }
    try {
      await mergeWriteWorkspaceConfig((config) => {
        const rows = rowsOf(config);
        if (rows === 'invalid') throw new AiGatewayError('AI gateway settings could not be read.', 'unavailable');
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) throw new AiGatewayError('That AI gateway was removed.', 'not_found');
        const stored = [...rows];
        const previous = stored[index];
        if (!previous) throw new AiGatewayError('That AI gateway was removed.', 'not_found');
        stored[index] = { ...previous, ...next };
        config.aiGateways = stored;
      });
    } catch (error) {
      if (keyChanges.write) {
        if (keyChanges.previous !== undefined) await this.secrets.set(WORKSPACE, secret, keyChanges.previous, ['cezar']).catch(() => {});
        else await this.secrets.unset(WORKSPACE, secret).catch(() => {});
      }
      throw error;
    }
    return toView(next, keyChanges.readable);
  }

  async remove(id: string): Promise<void> {
    if (!zUuid(id)) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
    let removed = false;
    await mergeWriteWorkspaceConfig((config) => {
      const rows = rowsOf(config);
      if (rows === 'invalid') throw new AiGatewayError('AI gateway settings could not be read.', 'unavailable');
      const next = rows.filter((row) => row.id !== id);
      if (next.length === rows.length) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
      config.aiGateways = next;
      removed = true;
    });
    if (removed) await this.secrets.unset(WORKSPACE, aiGatewaySecretName(id));
  }

  private async ensureSeed(): Promise<void> {
    const current = await loadWorkspaceConfig();
    if (seedMarker(current.aiGatewaysSeeded) !== 'absent') return;
    if (rowsOf(current) === 'invalid') return;
    await mergeWriteWorkspaceConfig((config) => {
      if (seedMarker(config.aiGatewaysSeeded) !== 'absent') return;
      const rows = rowsOf(config);
      if (rows === 'invalid') return;
      const hasSeed = rows.some((row) => {
        const classified = classifyPersistedGateway(row);
        return classified.kind === 'gateway' && classified.gateway.provisioningKey === AI_GATEWAY_SEED_KEY;
      });
      if (!hasSeed && rows.length === 0) config.aiGateways = [this.seedRecord()];
      config.aiGatewaysSeeded = true;
    });
  }

  private seedRecord(): AiGateway {
    const { protocols, auth, baseUrl, name, provisioningKey, enabled } = AI_GATEWAY_OPENROUTER_SEED;
    return {
      id: randomUUID(),
      provisioningKey,
      name,
      baseUrl,
      protocols: [...protocols],
      auth: { catalog: auth.catalog, protocols: { ...auth.protocols } },
      enabled,
      routingRevision: aiGatewayRoutingRevision({ baseUrl, protocols, auth }),
    };
  }

  private newRecord(input: CreateAiGateway): AiGateway {
    const protocols = [...input.protocols].sort();
    const enabled = input.enabled ?? false;
    return {
      id: randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl,
      protocols,
      auth: input.auth,
      enabled,
      routingRevision: aiGatewayRoutingRevision({ baseUrl: input.baseUrl, protocols, auth: input.auth }),
    };
  }

  private merge(current: AiGateway, patch: UpdateAiGateway): AiGateway {
    const protocols = [...(patch.protocols ?? current.protocols)].sort();
    const auth = patch.auth ?? current.auth;
    const baseUrl = patch.baseUrl ?? current.baseUrl;
    const next = {
      ...current,
      name: patch.name ?? current.name,
      baseUrl,
      protocols,
      auth,
      enabled: patch.enabled ?? current.enabled,
      routingRevision: aiGatewayRoutingRevision({ baseUrl, protocols, auth }),
    };
    const parsed = aiGatewaySchema.safeParse(next);
    if (!parsed.success) throw invalidInput('Gateway settings are invalid. Check the name, API base URL, protocols and key.');
    return parsed.data;
  }

  private async keyChanges(secret: string, apiKey: string | undefined): Promise<{ readable: boolean; write: boolean; previous?: string }> {
    const resolved = await this.secrets.resolve(undefined, 'cezar', [secret]);
    const previous = resolved.values[secret];
    if (apiKey === undefined) return { readable: previous !== undefined, write: false, previous };
    if (previous === apiKey) return { readable: true, write: false, previous };
    return { readable: true, write: true, previous };
  }

  private async requireGateway(id: string): Promise<AiGateway> {
    const config = await loadWorkspaceConfig();
    const rows = rowsOf(config);
    if (rows === 'invalid') throw new AiGatewayError('AI gateway settings could not be read.', 'unavailable');
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new AiGatewayError('That AI gateway was not found.', 'not_found');
    const classified = classifyPersistedGateway(row);
    if (classified.kind !== 'gateway') throw new AiGatewayError('This gateway record is unreadable. Remove it and add it again.', 'unavailable');
    return classified.gateway;
  }

  private async read(): Promise<AiGatewaysResponse> {
    const [config, listed, keyBackend] = await Promise.all([
      loadWorkspaceConfig(),
      this.secrets.list(WORKSPACE),
      this.secrets.keyBackend(),
    ]);
    const rows = rowsOf(config);
    if (rows === 'invalid') {
      return aiGatewaysResponseSchema.parse({
        gateways: [],
        unavailable: [],
        keyBackend,
        registryError: 'AI gateway settings could not be read.',
      });
    }
    const names = new Set(listed.skipped ? [] : listed.secrets.map((entry) => entry.name));
    const gateways: AiGatewayView[] = [];
    const unavailable: { id: string }[] = [];
    for (const row of rows) {
      const classified = classifyPersistedGateway(row);
      if (classified.kind === 'gateway') gateways.push(toView(classified.gateway, names.has(aiGatewaySecretName(classified.gateway.id))));
      else if (classified.kind === 'invalid') unavailable.push({ id: classified.id });
    }
    return aiGatewaysResponseSchema.parse({
      gateways,
      unavailable,
      keyBackend,
      ...(listed.skipped ? { secretsSkipped: listed.skipped } : {}),
    });
  }
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
