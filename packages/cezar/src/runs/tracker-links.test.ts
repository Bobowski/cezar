import { describe, expect, it } from 'vitest';
import { trackerLinkSchema, type TrackerAssociation, type TrackerItem } from '@open-mercato/cezar-contract';
import { buildTrackerLink, trackerContentHash } from './tracker-links.ts';

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
