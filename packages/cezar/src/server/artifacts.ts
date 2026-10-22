import type { RunArtifact, RunArtifactsEvent } from '@open-mercato/cezar-contract';

/** Run artifacts on the SSE streams (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md`). */

/** What `RunStore.publishArtifacts` emits as `('artifacts', …)`. */
export interface ArtifactsBusPayload {
  runId: string;
  artifacts: RunArtifact[];
  truncated: boolean;
}

/** The `artifacts` SSE frame; `project` only on the workspace stream. */
export function artifactsFrame(payload: ArtifactsBusPayload, project?: string): RunArtifactsEvent {
  return {
    type: 'artifacts',
    runId: payload.runId,
    artifacts: payload.artifacts,
    truncated: payload.truncated,
    ...(project !== undefined ? { project } : {}),
  };
}
