import { describe, expect, it } from 'vitest'

import { applyKeyChoices, launchLine, parsePastedDefinition } from './mcp-servers-helpers'

describe('MCP servers helpers (spec 2026-10-24-easy-mcp)', () => {
  const jira = {
    command: 'uvx',
    args: ['mcp-atlassian', '--site=${{ secrets.JIRA_URL }}'],
    env: { JIRA_API_TOKEN: '${{ secrets.JIRA_API_TOKEN }}', JIRA_EXTRA: '${{ secrets.OPTIONAL }}' },
  }

  it('renames each key to the secret picked for it and drops what an unfilled optional key fed', () => {
    expect(applyKeyChoices(jira, { JIRA_URL: 'ACME_JIRA_URL', JIRA_API_TOKEN: 'JIRA_API_TOKEN', OPTIONAL: undefined })).toEqual({
      command: 'uvx',
      args: ['mcp-atlassian', '--site=${{ secrets.ACME_JIRA_URL }}'],
      env: { JIRA_API_TOKEN: '${{ secrets.JIRA_API_TOKEN }}' },
    })
  })

  it('keeps header templates around a reference', () => {
    const def = { type: 'http' as const, url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer ${{ secrets.STRIPE_SECRET_KEY }}' } }
    expect(applyKeyChoices(def, { STRIPE_SECRET_KEY: 'STRIPE_TEST_KEY' }).headers).toEqual({ Authorization: 'Bearer ${{ secrets.STRIPE_TEST_KEY }}' })
    expect(launchLine(def)).toBe('http https://mcp.stripe.com')
    expect(launchLine(jira)).toBe('uvx mcp-atlassian --site=${{ secrets.JIRA_URL }}')
  })

  it('reads a pasted definition in the three shapes people copy', () => {
    expect(parsePastedDefinition('{"command":"npx","args":["-y","x"]}', 'x')).toEqual({ name: 'x', definition: { command: 'npx', args: ['-y', 'x'] } })
    expect(parsePastedDefinition('{"docs":{"url":"https://a.example/mcp"}}', '')).toEqual({ name: 'docs', definition: { url: 'https://a.example/mcp' } })
    expect(parsePastedDefinition('{"mcpServers":{"docs":{"url":"https://a.example/mcp"}}}', 'renamed')).toMatchObject({ name: 'renamed' })
  })

  it('names what is wrong with a paste', () => {
    expect(parsePastedDefinition('{', 'x')).toMatchObject({ error: expect.stringMatching(/not valid JSON/) })
    expect(parsePastedDefinition('{"a":{"command":"x"},"b":{"command":"y"}}', '')).toMatchObject({ error: expect.stringMatching(/one server/) })
    expect(parsePastedDefinition('{"command":"x"}', 'bad name')).toMatchObject({ error: expect.stringMatching(/letters, digits/) })
    expect(parsePastedDefinition('{"command":"x","env":{"K":"${{ env.HOME }}"}}', 'x')).toMatchObject({ error: expect.stringMatching(/secrets\.NAME/) })
    expect(parsePastedDefinition('{"command":"x","colour":"red"}', 'x')).toMatchObject({ error: expect.any(String) })
  })
})
