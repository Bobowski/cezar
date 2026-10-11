import { createHash } from 'node:crypto';
import type { TrackerAssociation, TrackerItem, TrackerLink } from '@open-mercato/cezar-contract';

/** Bounded like every other vendor string a run record keeps. */
const TITLE_CAP = 500;

/** What a run started from; comparing it later says whether the ticket moved on. Not a security property. */
export function trackerContentHash(item: Pick<TrackerItem, 'title' | 'body'>): string {
  return createHash('sha256').update(JSON.stringify([item.title, item.body])).digest('hex');
}

/**
 * A run's link to a ticket, built from the project's SAVED association — never from anything the
 * client named. `item` is the server's own read: without it the link still stands (the vendor
 * being down must not cost the run its provenance), it just carries no title, URL or snapshot.
 */
export function buildTrackerLink(
  association: TrackerAssociation,
  itemId: string,
  origin: TrackerLink['origin'],
  item?: TrackerItem,
  now: Date = new Date(),
): TrackerLink {
  const at = now.toISOString();
  return {
    provider: association.kind,
    sourceId: association.source.id,
    scopeId: association.externalId,
    itemId: item?.id ?? itemId,
    origin,
    linkedAt: at,
    ...(item
      ? {
          title: item.title.slice(0, TITLE_CAP),
          url: item.url,
          snapshot: {
            status: item.status,
            statusCategory: item.statusCategory,
            updatedAt: item.updatedAt,
            contentHash: trackerContentHash(item),
            syncedAt: at,
          },
        }
      : {}),
  };
}

/** The fields of a run record a link can be read or derived from. */
type LinkedRun = {
  trackerLinks?: TrackerLink[];
  createdAt?: string;
  automationTracker?: { provider: 'jira' | 'linear'; key: string; url: string; association?: TrackerAssociation };
};

/**
 * A run's ticket links, the one reader for them. A task launched by a tracker automation before
 * `trackerLinks` existed recorded its ticket as `automationTracker` only; it is folded into one
 * derived link here, on the way out, and never written back — run state does not migrate.
 * A legacy record without the association snapshot cannot be placed in a source and yields none.
 */
export function runTrackerLinks(run: LinkedRun): TrackerLink[] {
  if (run.trackerLinks?.length) return run.trackerLinks;
  const legacy = run.automationTracker;
  if (!legacy?.association) return [];
  return [{
    provider: legacy.provider,
    sourceId: legacy.association.source.id,
    scopeId: legacy.association.externalId,
    itemId: legacy.key,
    origin: 'automation',
    linkedAt: run.createdAt && !Number.isNaN(Date.parse(run.createdAt)) ? new Date(run.createdAt).toISOString() : new Date(0).toISOString(),
    ...(/^https:\/\//.test(legacy.url) ? { url: legacy.url } : {}),
  }];
}

/**
 * A link recorded while the vendor was not answering has a key and nothing else. The first later
 * read of that ticket gives it its title and URL. Not a `snapshot`: what this read shows is the
 * ticket now, not what the task started from, so it lands in `latest`.
 */
export function enrichTrackerLink(link: TrackerLink, item: TrackerItem, now: Date = new Date()): TrackerLink {
  if (link.url && link.title !== undefined) return link;
  return {
    ...link,
    title: link.title ?? item.title.slice(0, TITLE_CAP),
    url: link.url ?? item.url,
    latest: link.latest ?? { status: item.status, statusCategory: item.statusCategory, syncedAt: now.toISOString() },
  };
}

/**
 * What to tell a task that is being continued about its ticket (spec § Phase 4), and the link as
 * it should be stored afterwards. Compared against what the task was last told — its start
 * snapshot, or the last note — so one change is announced once. No note when nothing the task
 * knows about differs, or when the task never had a snapshot to differ from.
 */
export function ticketChangeSince(link: TrackerLink, item: TrackerItem, now: Date = new Date()): { note?: string; link: TrackerLink } {
  const hash = trackerContentHash(item);
  const at = now.toISOString();
  // Against what the TASK was last told (its start snapshot, or the last note), never against
  // `latest`: a status moved in the cockpit is known there at once and is still news to the task.
  const known = link.noted ?? link.snapshot;
  const next: TrackerLink = { ...link, latest: { status: item.status, statusCategory: item.statusCategory, syncedAt: at } };
  if (!known) return { link: next };
  const changes: string[] = [];
  if (known.contentHash !== hash) changes.push('its title or description changed');
  if (known.status !== item.status) changes.push(`its status went from "${known.status}" to "${item.status}"`);
  if (changes.length === 0) return { link: next };
  return {
    link: { ...next, noted: { status: item.status, contentHash: hash, at } },
    note: `[cezar] The tracker ticket ${item.id} linked to this task changed since you last saw it: ${changes.join(', and ')}. The ticket text in this task is the older snapshot — re-read the ticket before relying on it.`,
  };
}
