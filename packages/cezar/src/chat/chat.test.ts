import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../core/claude-cli-runner.ts';
import { CHAT_ALLOWED_TOOLS, CHAT_DENIED_TOOLS, CHAT_WRITABLE, cezarChatPrompt, chatMayWrite } from './chat.ts';

/** Spec 2026-10-24-cockpit-chat §5: the chat writes cezar configuration, never cezar's state. */
describe('the chat\'s .ai/cezar allowlist', () => {
  it.each([
    '.ai/cezar/workflows/e2e.yaml',
    '.ai/cezar/skills/review/SKILL.md',
    '.ai/cezar/agents/reviewer.md',
    '.ai/cezar/automations.json',
    '.ai/cezar/mcp.json',
  ])('may write %s', (path) => {
    expect(chatMayWrite(path)).toBe(true);
    expect(chatMayWrite(path.replace(/\//g, '\\'))).toBe(true);
  });

  it.each([
    '.ai/cezar/config.json',
    '.ai/cezar/config.local.json',
    '.ai/cezar/mcp.local.json',
    '.ai/cezar/runs.json',
    '.ai/cezar/runs/r1.ndjson',
    '.ai/cezar/worktrees/r1/src/app.ts',
    '.ai/cezar/tracker.json',
    '.ai/cezar/github-webhook.json',
    '.ai/cezar/.gitignore',
    '.ai/cezar/workflowsx/a.yaml',
    '.ai/cezar/workflows/../config.json',
    '.ai/cezar/mcp.json.bak',
    'src/app.ts',
  ])('may not write %s', (path) => {
    expect(chatMayWrite(path)).toBe(false);
  });

  it('grants Edit/Write only on that list, and denies the rest of .ai/cezar/ explicitly', () => {
    const writes = CHAT_ALLOWED_TOOLS.filter((rule) => /^(Edit|Write|MultiEdit)\(/.test(rule));
    expect(writes).not.toContain('Edit(.ai/cezar/**)');
    for (const rule of writes) {
      const path = /\((.*)\)$/.exec(rule)![1]!.replace(/\*\*$/, 'x');
      expect(chatMayWrite(path), rule).toBe(true);
    }
    for (const path of ['config.json', 'config.local.json', 'mcp.local.json', 'runs.json', 'runs/**', 'worktrees/**']) {
      for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(CHAT_DENIED_TOOLS).toContain(`${tool}(.ai/cezar/${path})`);
    }
    // Private MCP tokens and other tasks' files are not even readable.
    expect(CHAT_DENIED_TOOLS).toContain('Read(.ai/cezar/mcp.local.json)');
    expect(CHAT_DENIED_TOOLS).toContain('Read(.ai/cezar/worktrees/**)');
    // No deny rule shadows an allowed path (deny beats allow in Claude).
    for (const rule of CHAT_DENIED_TOOLS) {
      const path = /\((.*)\)$/.exec(rule)![1]!.replace(/\*\*$/, 'x').replace(/\*/g, 'x');
      expect(chatMayWrite(path), rule).toBe(false);
    }
  });

  it('reaches claude as --disallowedTools', () => {
    const args = buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo', allowedTools: CHAT_ALLOWED_TOOLS, disallowedTools: CHAT_DENIED_TOOLS });
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(CHAT_DENIED_TOOLS.join(','));
    expect(buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo' })).not.toContain('--disallowedTools');
  });

  it('the prompt names the same list', () => {
    const prompt = cezarChatPrompt({ mcp: true });
    for (const path of CHAT_WRITABLE) expect(prompt).toContain(path);
    expect(prompt).not.toContain('write under .ai/cezar/ directly');
  });
});
