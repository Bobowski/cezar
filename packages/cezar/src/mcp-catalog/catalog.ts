import type { McpCatalogEntry } from '@open-mercato/cezar-contract';

/**
 * The curated MCP catalog (spec `2026-10-24-easy-mcp` §3): servers cezar's maintainers have looked
 * at, each with the command or URL it launches, the keys it needs and its docs. A key is always a
 * project secret, referenced as `${{ secrets.KEY }}` and resolved at launch — never stored here.
 * Checked 2026-10-24 against each project's README; `catalog.test.ts` validates every entry
 * against the definition schema. Remote servers that sign in only through an OAuth browser round
 * trip are marked `oauth` (spec §7: a headless run cannot finish that).
 */

const ref = (name: string) => `\${{ secrets.${name} }}`;

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'context7',
    title: 'Context7',
    description: 'Up-to-date library documentation and code examples, fetched on demand.',
    docsUrl: 'https://github.com/upstash/context7',
    suggestedName: 'context7',
    definition: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    keys: [],
  },
  {
    id: 'playwright',
    title: 'Playwright',
    description: 'Drive a real browser: navigate, click, fill forms and read pages through accessibility snapshots.',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    suggestedName: 'playwright',
    definition: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    keys: [],
  },
  {
    id: 'chrome-devtools',
    title: 'Chrome DevTools',
    description: 'Inspect and debug a live Chrome: console, network, performance traces.',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    suggestedName: 'chrome-devtools',
    definition: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    keys: [],
  },
  {
    id: 'github',
    title: 'GitHub',
    description: 'Issues, pull requests, code search and Actions through GitHub\'s hosted MCP server.',
    docsUrl: 'https://github.com/github/github-mcp-server',
    suggestedName: 'github',
    definition: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: `Bearer ${ref('GITHUB_PERSONAL_ACCESS_TOKEN')}` },
    },
    keys: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'A GitHub personal access token with the scopes the agent needs.', required: true }],
  },
  {
    id: 'supabase',
    title: 'Supabase',
    description: 'Query and manage a Supabase project: tables, migrations, logs. Read-only by default.',
    docsUrl: 'https://github.com/supabase-community/supabase-mcp',
    suggestedName: 'supabase',
    definition: {
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'],
      env: { SUPABASE_ACCESS_TOKEN: ref('SUPABASE_ACCESS_TOKEN') },
    },
    keys: [{ name: 'SUPABASE_ACCESS_TOKEN', description: 'A Supabase personal access token (Account → Access Tokens).', required: true }],
  },
  {
    id: 'vercel',
    title: 'Vercel',
    description: 'Projects, deployments and logs on Vercel, through Vercel\'s hosted MCP server.',
    docsUrl: 'https://vercel.com/docs/mcp/vercel-mcp',
    suggestedName: 'vercel',
    definition: { type: 'http', url: 'https://mcp.vercel.com' },
    keys: [],
    oauth: true,
  },
  {
    id: 'stripe',
    title: 'Stripe',
    description: 'Customers, payments, products and the Stripe docs, through Stripe\'s hosted MCP server.',
    docsUrl: 'https://docs.stripe.com/mcp',
    suggestedName: 'stripe',
    definition: {
      type: 'http',
      url: 'https://mcp.stripe.com',
      headers: { Authorization: `Bearer ${ref('STRIPE_SECRET_KEY')}` },
    },
    keys: [{ name: 'STRIPE_SECRET_KEY', description: 'A Stripe secret or restricted key — a test-mode key for development.', required: true }],
  },
  {
    id: 'sentry',
    title: 'Sentry',
    description: 'Issues, events and releases from Sentry.',
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
    suggestedName: 'sentry',
    definition: {
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@latest'],
      env: { SENTRY_ACCESS_TOKEN: ref('SENTRY_ACCESS_TOKEN') },
    },
    keys: [{ name: 'SENTRY_ACCESS_TOKEN', description: 'A Sentry user auth token.', required: true }],
  },
  {
    id: 'linear',
    title: 'Linear',
    description: 'Find, create and update Linear issues, projects and comments.',
    docsUrl: 'https://linear.app/docs/mcp',
    suggestedName: 'linear',
    definition: {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: `Bearer ${ref('LINEAR_API_KEY')}` },
    },
    keys: [{ name: 'LINEAR_API_KEY', description: 'A Linear personal API key (Settings → Security & access).', required: true }],
  },
  {
    id: 'jira',
    title: 'Jira & Confluence',
    description: 'Jira issues and Confluence pages through the community mcp-atlassian server (needs uv).',
    docsUrl: 'https://github.com/sooperset/mcp-atlassian',
    suggestedName: 'atlassian',
    definition: {
      command: 'uvx',
      args: ['mcp-atlassian'],
      env: {
        JIRA_URL: ref('JIRA_URL'),
        JIRA_USERNAME: ref('JIRA_USERNAME'),
        JIRA_API_TOKEN: ref('JIRA_API_TOKEN'),
      },
    },
    keys: [
      { name: 'JIRA_URL', description: 'Your site, e.g. https://your-company.atlassian.net.', required: true },
      { name: 'JIRA_USERNAME', description: 'The Atlassian account email.', required: true },
      { name: 'JIRA_API_TOKEN', description: 'An Atlassian API token (id.atlassian.com → Security).', required: true },
    ],
  },
  {
    id: 'postgres',
    title: 'Postgres',
    description: 'Inspect schemas and run restricted SQL against a Postgres database (Postgres MCP Pro, needs uv).',
    docsUrl: 'https://github.com/crystaldba/postgres-mcp',
    suggestedName: 'postgres',
    definition: {
      command: 'uvx',
      args: ['postgres-mcp', '--access-mode=restricted'],
      env: { DATABASE_URI: ref('DATABASE_URI') },
    },
    keys: [{ name: 'DATABASE_URI', description: 'A connection string, e.g. postgresql://user:pass@host:5432/db.', required: true }],
  },
  {
    id: 'filesystem',
    title: 'Filesystem',
    description: 'Read and write files under the task\'s working directory, with explicit access control.',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    suggestedName: 'filesystem',
    definition: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    keys: [],
  },
  {
    id: 'fetch',
    title: 'Fetch',
    description: 'Fetch a URL and hand the agent its content as Markdown (needs uv).',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    suggestedName: 'fetch',
    definition: { command: 'uvx', args: ['mcp-server-fetch'] },
    keys: [],
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'A persistent knowledge graph the agent can write to and recall from.',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    suggestedName: 'memory',
    definition: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    keys: [],
  },
  {
    id: 'sequential-thinking',
    title: 'Sequential Thinking',
    description: 'A structured step-by-step thinking tool for multi-stage problems.',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    suggestedName: 'sequential-thinking',
    definition: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    keys: [],
  },
];
