import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from './agent-runner.ts';
import { buildPiArgs } from './pi-runner.ts';

// The helpers' runner is pi's own argv builder: a refused spawn throws exactly as pi would.
const seen = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], answer: '' }));
vi.mock('./runner-factory.ts', () => ({
  createRunner: () => ({
    run: async (spec: AgentRunSpec) => {
      seen.specs.push(spec);
      buildPiArgs(spec);
      return { text: seen.answer, toolCalls: [] };
    },
  }),
}));

const { planChain } = await import('../planner.ts');
const { generateRunName } = await import('../runs/auto-name.ts');
const { generateCommitMessage } = await import('../workflows/commit-message.ts');

describe('pi runs the tool-less helpers (planner, namer, commit subject)', () => {
  let root: string;
  const previous = { autoname: process.env.CEZ_AUTONAME, dry: process.env.CEZ_DRY_RUN };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pi-toolless-'));
    seen.specs = [];
    process.env.CEZ_AUTONAME = '1';
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (previous.autoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = previous.autoname;
    if (previous.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previous.dry;
  });

  it('plans with the model instead of falling back', async () => {
    seen.answer = JSON.stringify({ title: 'fix it', steps: [{ name: 'Fix', prompt: 'Fix the bug' }] });
    const plan = await planChain(root, 'fix the bug');
    expect(plan.fallback).toBe(false);
    expect(seen.specs[0]).toMatchObject({ allowedTools: [], toolless: true });
  });

  it('names a run with the model', async () => {
    seen.answer = JSON.stringify({ title: 'Fix login redirect' });
    expect(await generateRunName(root, { task: 'fix the login redirect' })).toMatchObject({ titleSummary: 'fix login redirect' });
    expect(seen.specs[0]).toMatchObject({ allowedTools: [], toolless: true });
  });

  it('writes a commit subject with the model', async () => {
    seen.answer = JSON.stringify({ subject: 'Add a summary' });
    expect(await generateCommitMessage(root, { files: [{ status: 'A', path: 'a.md' }], patch: '+a' })).toEqual({ subject: 'Add a summary' });
    expect(seen.specs[0]).toMatchObject({ allowedTools: [], toolless: true });
  });
});
