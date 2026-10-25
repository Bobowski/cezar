import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatLivePath, chatProposalPath } from '@open-mercato/cezar-contract';
import { buildClaudeArgs } from '../core/claude-cli-runner.ts';
import { CHAT_WRITABLE, cezarChatPrompt, chatMayWrite, chatToolPolicy, listChatTree, type ChatTreeListing } from './chat.ts';

/** Spec 2026-10-24-cockpit-chat §5: the chat proposes cezar configuration, never cezar's state. */
describe('the chat\'s .ai/cezar allowlist', () => {
  it.each([
    '.ai/cezar/workflows/e2e.yaml',
    '.ai/cezar/skills/review/SKILL.md',
    '.ai/cezar/agents/reviewer.md',
    '.ai/cezar/automations.json',
    '.ai/cezar/mcp.json',
  ])('may propose %s', (path) => {
    expect(chatMayWrite(path)).toBe(true);
    expect(chatMayWrite(path.replace(/\//g, '\\'))).toBe(true);
    const proposal = chatProposalPath('c1', path)!;
    expect(proposal.startsWith('.ai/cezar/proposals/c1/')).toBe(true);
    expect(chatLivePath('c1', proposal)).toBe(path);
    expect(chatLivePath('c2', proposal)).toBeUndefined();
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
  ])('may not propose %s', (path) => {
    expect(chatMayWrite(path)).toBe(false);
    expect(chatProposalPath('c1', path)).toBeUndefined();
  });
});

describe('the chat\'s tool policy', () => {
  const tree: ChatTreeListing = {
    repo: ['src/', 'README.md', 'package.json', '.claude/', '.ai/'],
    ai: ['cezar/', 'specs/'],
    cezar: ['workflows/', 'automations.json', 'config.json', 'runs/', 'proposals/'],
    proposals: ['c1/', 'other-chat/'],
  };
  const { allowedTools, disallowedTools } = chatToolPolicy('c1', tree);
  const pathOf = (rule: string) => /\((.*)\)$/.exec(rule)![1]!;
  /** A gitignore-ish match good enough for these rules: `**` any suffix, an anchored `./` prefix. */
  const covers = (rule: string, path: string) => {
    const pattern = pathOf(rule).replace(/^\.\//, '');
    return pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
  };

  it('writes only its own proposals', () => {
    const writes = allowedTools.filter((rule) => /^(Edit|Write|MultiEdit)\(/.test(rule));
    expect(writes.length).toBe(3 * CHAT_WRITABLE.length);
    for (const rule of writes) expect(pathOf(rule).startsWith('.ai/cezar/proposals/c1/'), rule).toBe(true);
    expect(allowedTools).not.toContain('Bash');
  });

  it('denies a shell, the network and sub-agents outright — a repo\'s own allow rules cannot bring them back', () => {
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit']) expect(disallowedTools).toContain(tool);
  });

  it('denies every write beside the path to its proposals: application code, the live config, other chats', () => {
    const deniedWrite = (path: string) =>
      ['Edit', 'Write', 'MultiEdit'].every((tool) => disallowedTools.some((rule) => rule.startsWith(`${tool}(`) && covers(rule, path)));
    for (const path of [
      'src/app.ts', 'README.md', 'package.json', '.claude/settings.json', '.ai/specs/x.md',
      '.ai/cezar/workflows/quick-task.yaml', '.ai/cezar/automations.json', '.ai/cezar/config.json',
      '.ai/cezar/mcp.json', '.ai/cezar/skills/x.md', '.ai/cezar/runs/r1.ndjson',
      '.ai/cezar/proposals/other-chat/workflows/x.yaml',
    ]) expect(deniedWrite(path), path).toBe(true);
    // No deny rule shadows its own proposals (deny beats allow in Claude).
    for (const rule of disallowedTools.filter((rule) => rule.includes('('))) {
      for (const path of ['.ai/cezar/proposals/c1/workflows/x.yaml', '.ai/cezar/proposals/c1/automations.json']) {
        expect(covers(rule, path), rule).toBe(false);
      }
    }
    // Secrets and run state are not even readable.
    expect(disallowedTools).toContain('Read(.ai/cezar/mcp.local.json)');
    expect(disallowedTools).toContain('Read(.ai/cezar/worktrees/**)');
  });

  it('reads no secrets or cezar state with its file tools: .env*, .ai/cezar beyond its five paths, ~/.cezar, .claude', () => {
    const reads = disallowedTools.filter((rule) => rule.startsWith('Read('));
    for (const rule of ['Read(./.env*)', 'Read(**/.env*)', 'Read(~/.cezar/**)', 'Read(./.claude/**)', 'Read(**/.claude/**)']) {
      expect(reads).toContain(rule);
    }
    for (const path of [
      '.ai/cezar/config.json', '.ai/cezar/config.local.json', '.ai/cezar/mcp.local.json', '.ai/cezar/runs/r1.ndjson',
      '.ai/cezar/worktrees/r1/.env', '.ai/cezar/.gitignore',
    ]) expect(reads.some((rule) => covers(rule, path)), path).toBe(true);
    for (const path of [
      '.ai/cezar/workflows/x.yaml', '.ai/cezar/skills/a.md', '.ai/cezar/agents/a.md', '.ai/cezar/automations.json',
      '.ai/cezar/mcp.json', '.ai/cezar/proposals/c1/workflows/x.yaml', 'src/app.ts',
    ]) expect(reads.some((rule) => covers(rule, path)), path).toBe(false);
  });

  it('reads neither the resolved cezar home (CEZ_HOME) nor ~/.claude, ~/.ssh or ~/.config', () => {
    const saved = process.env.CEZ_HOME;
    process.env.CEZ_HOME = process.platform === 'win32' ? 'D:\\state\\cez-home' : '/srv/state/cez-home';
    try {
      const reads = chatToolPolicy('c1', { repo: [], ai: [], cezar: [], proposals: [] }).disallowedTools.filter((rule) => rule.startsWith('Read('));
      expect(reads).toContain(process.platform === 'win32' ? 'Read(//d/state/cez-home/**)' : 'Read(//srv/state/cez-home/**)');
      for (const rule of ['Read(~/.claude/**)', 'Read(~/.ssh/**)', 'Read(~/.config/**)', 'Read(~/.cezar/**)']) expect(reads).toContain(rule);
    } finally {
      if (saved === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = saved;
    }
  });

  it('lists the checkout it launches in', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-chat-tree-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, '.ai/cezar/proposals/c1'), { recursive: true });
      writeFileSync(join(root, 'README.md'), 'x');
      const listed = listChatTree(root);
      expect([...listed.repo].sort()).toEqual(['.ai/', 'README.md', 'src/']);
      expect(listed.proposals).toEqual(['c1/']);
      expect(chatToolPolicy('c1', listed).disallowedTools).toEqual(expect.arrayContaining(['Write(./src/**)', 'Write(./README.md)']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a strict MCP session passes --strict-mcp-config, so the repo\'s .mcp.json and the user\'s servers stay out', () => {
    const server = { name: 'cezar', transport: 'stdio' as const, command: 'node', args: [], env: {}, headers: {} };
    expect(buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo', mcpServers: [server], strictMcp: true }, {}, '/tmp/mcp.json')).toContain('--strict-mcp-config');
    expect(buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo', mcpServers: [server] }, {}, '/tmp/mcp.json')).not.toContain('--strict-mcp-config');
  });

  it('never writes what runs code on the owner\'s next session, even where the checkout has none yet', () => {
    const empty = chatToolPolicy('c1', { repo: [], ai: [], cezar: [], proposals: [] });
    for (const path of [
      './.claude/**', '**/.claude/**', './.mcp.json', '**/CLAUDE.md', '**/AGENTS.md', './.github/**',
      '**/.envrc', './.husky/**', '**/package.json',
    ]) {
      for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(empty.disallowedTools, `${tool}(${path})`).toContain(`${tool}(${path})`);
    }
    expect(empty.disallowedTools).toContain('NotebookEdit');
  });

  it('runs in dontAsk whatever CEZ_APPROVAL_GATE says, with --settings that allow nothing', () => {
    const policy = chatToolPolicy('c1', tree);
    for (const env of [{}, { CEZ_APPROVAL_GATE: '1' }]) {
      const args = buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo', ...policy }, env);
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { permissions: { allow: unknown[]; defaultMode: string } };
      expect(settings.permissions).toEqual({ allow: [], defaultMode: 'dontAsk' });
    }
    // A task keeps the gate's mode and passes no settings.
    const task = buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo' }, { CEZ_APPROVAL_GATE: '1' });
    expect(task[task.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(task).not.toContain('--settings');
  });

  it('reaches claude as --disallowedTools', () => {
    const args = buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo', allowedTools, disallowedTools });
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(disallowedTools.join(','));
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Bash,');
    expect(buildClaudeArgs({ userPrompt: 'hi', cwd: '/repo' })).not.toContain('--disallowedTools');
  });

  it('the prompt names the proposal paths and says a proposal runs only once applied', () => {
    const prompt = cezarChatPrompt({ chatId: 'c1', mcp: true });
    for (const path of CHAT_WRITABLE) expect(prompt).toContain(path.replace('.ai/cezar/', '.ai/cezar/proposals/c1/'));
    expect(prompt).toContain('PROPOSAL');
    expect(prompt).toContain('never inline steps');
  });
});

describe('the chat prompt on secrets', () => {
  it('says what the token refuses, and that file tools must not reach for them either', () => {
    const prompt = cezarChatPrompt({ chatId: 'c1', mcp: true });
    expect(prompt).toContain('variable names only');
    expect(prompt).toContain('.env files');
  });
});
