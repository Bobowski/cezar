/**
 * The generic artifacts layer (spec `.ai/specs/2026-10-22-html-artifacts-and-impact.md`):
 * telling the agent about its run's artifacts directory.
 */

/** `CEZ_ARTIFACTS_CDN=0` closes the CDN script allowlist (owner decision O1: default on). */
export function artifactsCdnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_ARTIFACTS_CDN !== '0';
}

/** The one system-prompt line every agent step carries (O3). */
export function artifactsPromptPart(dir: string, cdnEnabled = artifactsCdnEnabled()): string {
  const network = cdnEnabled
    ? 'Scripts may load only from cdnjs, jsDelivr or unpkg with an exact pinned version; no fetch/XHR to any host.'
    : 'Inline every script and style — no external URL loads; no fetch/XHR to any host.';
  return `To show the user a page or report, write it as a single HTML (or .md/.png) file into \`${dir}\` (also $CEZ_ARTIFACTS_DIR); it appears live in the cockpit's Assets view. ${network}`;
}
