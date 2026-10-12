import { z } from 'zod';

import { detectedUrlSchema } from './terminal.ts';

/**
 * Project services (spec `2026-10-11-project-services`): the long-lived commands that make up a
 * project's stack — dev servers, `docker compose up`, `stripe listen` — pinned once and started,
 * stopped and read from the cockpit. Each running service is one PTY session.
 */

/** A pinned service: a command and where to run it. `cwd` is repo-relative, `''` for the root. */
export const servicePinSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
});
export type ServicePin = z.infer<typeof servicePinSchema>;

/**
 * `stopped`: never started, or stopped by the user. `running`: the process is alive — nothing
 * more is claimed (no health probe, spec §3.4). `exited`: it ended on its own, or could not
 * start; `exitCode` or `reason` says which.
 */
export const SERVICE_STATUSES = ['stopped', 'running', 'exited'] as const;
export const serviceStatusSchema = z.enum(SERVICE_STATUSES);
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const serviceSchema = servicePinSchema.extend({
  status: serviceStatusSchema,
  exitCode: z.number().int().nullable(),
  /** Why a start failed, when it did. */
  reason: z.string().nullable(),
  startedAt: z.string().nullable(),
  /** Addresses the service printed, each probed for a listener. */
  urls: z.array(detectedUrlSchema),
  /** The WebSocket topic that wakes on new output while running; `null` otherwise. */
  topic: z.string().nullable(),
});
export type Service = z.infer<typeof serviceSchema>;

/** A command the repository suggests. Pinning one copies it. */
export const serviceCandidateSchema = z.object({
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  /** The file it came from, repo-relative. */
  source: z.string(),
  /** The script's own text, when the source records one. */
  detail: z.string().nullable(),
  /** A script named like a long-lived process (`dev`, `start`, `serve`, `watch`, `worker`). */
  primary: z.boolean(),
  /** Why it cannot be started here (`docker` not on PATH), or `null`. */
  unavailable: z.string().nullable(),
});
export type ServiceCandidate = z.infer<typeof serviceCandidateSchema>;

/**
 * `GET /services`. `available` answers both gates at once, as the terminal's does: the policy
 * (`capabilities.terminal`) and the platform (the PTY binding). `lastRunning` are the pins that
 * were running when cezar last stopped — offered as "Resume", never started on their own.
 */
export const servicesStateSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  services: z.array(serviceSchema),
  candidates: z.array(serviceCandidateSchema),
  lastRunning: z.array(z.string()),
  /** Wakes on any state change, carrying a bare version counter. */
  topic: z.string(),
});
export type ServicesState = z.infer<typeof servicesStateSchema>;

const nameSchema = z.string().trim().min(1).max(80);
const commandSchema = z.string().trim().min(1).max(2_000).refine((value) => !/[\r\n\0]/.test(value), 'a command is one line');
/** Repo-relative, `/`-separated, no `..`; `''` is the repository root. */
const cwdSchema = z.string().max(512).refine(
  (value) => value === '' || (!value.startsWith('/') && !/[\\\0\r\n]/.test(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')),
  'cwd is a path inside the repository',
);

export const servicePinInputSchema = z.object({ name: nameSchema, command: commandSchema, cwd: cwdSchema });
export type ServicePinInput = z.infer<typeof servicePinInputSchema>;

export const servicePatchSchema = z.object({
  name: nameSchema.optional(),
  command: commandSchema.optional(),
  cwd: cwdSchema.optional(),
});
export type ServicePatch = z.infer<typeof servicePatchSchema>;

export const serviceParamsSchema = z.object({ id: z.string().min(1).max(64) });
export type ServiceParams = z.infer<typeof serviceParamsSchema>;

export const serviceLogsQuerySchema = z.object({ tail: z.coerce.number().int().min(1).max(5_000).optional() });
export type ServiceLogsQuery = z.infer<typeof serviceLogsQuerySchema>;

/** `GET /services/:id/logs`: the last lines as plain text, escape sequences removed. */
export const serviceLogsSchema = z.object({
  name: z.string(),
  status: serviceStatusSchema,
  exitCode: z.number().int().nullable(),
  logs: z.string(),
});
export type ServiceLogs = z.infer<typeof serviceLogsSchema>;

export const servicesErrorSchema = z.object({ error: z.string() }).strict();
export type ServicesErrorResponse = z.infer<typeof servicesErrorSchema>;
