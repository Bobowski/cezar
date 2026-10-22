import { describe, expect, it } from 'vitest';
import { artifactsCdnEnabled, artifactsPromptPart } from './artifacts.ts';

describe('the artifacts prompt line (O3)', () => {
  it('names the directory and the CDN rule by default', () => {
    const line = artifactsPromptPart('/data/artifacts/r1', true);
    expect(line).toContain('`/data/artifacts/r1`');
    expect(line).toContain('cdnjs, jsDelivr or unpkg with an exact pinned version');
    expect(line).toContain('no fetch/XHR to any host');
  });
  it('asks for everything inline with CEZ_ARTIFACTS_CDN=0', () => {
    expect(artifactsCdnEnabled({ CEZ_ARTIFACTS_CDN: '0' })).toBe(false);
    expect(artifactsCdnEnabled({})).toBe(true);
    const line = artifactsPromptPart('/d', false);
    expect(line).toContain('Inline every script and style');
    expect(line).not.toContain('cdnjs');
  });
});
