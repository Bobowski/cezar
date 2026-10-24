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
  /**
   * Whether `dir` is still on disk (spec `2026-10-23-docker-management` §3.6): `unknown` when there
   * is no dir or it is a path this host cannot judge (a WSL path seen from Windows).
   */
  dirState: z.enum(['exists', 'gone', 'unknown']),
  /** The cezar task whose worktree `dir` is, when it is one; `active` while it is running or queued. */
  task: z.object({ id: z.string(), title: z.string(), status: z.string(), active: z.boolean() }).nullable(),
  /** The volumes its compose labels name — what `down --volumes` deletes. */
  volumes: z.array(z.string()),
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

/*
 * Docker management (spec `2026-10-23-docker-management`): images, volumes, stack teardown, logs,
 * disk usage and Reclaim. Removal goes as far as Docker Desktop's — the cockpit warns about what is
 * in use and by which task; it never refuses.
 */

/** A container that uses an image or mounts a volume. */
export const dockerUserSchema = z.object({ id: z.string(), name: z.string(), running: z.boolean() });
export type DockerUser = z.infer<typeof dockerUserSchema>;

/** One image, every repo:tag that names it folded into `tags`. `id` is the hex digest without `sha256:`. */
export const dockerImageSchema = z.object({
  id: z.string(),
  /** `repo:tag`; empty for a dangling image. */
  tags: z.array(z.string()),
  sizeBytes: z.number(),
  /** Docker's own words (`2024-05-01 10:00:00 +0000 UTC`). */
  created: z.string(),
  dangling: z.boolean(),
  usedBy: z.array(dockerUserSchema),
});
export type DockerImage = z.infer<typeof dockerImageSchema>;

export const dockerImagesSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  images: z.array(dockerImageSchema),
});
export type DockerImages = z.infer<typeof dockerImagesSchema>;

export const dockerVolumeSchema = z.object({
  name: z.string(),
  driver: z.string(),
  /** From `docker system df -v`; `null` when Docker did not say. */
  sizeBytes: z.number().nullable(),
  /** The compose project its labels name, or `null` for a volume made on its own. */
  stack: z.string().nullable(),
  /** The cezar project that stack belongs to, resolved like a container's. */
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  mine: z.boolean(),
  usedBy: z.array(dockerUserSchema),
});
export type DockerVolume = z.infer<typeof dockerVolumeSchema>;

export const dockerVolumesSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  volumes: z.array(dockerVolumeSchema),
});
export type DockerVolumes = z.infer<typeof dockerVolumesSchema>;

/** Above this share of the daemon's data root in use, the disk line wears a warning. */
export const DOCKER_DISK_WARN_PCT = 85;

export const dockerDiskKindSchema = z.enum(['images', 'containers', 'volumes', 'build-cache']);
export type DockerDiskKind = z.infer<typeof dockerDiskKindSchema>;

export const dockerDiskEntrySchema = z.object({
  kind: dockerDiskKindSchema,
  count: z.number().int(),
  active: z.number().int(),
  totalBytes: z.number(),
  reclaimableBytes: z.number(),
});
export type DockerDiskEntry = z.infer<typeof dockerDiskEntrySchema>;

export const dockerDataRootSchema = z.object({
  path: z.string(),
  sizeBytes: z.number(),
  freeBytes: z.number(),
  usedPct: z.number(),
});
export type DockerDataRoot = z.infer<typeof dockerDataRootSchema>;

/** `GET /docker/disk`: `docker system df`, plus the daemon's data root when this host can see it. */
export const dockerDiskSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  entries: z.array(dockerDiskEntrySchema),
  totalBytes: z.number(),
  reclaimableBytes: z.number(),
  /** `null` when the data root is not on this filesystem (Docker Desktop keeps it in a VM). */
  dataRoot: dockerDataRootSchema.nullable(),
  /** `dataRoot.usedPct` is above `DOCKER_DISK_WARN_PCT`. */
  warning: z.boolean(),
});
export type DockerDisk = z.infer<typeof dockerDiskSchema>;

/** One line of the Reclaim dialog — what `POST /docker/reclaim` is asked to do. */
export const dockerReclaimStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dangling-images') }).strict(),
  z.object({ kind: z.literal('build-cache') }).strict(),
  /** `compose down --volumes` of a stack whose working dir no longer exists. */
  z.object({ kind: z.literal('stack'), name: dockerStackParamsSchema.shape.name }).strict(),
  /** A stopped container of one of those stacks' images. */
  z.object({ kind: z.literal('container'), id: dockerContainerParamsSchema.shape.id }).strict(),
]);
export type DockerReclaimStep = z.infer<typeof dockerReclaimStepSchema>;

export const dockerReclaimItemSchema = z.object({
  step: dockerReclaimStepSchema,
  label: z.string(),
  /** What the line covers in more words (the volumes a stack takes with it), or `null`. */
  detail: z.string().nullable(),
  bytes: z.number(),
});
export type DockerReclaimItem = z.infer<typeof dockerReclaimItemSchema>;

/** `POST /docker/reclaim/plan`: exactly what Reclaim would do now, and how much each line frees. */
export const dockerReclaimPlanSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  items: z.array(dockerReclaimItemSchema),
  totalBytes: z.number(),
});
export type DockerReclaimPlan = z.infer<typeof dockerReclaimPlanSchema>;

export const dockerReclaimRequestSchema = z.object({ steps: z.array(dockerReclaimStepSchema).min(1).max(500) }).strict();
export type DockerReclaimRequest = z.infer<typeof dockerReclaimRequestSchema>;

export const dockerReclaimResultSchema = z.object({
  freedBytes: z.number(),
  /** One line per step: what ran, or why it was skipped. */
  log: z.array(z.string()),
});
export type DockerReclaimResult = z.infer<typeof dockerReclaimResultSchema>;

/** `docker volume rm` names: what Docker itself accepts. */
export const dockerVolumeParamsSchema = z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/) });
export type DockerVolumeParams = z.infer<typeof dockerVolumeParamsSchema>;

/** An image by its hex digest (without `sha256:`), short or full. */
export const dockerImageParamsSchema = z.object({ id: z.string().regex(/^[a-f0-9]{12,64}$/) });
export type DockerImageParams = z.infer<typeof dockerImageParamsSchema>;

/** `?force=1`: the confirm named what is in use — an image's running users are stopped first, a volume's users removed. */
export const dockerForceQuerySchema = z.object({ force: z.enum(['0', '1']).optional() });
export type DockerForceQuery = z.infer<typeof dockerForceQuerySchema>;

/** With `?force=1`: the containers the confirm named. A different current set is a 409, so the cockpit asks again. */
export const dockerForceBodySchema = z.object({ users: z.array(dockerContainerParamsSchema.shape.id).max(1000).optional() }).strict();
export type DockerForceBody = z.infer<typeof dockerForceBodySchema>;

export const dockerStackDownSchema = z.object({ volumes: z.boolean().optional() }).strict();
export type DockerStackDown = z.infer<typeof dockerStackDownSchema>;

export const dockerOkSchema = z.object({ ok: z.literal(true) }).strict();
export type DockerOk = z.infer<typeof dockerOkSchema>;

export const dockerLogsQuerySchema = z.object({ cursor: z.coerce.number().int().min(0).optional() });
export type DockerLogsQuery = z.infer<typeof dockerLogsQuerySchema>;

/**
 * `GET /docker/containers/:id/logs`: redacted `docker logs --follow` output since `cursor`. The
 * `docker-logs:<id>` topic carries a cursor and nothing else — log content never rides the
 * workspace bus — and a hosted cockpit, which opens no socket, polls this same read.
 */
export const dockerLogsSchema = z.object({
  data: z.string(),
  cursor: z.number().int(),
  /** The cursor was older than the retained output, so some was missed. */
  truncated: z.boolean(),
  /** `docker logs --follow` is still attached. */
  following: z.boolean(),
  topic: z.string(),
});
export type DockerLogs = z.infer<typeof dockerLogsSchema>;
