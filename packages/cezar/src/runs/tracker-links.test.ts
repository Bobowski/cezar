import { describe, expect, it } from 'vitest';
import { trackerLinkSchema, type TrackerAssociation, type TrackerItem } from '@open-mercato/cezar-contract';
import { buildTrackerLink, enrichTrackerLink, runTrackerLinks, ticketChangeSince, trackerContentHash } from './tracker-links.ts';

const association: TrackerAssociation = {
  kind: 'jira', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'OPS',
  connectionId: '00000000-0000-4000-8000-000000000001',
};
const item: TrackerItem = {
  kind: 'issue', id: 'OPS-7', title: 'Fix sign-in', author: 'Ada', createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
  labels: [], body: 'Steps…', bodyTruncated: false, unsupportedContent: false, url: 'https://acme.atlassian.net/browse/OPS-7',
  status: 'In Progress', statusId: '3', statusCategory: 'started',
};
const now = new Date('2026-10-11T10:00:00.000Z');

describe('buildTrackerLink', () => {
  it('takes identity from the saved association and enrichment from the server read', () => {
    const link = buildTrackerLink(association, 'ops-7', 'handoff', item, now);
    expect(trackerLinkSchema.parse(link)).toEqual(link);
    expect(link).toMatchObject({
      provider: 'jira', sourceId: 'acme', scopeId: '100', itemId: 'OPS-7', origin: 'handoff', linkedAt: now.toISOString(),
      title: 'Fix sign-in', url: item.url, snapshot: { status: 'In Progress', statusCategory: 'started', updatedAt: item.updatedAt, syncedAt: now.toISOString() },
    });
    // The connection is deliberately not part of a link: a rotated token must not orphan history.
    expect(JSON.stringify(link)).not.toContain(association.connectionId!);
  });

  it('still links, without title, URL or snapshot, when the ticket could not be read', () => {
    const link = buildTrackerLink(association, 'OPS-7', 'handoff', undefined, now);
    expect(trackerLinkSchema.parse(link)).toEqual(link);
    expect(link).toEqual({ provider: 'jira', sourceId: 'acme', scopeId: '100', itemId: 'OPS-7', origin: 'handoff', linkedAt: now.toISOString() });
  });

  it('bounds a vendor title', () => {
    expect(buildTrackerLink(association, 'OPS-7', 'handoff', { ...item, title: 'x'.repeat(2_000) }, now).title).toHaveLength(500);
  });
});

describe('trackerContentHash', () => {
  it('changes with the title or the description and with nothing else', () => {
    const base = trackerContentHash(item);
    const moved: TrackerItem = { ...item, status: 'Done', updatedAt: '2026-10-01T00:00:00.000Z', labels: ['x'] };
    expect(trackerContentHash(moved)).toBe(base);
    expect(trackerContentHash({ ...item, title: 'Fix sign-in now' })).not.toBe(base);
    expect(trackerContentHash({ ...item, body: 'Steps… and more' })).not.toBe(base);
  });
});

describe('runTrackerLinks', () => {
  const legacy = { provider: 'jira' as const, key: 'OPS-7', url: 'https://acme.atlassian.net/browse/OPS-7', association };

  it('returns a run\'s own links untouched', () => {
    const own = [buildTrackerLink(association, 'OPS-7', 'handoff', item, now)];
    expect(runTrackerLinks({ trackerLinks: own, automationTracker: legacy })).toBe(own);
  });

  it('folds an earlier automation run into one derived, valid link', () => {
    const [link, ...rest] = runTrackerLinks({ createdAt: '2026-09-20T08:00:00.000Z', automationTracker: legacy });
    expect(rest).toEqual([]);
    expect(trackerLinkSchema.parse(link)).toEqual(link);
    expect(link).toEqual({ provider: 'jira', sourceId: 'acme', scopeId: '100', itemId: 'OPS-7', origin: 'automation', linkedAt: '2026-09-20T08:00:00.000Z', url: legacy.url });
  });

  it('yields nothing for a run with no link, and for a legacy record that cannot be placed in a source', () => {
    expect(runTrackerLinks({})).toEqual([]);
    expect(runTrackerLinks({ trackerLinks: [] })).toEqual([]);
    expect(runTrackerLinks({ automationTracker: { provider: 'jira', key: 'OPS-7', url: legacy.url } })).toEqual([]);
  });
});

describe('enrichTrackerLink', () => {
  it('gives a key-only link its title and URL, and where the ticket stands now — not a start snapshot', () => {
    const bare = buildTrackerLink(association, 'OPS-7', 'handoff', undefined, now);
    const enriched = enrichTrackerLink(bare, item, now);
    expect(trackerLinkSchema.parse(enriched)).toEqual(enriched);
    expect(enriched).toMatchObject({ title: 'Fix sign-in', url: item.url, latest: { status: 'In Progress', statusCategory: 'started' } });
    expect(enriched.snapshot).toBeUndefined();
  });

  it('leaves an enriched link exactly as it is', () => {
    const full = buildTrackerLink(association, 'OPS-7', 'handoff', item, now);
    expect(enrichTrackerLink(full, { ...item, title: 'Renamed' }, now)).toBe(full);
  });
});

describe('ticketChangeSince', () => {
  const started = buildTrackerLink(association, 'OPS-7', 'handoff', item, now);
  const later = new Date('2026-10-12T09:00:00.000Z');

  it('says nothing when the ticket is as the task knows it, and still records where it stands', () => {
    const { note, link } = ticketChangeSince(started, item, later);
    expect(note).toBeUndefined();
    expect(link.latest).toMatchObject({ status: 'In Progress', syncedAt: later.toISOString() });
    expect(link.noted).toBeUndefined();
    expect(link.snapshot).toEqual(started.snapshot);
  });

  it('names a content change and a status change, once', () => {
    const changed = { ...item, body: 'Steps… plus a new requirement', status: 'In Review', statusId: '4' };
    const first = ticketChangeSince(started, changed, later);
    expect(first.note).toContain('OPS-7');
    expect(first.note).toContain('its title or description changed');
    expect(first.note).toContain('its status went from "In Progress" to "In Review"');
    expect(trackerLinkSchema.parse(first.link)).toEqual(first.link);
    // What the task started from is history and stays.
    expect(first.link.snapshot).toEqual(started.snapshot);
    // The same ticket again is no longer news.
    expect(ticketChangeSince(first.link, changed, later).note).toBeUndefined();
    // A further change is.
    expect(ticketChangeSince(first.link, { ...changed, status: 'Done' }, later).note).toContain('"In Review" to "Done"');
  });

  it('still tells the task about a status the cockpit already knew of', () => {
    // The user moved the card in cezar: `latest` is current, the task was never told.
    const moved = { ...started, latest: { status: 'In Review', statusCategory: 'started' as const, syncedAt: now.toISOString() } };
    expect(ticketChangeSince(moved, { ...item, status: 'In Review' }, later).note).toContain('"In Progress" to "In Review"');
  });

  it('has nothing to compare for a link with no snapshot', () => {
    const bare = buildTrackerLink(association, 'OPS-7', 'handoff', undefined, now);
    const { note, link } = ticketChangeSince(bare, item, later);
    expect(note).toBeUndefined();
    expect(link.latest?.status).toBe('In Progress');
  });
});
