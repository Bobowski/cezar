import { describe, expect, it } from 'vitest';
import { MCP_SERVER_NAME_PATTERN, mcpCatalogEntrySchema, mcpSecretNames, mcpServerDefinitionSchema, secretNameIssue } from '@open-mercato/cezar-contract';
import { MCP_CATALOG } from './catalog.ts';

/** Spec 2026-10-24-easy-mcp §8: catalog entries validate against the definition schema. */
describe('the curated MCP catalog', () => {
  it('has the servers the spec names', () => {
    const ids = MCP_CATALOG.map((entry) => entry.id);
    for (const id of ['context7', 'playwright', 'github', 'supabase', 'vercel', 'stripe', 'sentry', 'linear', 'jira', 'postgres', 'filesystem', 'fetch', 'memory']) {
      expect(ids, id).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(MCP_CATALOG.map((entry) => [entry.id, entry] as const))('%s is a valid entry with a launchable definition', (_id, entry) => {
    expect(mcpCatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(mcpServerDefinitionSchema.safeParse(entry.definition).success).toBe(true);
    expect(entry.suggestedName).toMatch(MCP_SERVER_NAME_PATTERN);
    expect(entry.docsUrl).toMatch(/^https:\/\//);
  });

  it.each(MCP_CATALOG.map((entry) => [entry.id, entry] as const))('%s declares exactly the secrets its definition references', (_id, entry) => {
    const referenced = mcpSecretNames(entry.definition).sort();
    expect(entry.keys.map((key) => key.name).sort()).toEqual(referenced);
    for (const key of entry.keys) expect(secretNameIssue(key.name), key.name).toBeNull();
  });

  it('never carries a credential value — only references', () => {
    for (const entry of MCP_CATALOG) {
      const values = [...Object.values(entry.definition.env ?? {}), ...Object.values(entry.definition.headers ?? {})];
      for (const value of values) expect(value, entry.id).toMatch(/\$\{\{ secrets\.[A-Z0-9_]+ \}\}/);
    }
  });
});
