import { DRAFT_TEXT_MAX, designPickSchema, type DesignDraftPick } from '@open-mercato/cezar-contract';
import { readRunDraftSurface, writeRunDraftSurface } from './drafts.ts';

/**
 * Design notes with no task behind them yet (spec `2026-10-24-design-mode-third-cut` §3.2): the
 * Code page's Browser with no task chosen collects notes here until **Start task with N notes**.
 *
 * Kept in the project's own draft store, on the same `design-picks` surface and in the same
 * `[{ pick, text }]` form a task's drafts use, under a reserved id no run can have (run ids are
 * uuids) — so the store's atomic writes, size ceiling and "an empty write deletes" rule apply
 * unchanged, and nothing new has to be gitignored.
 */
export const PROJECT_DRAFTS_ID = '_project';
const SURFACE = 'design-picks';

/** What is collected, oldest first. Unreadable entries drop out one by one; never throws. */
export function readProjectDesignDrafts(dataDir: string): DesignDraftPick[] {
  const text = readRunDraftSurface(dataDir, PROJECT_DRAFTS_ID, SURFACE)?.text ?? '';
  if (text === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: DesignDraftPick[] = [];
  for (const item of raw as unknown[]) {
    const entry = (item ?? {}) as { pick?: unknown; text?: unknown };
    const pick = designPickSchema.safeParse(entry.pick);
    if (!pick.success) continue;
    out.push({ ...pick.data, note: typeof entry.text === 'string' ? entry.text.slice(0, 20_000) : '' });
  }
  return out;
}

/** Replace them. An empty list deletes the surface. */
export function writeProjectDesignDrafts(
  dataDir: string,
  picks: readonly DesignDraftPick[],
): { ok: true } | { ok: false; error: string } {
  const text = picks.length === 0 ? '' : JSON.stringify(picks.map(({ note, ...pick }) => ({ pick, text: note })));
  if (text.length > DRAFT_TEXT_MAX) return { ok: false, error: 'too many notes to keep — start a task with some of them first' };
  const result = writeRunDraftSurface(dataDir, PROJECT_DRAFTS_ID, SURFACE, { text, images: [] });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
