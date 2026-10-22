import { z } from 'zod';

/**
 * Run artifacts (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md`): the files an agent
 * writes into `.ai/cezar/artifacts/<runId>/` for the user to see in the task's Assets view.
 */

export const runArtifactKindSchema = z.enum(['html', 'markdown', 'image', 'json', 'other']);
export type RunArtifactKind = z.infer<typeof runArtifactKindSchema>;

export const runArtifactSchema = z.object({
  /** File name — also the URL segment of `GET /runs/:id/artifacts/:name`. */
  name: z.string(),
  kind: runArtifactKindSchema,
  /** HTML `<title>` (first 8 KB) or the first `# ` heading. */
  title: z.string().optional(),
  size: z.number().int(),
  /** mtime, ISO-8601. */
  updatedAt: z.string(),
});
export type RunArtifact = z.infer<typeof runArtifactSchema>;

/** `GET /runs/:id/artifacts`. `truncated`: the directory held more than the 64-file cap. */
export const runArtifactsResponseSchema = z.object({
  artifacts: z.array(runArtifactSchema),
  truncated: z.boolean(),
});
export type RunArtifactsResponse = z.infer<typeof runArtifactsResponseSchema>;

/** The `:name` segment: one flat file name, never a path. */
export const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const artifactNameParamSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().regex(ARTIFACT_NAME_RE),
});
export type ArtifactNameParam = z.infer<typeof artifactNameParamSchema>;

/**
 * The `artifacts` SSE frame, on `/api/v1/events` and `/api/v1/workspace/events` (where `project`
 * is stamped). Sent when a run's listing changed; carries the whole listing, so a client replaces
 * its cached `GET /runs/:id/artifacts` answer rather than merging.
 */
export const runArtifactsEventSchema = runArtifactsResponseSchema.extend({
  type: z.literal('artifacts'),
  runId: z.string(),
  project: z.string().optional(),
});
export type RunArtifactsEvent = z.infer<typeof runArtifactsEventSchema>;

/** What an impact run assessed (spec Q10, Phase 2). Pinned so the cockpit can call it stale. */
export const runSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr'), number: z.number().int().positive(), headSha: z.string() }),
  z.object({ kind: z.literal('spec'), path: z.string(), blobSha: z.string() }),
]);
export type RunSubject = z.infer<typeof runSubjectSchema>;
