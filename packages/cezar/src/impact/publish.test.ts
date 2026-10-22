import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanArtifacts } from '../runs/artifacts.ts';
import { runImpactCommand } from './impact-cli.ts';
import { backstopRender, IMPACT_ERRORS, IMPACT_HTML, publishImpact, REVIEW_JSON } from './publish.ts';

/**
 * The backstop render and report versions (spec 2026-10-22-html-artifacts-and-impact, Backstop +
 * R4). Guards first: an invalid model never replaces a good report, and every render keeps the
 * previous one.
 */

const demoText = readFileSync(new URL('./demo-review.json', import.meta.url), 'utf8');
const demo = () => JSON.parse(demoText) as { meta: { title: string }; capabilities: Array<{ evidence: string[] }> };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-impact-publish-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (name: string) => readFileSync(join(dir, name), 'utf8');
/** Age a file so a later write is unambiguously newer, whatever the filesystem's mtime grain. */
const age = (name: string, seconds = 60) => {
  const at = new Date(Date.now() - seconds * 1000);
  utimesSync(join(dir, name), at, at);
};

describe('backstopRender — guards', () => {
  it('never overwrites a good impact.html with an invalid model, and reports why', async () => {
    writeFileSync(join(dir, REVIEW_JSON), demoText);
    expect(await backstopRender(dir)).toBe('rendered');
    const good = read(IMPACT_HTML);
    age(IMPACT_HTML);
    const broken = demo();
    broken.capabilities[0]!.evidence = ['missing'];
    writeFileSync(join(dir, REVIEW_JSON), JSON.stringify(broken));
    expect(await backstopRender(dir)).toBe('invalid');
    expect(read(IMPACT_HTML)).toBe(good);
    expect(read(IMPACT_ERRORS)).toContain('capabilities[0].evidence[0]: unresolved evidence missing');
    // No version is cut for an invalid revision.
    expect((await scanArtifacts(dir)).versions?.map((v) => v.version)).toEqual([1]);
  });

  it('non-JSON is an errors file, not a crash and not a report', async () => {
    writeFileSync(join(dir, REVIEW_JSON), '{ nope');
    expect(await backstopRender(dir)).toBe('invalid');
    expect(existsSync(join(dir, IMPACT_HTML))).toBe(false);
    expect(read(IMPACT_ERRORS)).toMatch(/^review\.json: not valid JSON/);
  });

  it('a symlinked review.json is ignored', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'cez-impact-outside-')), 'review.json');
    writeFileSync(outside, demoText);
    symlinkSync(outside, join(dir, REVIEW_JSON));
    expect(await backstopRender(dir)).toBe('skipped');
    expect(existsSync(join(dir, IMPACT_HTML))).toBe(false);
    rmSync(join(outside, '..'), { recursive: true, force: true });
  });

  it('leaves a fresh report alone, and reports one invalid revision once', async () => {
    expect(await backstopRender(dir)).toBe('skipped'); // no review.json at all
    writeFileSync(join(dir, REVIEW_JSON), demoText);
    age(REVIEW_JSON);
    writeFileSync(join(dir, IMPACT_HTML), '<p>agent rendered</p>');
    expect(await backstopRender(dir)).toBe('skipped');
    expect(read(IMPACT_HTML)).toBe('<p>agent rendered</p>');

    rmSync(join(dir, IMPACT_HTML));
    writeFileSync(join(dir, REVIEW_JSON), '[]');
    age(REVIEW_JSON);
    expect(await backstopRender(dir)).toBe('invalid');
    expect(await backstopRender(dir)).toBe('skipped'); // errors file is newer than the model
  });
});

describe('versions', () => {
  it('every render keeps its report and model under .versions/<n>; the newest is current', async () => {
    writeFileSync(join(dir, REVIEW_JSON), demoText);
    expect(await backstopRender(dir)).toBe('rendered');
    const first = read(IMPACT_HTML);
    age(IMPACT_HTML);
    const revised = demo();
    revised.meta.title = 'Revised title';
    writeFileSync(join(dir, REVIEW_JSON), JSON.stringify(revised));
    writeFileSync(join(dir, IMPACT_ERRORS), 'stale');
    age(IMPACT_ERRORS, 120);
    expect(await backstopRender(dir)).toBe('rendered');
    expect(read(IMPACT_HTML)).toContain('Revised title');
    expect(read('.versions/1/impact.html')).toBe(first);
    expect(read('.versions/1/review.json')).toBe(demoText);
    expect(read('.versions/2/impact.html')).toBe(read(IMPACT_HTML));
    expect(existsSync(join(dir, IMPACT_ERRORS))).toBe(false);
    const listing = await scanArtifacts(dir);
    expect(listing.versions?.map((v) => [v.version, v.files])).toEqual([
      [1, ['impact.html', 'review.json']],
      [2, ['impact.html', 'review.json']],
    ]);
    // The dot directory never shows as an artifact.
    expect(listing.artifacts.map((a) => a.name).sort()).toEqual(['impact.html', 'review.json']);
  });

  it('never writes through a planted .versions symlink', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cez-impact-elsewhere-'));
    symlinkSync(elsewhere, join(dir, '.versions'));
    expect(await publishImpact(dir, '<p>r</p>', '{}')).toEqual({ version: 1 });
    expect(existsSync(join(elsewhere, '1'))).toBe(false);
    expect(read('.versions/1/impact.html')).toBe('<p>r</p>');
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('a report that predates versioning is archived before the first versioned render', async () => {
    writeFileSync(join(dir, IMPACT_HTML), '<p>legacy</p>');
    expect(await publishImpact(dir, '<p>new</p>', '{}')).toEqual({ version: 2 });
    expect(read('.versions/1/impact.html')).toBe('<p>legacy</p>');
    expect(read(IMPACT_HTML)).toBe('<p>new</p>');
  });

  it('`cez impact render` cuts versions through the same helper as the backstop', async () => {
    const ctx = { cwd: dir, env: { CEZ_ARTIFACTS_DIR: dir }, log: () => {}, error: () => {} };
    writeFileSync(join(dir, REVIEW_JSON), demoText);
    expect(await runImpactCommand(['render'], ctx)).toBe(0);
    expect(await runImpactCommand(['render'], ctx)).toBe(0);
    // The CLI's fresh report satisfies the backstop: nothing re-rendered at turn end.
    expect(await backstopRender(dir)).toBe('skipped');
    expect((await scanArtifacts(dir)).versions?.map((v) => v.version)).toEqual([1, 2]);
    // `--out` elsewhere and `--demo` are not the run's report: no versions there.
    mkdirSync(join(dir, 'x'));
    expect(await runImpactCommand(['render', '--demo', '--out', 'x/demo.html'], ctx)).toBe(0);
    expect(existsSync(join(dir, 'x/.versions'))).toBe(false);
  });
});
