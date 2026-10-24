import { Hono, type Context } from 'hono';
import {
  lifecycleListQuerySchema, lifecycleWorktreeParamSchema, lifecycleOperationParamSchema,
  startLifecycleRemovalInputSchema, lifecycleActionInputSchema, lifecycleOutputQuerySchema,
  lifecyclePreviewInputSchema,
} from '@open-mercato/cezar-contract';
import type { LifecycleOperationView, WorktreeLifecycleSummary } from '@open-mercato/cezar-contract';
import { principalOf } from '../auth/guard.ts';
import { projectsRuns, runViewScopes, visibleTaskTitle } from '../auth/run-projection.ts';
import type { RunStore } from '../runs/store.ts';
import { LifecycleNotFound } from '../worktree-lifecycle/coordinator.ts';
import { LifecycleTemplateError } from '../worktree-lifecycle/templates.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';

type ProjectApiEnv = { Variables: { project: ProjectContext } };

/**
 * A lifecycle view as a token without `runs.transcript` sees it (spec 2026-10-24-cezar-mcp-server
 * §4): states and stages — never a rendered command, a script's failure text, or a dispatched
 * child's title, which its parent agent wrote.
 */
function projectOperation(operation: LifecycleOperationView): LifecycleOperationView {
  const { error, ...rest } = operation;
  return {
    ...rest,
    ...(error !== undefined ? { error: operation.failureStage ? `lifecycle failed at ${operation.failureStage}` : 'lifecycle failed' } : {}),
    history: operation.history.map(({ reason: _reason, commandPreview: _command, ...execution }) => execution),
    entries: operation.entries.map(({ commandPreview: _command, ...entry }) => entry),
  };
}

function projectSummary<T extends WorktreeLifecycleSummary>(summary: T, store: RunStore): T {
  const run = summary.task ? store.getRun(summary.task.id) : undefined;
  return {
    ...summary,
    ...(summary.task && run ? { task: { ...summary.task, title: visibleTaskTitle(run, summary.task.title, true) } } : {}),
    ...(summary.operation ? { operation: projectOperation(summary.operation) } : {}),
  };
}

const projectedFor = (c: Context) => projectsRuns(runViewScopes(principalOf(c)));

export function lifecycleError(c: Context, error: unknown) {
  const status = error instanceof LifecycleNotFound ? 404 : error instanceof LifecycleTemplateError ? 400 : 409;
  return c.json({ error: error instanceof Error ? error.message : 'Worktree lifecycle operation could not be completed' }, status);
}

/** One chained family: validated inputs and exact response inference survive both mounts.
 *  `stopTaskProcesses`: a task's shells must not outlive the directory teardown removes (spec 2026-10-07-task-workspace §6). */
export function worktreeLifecycleRoutes(opts: { stopTaskProcesses?: (runId: string) => void } = {}) {
  return new Hono<ProjectApiEnv>()
    .get('/worktree-lifecycle', queryZodValidator(lifecycleListQuerySchema), async c => {
      try {
        const { manager, store } = c.get('project');
        const listed = await manager.lifecycle.list(c.req.valid('query'));
        return c.json(projectedFor(c) ? { ...listed, worktrees: listed.worktrees.map((summary) => projectSummary(summary, store)) } : listed);
      }
      catch (error) { return lifecycleError(c, error); }
    })
    .post('/worktree-lifecycle/preview', jsonZodValidator(lifecyclePreviewInputSchema), async c => {
      try { return c.json(await c.get('project').manager.lifecycle.preview(c.req.valid('json'))); }
      catch (error) { return lifecycleError(c, error); }
    })
    .post('/worktree-lifecycle/operations', jsonZodValidator(startLifecycleRemovalInputSchema), async c => {
      const input = c.req.valid('json');
      try {
        const operation = await c.get('project').manager.lifecycle.startRemoval(input);
        if ('runId' in input) opts.stopTaskProcesses?.(input.runId);
        return c.json({ operation }, 202);
      }
      catch (error) { return lifecycleError(c, error); }
    })
    .get('/worktree-lifecycle/operations/:operationId', paramZodValidator(lifecycleOperationParamSchema), async c => {
      try {
        const operation = await c.get('project').manager.lifecycle.operation(c.req.valid('param').operationId);
        return c.json({ operation: projectedFor(c) ? projectOperation(operation) : operation });
      }
      catch (error) { return lifecycleError(c, error); }
    })
    .post('/worktree-lifecycle/operations/:operationId/actions', paramZodValidator(lifecycleOperationParamSchema), jsonZodValidator(lifecycleActionInputSchema), async c => {
      try { return c.json({ operation: await c.get('project').manager.lifecycle.action(c.req.valid('param').operationId, c.req.valid('json')) }, 202); }
      catch (error) { return lifecycleError(c, error); }
    })
    .get('/worktree-lifecycle/operations/:operationId/output', paramZodValidator(lifecycleOperationParamSchema), queryZodValidator(lifecycleOutputQuerySchema), async c => {
      const lifecycle = c.get('project').manager.lifecycle;
      try {
        const { operationId } = c.req.valid('param');
        await lifecycle.operation(operationId); // Unknown IDs must not look like empty output.
        return c.json(await lifecycle.output(operationId, c.req.valid('query')));
      } catch (error) { return lifecycleError(c, error); }
    })
    .get('/worktree-lifecycle/:worktreeId', paramZodValidator(lifecycleWorktreeParamSchema), async c => {
      try {
        const { manager, store } = c.get('project');
        const worktree = await manager.lifecycle.detail(c.req.valid('param').worktreeId);
        return c.json({ worktree: projectedFor(c) ? { ...projectSummary(worktree, store), history: worktree.history.map(projectOperation) } : worktree });
      }
      catch (error) { return lifecycleError(c, error); }
    });
}
