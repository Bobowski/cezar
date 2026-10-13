import { z } from 'zod';

/**
 * The machine's Docker containers, seen from one project (spec `2026-10-13-docker-view`): which
 * stacks are up, whose they are, and which host ports this project's compose files want that
 * another stack already holds. Read from the `docker` CLI; nothing is stored.
 */

/** A container port published on the host. */
export const dockerPortSchema = z.object({
  host: z.number().int(),
  container: z.number().int(),
  protocol: z.string(),
});
export type DockerPort = z.infer<typeof dockerPortSchema>;

export const dockerContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The compose service it belongs to, or `null` for a container started on its own. */
  service: z.string().nullable(),
  image: z.string(),
  running: z.boolean(),
  /** Docker's own words (`Up 3 hours`, `Exited (0) 2 days ago`). */
  status: z.string(),
  /** Empty for a stopped container: Docker reports what is published, not what would be. */
  ports: z.array(dockerPortSchema),
});
export type DockerContainer = z.infer<typeof dockerContainerSchema>;

/** One compose project. `name` is `''` for the group of containers that belong to none. */
export const dockerStackSchema = z.object({
  name: z.string(),
  /** Where its compose file lives, as Docker recorded it. */
  dir: z.string().nullable(),
  /** The registered cezar project that directory is inside, when there is one. */
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Whether that project is the one this route was asked through. */
  mine: z.boolean(),
  containers: z.array(dockerContainerSchema),
});
export type DockerStack = z.infer<typeof dockerStackSchema>;

/** A host port this project's compose file publishes that another stack's container holds. */
export const dockerConflictSchema = z.object({
  port: z.number().int(),
  /** The compose service of THIS project that wants it, and the file that says so. */
  service: z.string(),
  file: z.string(),
  stack: z.string(),
  container: z.string(),
});
export type DockerConflict = z.infer<typeof dockerConflictSchema>;

/**
 * `GET /docker`. `available: false` covers the policy (`CEZ_TERMINAL`), a missing `docker` and a
 * daemon that is not running — `reason` says which.
 */
export const dockerStateSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  stacks: z.array(dockerStackSchema),
  conflicts: z.array(dockerConflictSchema),
  /** Wakes when the container list changes, carrying a bare version counter. */
  topic: z.string(),
});
export type DockerState = z.infer<typeof dockerStateSchema>;

/** A compose project name, as compose itself normalizes one. */
export const dockerStackParamsSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/) });
export type DockerStackParams = z.infer<typeof dockerStackParamsSchema>;

export const dockerContainerParamsSchema = z.object({ id: z.string().regex(/^[a-f0-9]{12,64}$/) });
export type DockerContainerParams = z.infer<typeof dockerContainerParamsSchema>;

export const dockerErrorSchema = z.object({ error: z.string() }).strict();
export type DockerErrorResponse = z.infer<typeof dockerErrorSchema>;
