/**
 * The impact renderer (spec 2026-10-22-html-artifacts-and-impact, Q7 / R1): a validated review
 * model into the self-contained `template.html` report. The template is a build asset copied
 * beside this module (`scripts/copy-assets.mjs`), so `src/` and `dist/` resolve it the same way.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ReviewModel } from './model.ts';
import { validateReview, type ReviewIssue } from './validate.ts';

export const TEMPLATE_URL = new URL('./template.html', import.meta.url);
export const DEMO_REVIEW_URL = new URL('./demo-review.json', import.meta.url);

let cachedTemplate: string | undefined;
export function loadTemplate(): string {
  cachedTemplate ??= readFileSync(TEMPLATE_URL, 'utf8');
  return cachedTemplate;
}

export function loadDemoReview(): unknown {
  return JSON.parse(readFileSync(DEMO_REVIEW_URL, 'utf8'));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Script data must not terminate its script element or smuggle markup (render_cockpit.py). */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function modelDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Render an ALREADY VALIDATED model (`validateReview(...).model`). One regex pass with a
 * replacer function: sequential `String.replace` calls would let a title containing
 * `__REVIEW_DATA__` be substituted twice, and a string replacement would expand `$&`.
 */
export function renderImpact(model: ReviewModel, template: string = loadTemplate()): string {
  const payload = embedJson(model);
  const spec = model.meta.subject_kind === 'spec';
  const values: Record<string, string> = {
    REVIEW_TITLE: escapeHtml(model.meta.title),
    REVIEW_DATA: payload,
    MODEL_DIGEST: modelDigest(payload),
    SUBJECT_KIND: model.meta.subject_kind,
    BEFORE_LABEL: spec ? 'Today' : 'Before',
    AFTER_LABEL: spec ? 'Proposed' : 'After',
  };
  return template.replace(/__(REVIEW_TITLE|REVIEW_DATA|MODEL_DIGEST|SUBJECT_KIND|BEFORE_LABEL|AFTER_LABEL)__/g, (_, key: string) => values[key] ?? '');
}

export type ReviewRender =
  | { ok: true; html: string; model: ReviewModel }
  | { ok: false; issues: ReviewIssue[] };

/** Validate, then render. No HTML is ever produced from an invalid model. */
export function renderReview(input: unknown): ReviewRender {
  const result = validateReview(input);
  if (!result.ok) return result;
  return { ok: true, html: renderImpact(result.model), model: result.model };
}
