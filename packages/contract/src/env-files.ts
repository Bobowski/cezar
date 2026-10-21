import { z } from 'zod';

/**
 * The project's env files, edited from the cockpit (spec `2026-10-12-project-env-files`).
 *
 * An env file is the project's own gitignored `.env` / `.env.<name>` in the main checkout — one
 * per service of a monorepo. cezar keeps no copy: the file on disk is the state, and
 * `worktree-env.ts` is what carries it into a task's worktree.
 */

/** An env file is text a human edits; a cockpit form is not how a megabyte gets there. */
export const ENV_FILE_MAX_BYTES = 256 * 1024;

const REFUSED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** Whether `name` is an env file's name: `.env`, or `.env.<anything>`. */
export function isEnvFileName(name: string): boolean {
  return name === '.env' || (name.startsWith('.env.') && name.length > 5);
}

/** Why `path` cannot name an env file, or `null` when it can. One rule for route, store and form. */
export function envFilePathIssue(path: string): string | null {
  if (path === '' || path.length > 512) return 'a path is 1–512 characters';
  if (/[\\\0\r\n]/.test(path)) return 'a path uses forward slashes and is one line';
  if (path.startsWith('/')) return 'a path is relative to the repository root';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'a path has no empty, "." or ".." segments';
  }
  if (segments.some((segment) => REFUSED_SEGMENTS.has(segment))) return 'a path does not go through .git or node_modules';
  if (!isEnvFileName(segments[segments.length - 1] as string)) return 'the file is named .env or .env.<name>';
  return null;
}

export const envFilePathSchema = z.string().superRefine((path, ctx) => {
  const issue = envFilePathIssue(path);
  if (issue) ctx.addIssue({ code: 'custom', message: issue });
});

/** One env file as the listing describes it: where it is and which names it sets — never a value. */
export const envFileEntrySchema = z.object({
  /** Repo-relative, `/`-separated. */
  path: z.string(),
  exists: z.boolean(),
  /** The variable names the file sets, in file order. */
  variables: z.array(z.string()),
  /** The tracked example this file is a copy of (`.env.example` beside it), or `null`. */
  template: z.string().nullable(),
  /** Names the template sets and the file does not. Empty when there is no template. */
  missing: z.array(z.string()),
  updatedAt: z.string().nullable(),
});
export type EnvFileEntry = z.infer<typeof envFileEntrySchema>;

/**
 * `GET /env-files`. `files` are the env files that exist plus the ones a tracked example asks
 * for; `suggestions` are paths the project's layout makes likely (`<package>/.env`) that have
 * neither. `editable` is false when this cockpit will not read or write contents.
 */
export const envFilesListSchema = z.object({
  editable: z.boolean(),
  files: z.array(envFileEntrySchema),
  suggestions: z.array(z.string()),
});
export type EnvFilesList = z.infer<typeof envFilesListSchema>;

export const envFileQuerySchema = z.object({ path: envFilePathSchema });
export type EnvFileQuery = z.infer<typeof envFileQuerySchema>;

/**
 * `GET /env-files/content` and the answer to a save. `version` is a hash of the bytes on disk,
 * `null` for a file that does not exist yet; `template` is the tracked example's text, so a new
 * file can start from it.
 */
export const envFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  version: z.string().nullable(),
  template: z.string().nullable(),
});
export type EnvFileContent = z.infer<typeof envFileContentSchema>;

/**
 * `PUT /env-files`. `version` is what the editor loaded (`null` = "I created this"); a save over
 * a file that changed since is refused rather than merged.
 */
export const setEnvFileSchema = z.object({
  path: envFilePathSchema,
  content: z.string(),
  version: z.string().nullable(),
});
export type SetEnvFileInput = z.infer<typeof setEnvFileSchema>;

/**
 * `POST /env-files/render` (spec 2026-10-21-env-references §5): what `content` would become in
 * the main checkout, or — with `runId` — in that task's worktree. Nothing is written. `values`
 * are the rendered values of the file's `#cezar` directives, in file order; `slot` is the task's
 * slot (`null` for the main checkout, or a task that holds none).
 */
export const renderEnvFileSchema = z.object({
  path: envFilePathSchema,
  content: z.string().max(ENV_FILE_MAX_BYTES),
  runId: z.string().min(1).max(64).optional(),
});
export type RenderEnvFileInput = z.infer<typeof renderEnvFileSchema>;

export const envFileRenderSchema = z.object({
  rendered: z.string(),
  values: z.array(z.object({ key: z.string(), value: z.string() })),
  slot: z.number().int().nullable(),
});
export type EnvFileRender = z.infer<typeof envFileRenderSchema>;

export const envFilesErrorSchema = z.object({ error: z.string() }).strict();
export type EnvFilesErrorResponse = z.infer<typeof envFilesErrorSchema>;
