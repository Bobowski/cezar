import type { RunRecord } from '../runs/store.ts';

/**
 * A task record carrying agent-, author- or command-written text in every field a projected view
 * must strip or reduce (spec 2026-10-24-cezar-mcp-server §4). Shared by the route test
 * (`server/token-run-view.test.ts`) and the per-field pin (`auth/api-tokens.test.ts`).
 */

/** Not token-shaped: the store's own scrubber (CEZ_REDACT_SECRETS) must not be what hides it. */
export const AGENT_WRITTEN = 'MARKER-the-agent-printed-this';

const AT = '2026-10-24T00:00:00Z';

function report(text: string) {
  return {
    status: 'done' as const,
    result: `${text} ${AGENT_WRITTEN}`,
    evidence: [`saw ${AGENT_WRITTEN}`],
    side_effects: [`wrote ${AGENT_WRITTEN}`],
    errors: [`hit ${AGENT_WRITTEN}`],
    recommended_next_action: `next ${AGENT_WRITTEN}`,
    suggestions: [`try ${AGENT_WRITTEN}`],
  };
}

/** What `store.updateRun` writes on top of a fresh run (`rootRunId` is the run's own id). */
export function agentWrittenRunPatch(rootRunId: string): Partial<RunRecord> {
  return {
    titleSummary: `Title quoting ${AGENT_WRITTEN}`,
    branch: 'cez/abc',
    prNumber: 12,
    tokensUsed: 345,
    systemPrompt: `Use the key ${AGENT_WRITTEN}`,
    queuedMessages: [{ id: 'q1', text: `also ${AGENT_WRITTEN}`, createdAt: AT }],
    promptQueue: [{ id: 'q2', text: `then ${AGENT_WRITTEN}`, createdAt: AT }],
    trackerLinks: [{
      provider: 'jira', sourceId: 'src', scopeId: 'ENG', itemId: 'ENG-1', origin: 'handoff', linkedAt: AT,
      title: 'Fix the build (the tracker’s own title)',
    }],
    graphState: { loops: { review: 1 }, taken: ['a.done->b'], cursor: 'b', outputs: { a: { summary: `printed ${AGENT_WRITTEN}`, verdict: 'pass', costUsd: 0.1 } } },
    dispatch: {
      rootRunId,
      budgetUsd: 2,
      report: report('done'),
      pendingReports: [{ fromRunId: 'c1', title: `child ${AGENT_WRITTEN}`, at: AT, report: report('child') }],
      pendingAsk: { questions: [`may I use ${AGENT_WRITTEN}?`], askedAt: AT },
    },
    workflowDef: {
      name: 'deploy', description: `deploy with ${AGENT_WRITTEN}`, source: 'file', path: '.ai/cezar/workflows/deploy.yaml',
      steps: [
        { id: 'task', name: 'Task', prompt: `deploy with ${AGENT_WRITTEN}` },
        { id: 'verify', name: 'Verify', command: `curl -H "x-key: ${AGENT_WRITTEN}" https://staging`, secrets: ['DEPLOY_TOKEN_MARKER'] },
      ],
      graph: {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'task', type: 'agent', prompt: `deploy with ${AGENT_WRITTEN}` },
          { id: 'verify', type: 'check', command: `curl ${AGENT_WRITTEN}` },
          { id: 'gate', type: 'gate.human', message: `approve ${AGENT_WRITTEN}` },
          { id: 'pr', type: 'github.draft-pr', title: `PR ${AGENT_WRITTEN}` },
          { id: 'comment', type: 'github.pr-comment', body: `said ${AGENT_WRITTEN}` },
          { id: 'end', type: 'end', status: 'success' },
        ],
        edges: [{ from: 'start', to: 'task' }],
      },
    } as RunRecord['workflowDef'],
    error: `step "verify" failed: ${AGENT_WRITTEN}`,
    landing: { status: 'failed', at: AT, stage: 'checks', error: `required check failed:\n${AGENT_WRITTEN}` },
  };
}

/** The whole record, steps with what a failed check printed included, for a unit-level projection. */
export function agentWrittenRun(): RunRecord {
  const id = '3a99cbdd-c814-4b58-9e47-754ea6000001';
  return {
    id,
    title: 'fix the build',
    workflow: 'deploy',
    task: 'fix the build',
    status: 'failed',
    createdAt: AT,
    steps: [
      { id: 'task', name: 'Task', kind: 'agent', status: 'failed', error: `agent said ${AGENT_WRITTEN}` },
      { id: 'verify', name: 'Verify', kind: 'check', status: 'failed', error: `exit 1\n${AGENT_WRITTEN}` },
    ],
    ...agentWrittenRunPatch(id),
  } as RunRecord;
}
