import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_GATEWAY_SEED_KEY, aiGatewaySecretName } from '@open-mercato/cezar-contract';
import { cezarHomeDir, workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig, workspaceConfigBackupPath } from './config.ts';
import { AiGatewayError, AiGateways } from './ai-gateways.ts';
import { FileLockTimeoutError } from './file-lock.ts';
import { SecretStore } from './secrets.ts';

const auth = {
  protocols: { 'openai-responses': 'bearer' as const },
  catalog: 'bearer' as const,
};

const custom = {
  name: ' Sandbox ',
  baseUrl: 'https://gateway.example/v1/',
  protocols: ['openai-responses' as const],
  auth,
  apiKey: 'sk-sandbox',
};

function gateways(): AiGateways {
  return new AiGateways(new SecretStore(process.env, { keychain: async () => null }));
}

const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];

describe('AI gateways store', () => {
  beforeEach(async () => {
    await rm(workspaceConfigPath(), { force: true });
    await rm(workspaceConfigBackupPath(), { force: true });
    await rm(`${workspaceConfigPath()}.lock`, { recursive: true, force: true });
    await rm(join(cezarHomeDir(), 'ai-gateways.lock'), { recursive: true, force: true });
    await rm(join(cezarHomeDir(), 'secrets'), { recursive: true, force: true });
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  it('seeds one disabled OpenRouter and does not recreate it after deletion', async () => {
    const store = gateways();
    const first = await store.list();
    const seed = first.gateways.find((gateway) => gateway.provisioningKey === AI_GATEWAY_SEED_KEY);
    expect(seed).toMatchObject({ name: 'OpenRouter', enabled: false, hasApiKey: false, baseUrl: 'https://openrouter.ai/api/v1' });
    expect(first.secretsSkipped).toBeUndefined();

    const again = await new AiGateways(new SecretStore(process.env, { keychain: async () => null })).list();
    expect(again.gateways.map((gateway) => gateway.id)).toEqual([seed?.id]);

    await store.remove(seed!.id);
    const after = await store.list();
    expect(after.gateways).toEqual([]);
    expect((await loadWorkspaceConfig()).aiGatewaysSeeded).toBe(true);
  });

  it('keeps an existing registry and a corrupt seed marker from gaining another OpenRouter', async () => {
    const store = gateways();
    await writeFile(workspaceConfigPath(), JSON.stringify({
      aiGateways: [{
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Already',
        baseUrl: 'https://gateway.example/v1',
        protocols: ['openai-responses'],
        auth,
        enabled: false,
        routingRevision: 'rev',
      }],
    }));
    const listed = await store.list();
    expect(listed.gateways.map((gateway) => gateway.name)).toEqual(['Already']);
    expect((await loadWorkspaceConfig()).aiGatewaysSeeded).toBe(true);

    await writeFile(workspaceConfigPath(), JSON.stringify({ aiGatewaysSeeded: 'nope', aiGateways: [] }));
    const blocked = await gateways().list();
    expect(blocked.gateways).toEqual([]);
    expect((await loadWorkspaceConfig()).aiGatewaysSeeded).toBe('nope');
  });

  it('rejects an unreadable registry instead of showing an empty saved list', async () => {
    await writeFile(workspaceConfigPath(), JSON.stringify({ aiGateways: { bad: true } }));
    const listed = await gateways().list();
    expect(listed.registryError).toMatch(/could not be read/);
    expect(listed.gateways).toEqual([]);
    expect(JSON.parse(await readFile(workspaceConfigPath(), 'utf8')).aiGateways).toEqual({ bad: true });
  });

  it('creates, preserves a blank key replacement, and rotates without changing the routing revision', async () => {
    const store = gateways();
    const created = await store.create({ ...custom, enabled: true });
    expect(created).toMatchObject({
      name: 'Sandbox',
      baseUrl: 'https://gateway.example/v1',
      enabled: true,
      hasApiKey: true,
    });
    expect(created.provisioningKey).toBeUndefined();
    const revision = created.routingRevision;

    const renamed = await store.update(created.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(renamed.routingRevision).toBe(revision);
    expect(renamed.hasApiKey).toBe(true);

    const secrets = new SecretStore(process.env, { keychain: async () => null });
    const before = await secrets.list({ kind: 'workspace' });
    const same = await store.update(created.id, { apiKey: 'sk-sandbox' });
    const after = await secrets.list({ kind: 'workspace' });
    expect(same.routingRevision).toBe(revision);
    expect(after.secrets.find((entry) => entry.name === aiGatewaySecretName(created.id))?.updatedAt)
      .toBe(before.secrets.find((entry) => entry.name === aiGatewaySecretName(created.id))?.updatedAt);

    const rotated = await store.update(created.id, { apiKey: 'sk-next' });
    expect(rotated.routingRevision).toBe(revision);
    const resolved = await secrets.resolve(undefined, 'cezar', [aiGatewaySecretName(created.id)]);
    expect(resolved.values[aiGatewaySecretName(created.id)]).toBe('sk-next');

    const moved = await store.update(created.id, { baseUrl: 'https://other.example/v1' });
    expect(moved.routingRevision).not.toBe(revision);
  });

  it('does not store an invalid gateway or echo its key', async () => {
    const store = gateways();
    const secret = 'sk-do-not-echo-this';
    await expect(store.create({ ...custom, baseUrl: 'https://user:secret@gateway.example/v1', apiKey: secret }))
      .rejects.toThrow(AiGatewayError);
    expect((await loadWorkspaceConfig()).aiGateways).toBeUndefined();
    await expect(store.create({ ...custom, apiKey: '' })).rejects.toThrow(/invalid/i);
    try {
      await store.create({ ...custom, apiKey: '' });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('stops at 100 records and keeps a malformed row unavailable', async () => {
    const store = gateways();
    await store.list();
    await mergeWriteWorkspaceConfig((config) => {
      const rows = Array.isArray(config.aiGateways) ? [...config.aiGateways] : [];
      const broken = '550e8400-e29b-41d4-a716-446655440001';
      rows.push({ id: broken, provisioningKey: 'Not A Key' });
      while (rows.length < 100) rows.push({ id: `filler-${rows.length}` });
      config.aiGateways = rows;
    });
    await expect(store.create(custom)).rejects.toMatchObject({ code: 'capacity' });
    const listed = await store.list();
    expect(listed.gateways).toHaveLength(1);
    expect(listed.unavailable.map((row) => row.id)).toEqual(['550e8400-e29b-41d4-a716-446655440001']);
    await expect(store.update('550e8400-e29b-41d4-a716-446655440001', { name: 'Nope' }))
      .rejects.toMatchObject({ code: 'unavailable' });
    await store.remove('550e8400-e29b-41d4-a716-446655440001');
    expect((await store.list()).unavailable).toEqual([]);
  });

  it('waits on the gateway lock instead of seeding under another owner', async () => {
    const lock = join(cezarHomeDir(), 'ai-gateways.lock');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    children.push(child);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, String(child.pid)), '');
    const store = new AiGateways(new SecretStore(process.env, { keychain: async () => null }), 80);
    await expect(store.list()).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await loadWorkspaceConfig()).aiGatewaysSeeded).toBeUndefined();
  });

  it('refuses to enable a gateway that has no key', async () => {
    const store = gateways();
    const created = await store.create({ ...custom, apiKey: undefined, enabled: false });
    await expect(store.update(created.id, { enabled: true })).rejects.toThrow(/API key/);
    expect((await store.list()).gateways.find((gateway) => gateway.id === created.id)?.enabled).toBe(false);
  });
});
