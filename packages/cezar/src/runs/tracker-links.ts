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
