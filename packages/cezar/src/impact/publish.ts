/**
 * Where a rendered impact report lands (spec 2026-10-22-html-artifacts-and-impact, R4 versions +
 * the Backstop). ONE helper for both writers — `cez impact render` and the server's turn-end
 * backstop — so they cut versions the same way and never disagree about which report is current.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { artifactVersionDir, listArtifactVersions, MAX_ARTIFACT_BYTES, VERSIONS_DIR } from '../runs/artifacts.ts';
import { renderReview } from './render.ts';
import { formatIssue } from './validate.ts';

export const IMPACT_HTML = 'impact.html';
export const REVIEW_JSON = 'review.json';
export const IMPACT_ERRORS = 'impact.errors.txt';

/** Write via tmp + rename so a watcher never sees a half-written file. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function regularFile(path: string): { mtimeMs: number; size: number } | null {
  try {
    const info = lstatSync(path);
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null;
  } catch {
    return null;
  }
}

/**
 * Publish a rendered report into `dir`: archive it with the model it came from as the next
 * `.versions/<n>/`, then replace `impact.html` and drop a stale `impact.errors.txt`. The newest
 * version is always the current report, so the previous one is `n - 1`. A report that predates
 * versioning is archived first, so the first versioned render never loses it.
 */
export async function publishImpact(dir: string, html: string, reviewText: string): Promise<{ version: number }> {
  // Anything but a real directory at `.versions` (a planted symlink) is replaced, never followed.
  try {
    if (!lstatSync(join(dir, VERSIONS_DIR)).isDirectory()) rmSync(join(dir, VERSIONS_DIR), { force: true });
  } catch {
    // absent: created below
  }
  const versions = await listArtifactVersions(dir);
  let next = (versions.at(-1)?.version ?? 0) + 1;
  const current = join(dir, IMPACT_HTML);
  if (versions.length === 0 && regularFile(current)) {
    writeAtomic(join(artifactVersionDir(dir, next), IMPACT_HTML), readFileSync(current, 'utf8'));
    next += 1;
  }
  const vdir = artifactVersionDir(dir, next);
  writeAtomic(join(vdir, REVIEW_JSON), reviewText);
  writeAtomic(join(vdir, IMPACT_HTML), html);
  writeAtomic(current, html);
  rmSync(join(dir, IMPACT_ERRORS), { force: true });
  return { version: next };
}

export type BackstopOutcome = 'skipped' | 'rendered' | 'invalid';

/**
 * The server's backstop: when `review.json` is newer than `impact.html` (or there is none), the
 * agent did not finish `cez impact render` — validate and render it here. An invalid model writes
 * `impact.errors.txt` (once per review.json revision) and NEVER touches a good `impact.html`.
 * Never throws.
 */
export async function backstopRender(dir: string): Promise<BackstopOutcome> {
  try {
    const review = regularFile(join(dir, REVIEW_JSON));
    if (!review || review.size > MAX_ARTIFACT_BYTES) return 'skipped';
    const html = regularFile(join(dir, IMPACT_HTML));
    if (html && html.mtimeMs >= review.mtimeMs) return 'skipped';
    const errors = regularFile(join(dir, IMPACT_ERRORS));
    if (errors && errors.mtimeMs >= review.mtimeMs) return 'skipped';
    const text = readFileSync(join(dir, REVIEW_JSON), 'utf8');
    let model: unknown;
    try {
      model = JSON.parse(text);
    } catch (error) {
      writeAtomic(join(dir, IMPACT_ERRORS), `${REVIEW_JSON}: not valid JSON (${error instanceof Error ? error.message : String(error)})\n`);
      return 'invalid';
    }
    const result = renderReview(model);
    if (!result.ok) {
      writeAtomic(join(dir, IMPACT_ERRORS), `${result.issues.map(formatIssue).join('\n')}\n`);
      return 'invalid';
    }
    await publishImpact(dir, result.html, text);
    return 'rendered';
  } catch {
    return 'skipped';
  }
}

