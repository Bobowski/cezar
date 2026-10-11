import type { TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery, TrackerCandidatesResult, TrackerItemsResult, TrackerItemResult, TrackerKind, TrackerListQuery, TrackerSearchQuery, TrackerItem, TrackerComments } from '@open-mercato/cezar-contract';
import type { TrackerProvider, TrackerDriver } from './types.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { descriptionBody, TRACKER_COMMENT_CAP, TRACKER_COMMENT_LIMIT } from './adf.ts';
import { requestFailure } from './transport.ts';

const FIXTURES = {
  jira: { webUrl: 'https://demo.atlassian.net', scopeLabel: 'Project', prefix: 'DEMO', itemPath: 'browse' },
  linear: { webUrl: 'https://linear.app/demo', scopeLabel: 'Team', prefix: 'ENG', itemPath: 'issue' },
} satisfies Record<TrackerKind, { webUrl: string; scopeLabel: string; prefix: string; itemPath: string }>;

/** Offline fixture covers pagination and long context without inheriting host credentials. */
export function createDryTrackerClient(kind: TrackerKind): TrackerProvider {
  const fixture = FIXTURES[kind];
  const source = { id: `dry-${kind}`, webUrl: fixture.webUrl };
  const candidate = (n: number) => ({ id: String(n), name: `${fixture.scopeLabel} ${n}` });
  const all = Array.from({ length: 125 }, (_, i) => candidate(i + 1));
  const wrongSource = { available: false, code: 'source_changed', reason: 'Tracker source changed. Reconnect in Settings.' } as const;
  const missing = { available: false, code: 'not_found', reason: 'Tracker item not found in this scope.' } as const;
  // Every fifth item is done, as before; the rest spread over a workflow so a board has columns.
  function status(n: number): Pick<TrackerItem, 'status' | 'statusId' | 'statusCategory'> {
    if (n % 5 === 0) return { status: 'Done', statusId: 'dry-done', statusCategory: 'done' };
    if (n % 5 === 1) return { status: 'In Progress', statusId: 'dry-progress', statusCategory: 'started' };
    if (n % 5 === 2) return { status: 'To Do', statusId: 'dry-todo', statusCategory: 'unstarted' };
    if (n % 5 === 3) return { status: 'In Review', statusId: 'dry-review', statusCategory: 'started' };
    return { status: 'Backlog', statusId: 'dry-backlog', statusCategory: 'backlog' };
  }
  function item(n: number, association: TrackerAssociation, cap: number): TrackerItem {
    const prefix = `${fixture.prefix}${association.externalId}`;
    const id = `${prefix}-${n}`;
    return {
      kind: 'issue', id, title: n === 1 ? 'Improve account sign-in' : `Tracker task ${n}`,
      author: 'Demo user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 125 - n)).toISOString(),
      labels: n % 2 ? ['backend'] : ['frontend'], ...status(n),
      ...descriptionBody(n === 3 ? 'Large import requirements. '.repeat(3000) : n === 2 ? 'Detailed requirements. '.repeat(500) + '\nAcceptance: preserve all requirements.' : `Implement task ${n} for ${association.externalName}.\n\n- Preserve existing behavior.\n- Add regression coverage.`, cap, n === 4),
      url: `${source.webUrl}/${fixture.itemPath}/${id}`,
    };
  }
  // Item 2 carries a decision only its comments state; 3 an over-cap thread with a cut and a
  // lossy comment; 6 a thread that could not be read. Everything else has no comments.
  function comments(n: number): TrackerComments {
    const comment = (index: number, body: string, unsupported = false) => ({
      id: `c${n}-${index}`, author: index % 2 ? 'Demo reviewer' : 'Demo user',
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(), ...descriptionBody(body, TRACKER_COMMENT_CAP, unsupported),
    });
    if (n === 2) return { available: true, truncated: false, items: [
      comment(1, 'Can we keep the old endpoint for one release?'),
      comment(2, 'Decision: keep the old endpoint, behind a deprecation warning.'),
      comment(3, 'Agreed. Please add a regression test for the warning.'),
    ] };
    if (n === 3) return { available: true, truncated: true, items: Array.from({ length: TRACKER_COMMENT_LIMIT }, (_, i) =>
      comment(i + 6, i === 0 ? 'Long log excerpt. '.repeat(400) : `Follow-up note ${i + 6}.`, i === 1)) };
    if (n === 6) return { available: false, reason: 'Demo: the comment thread could not be read.' };
    return { available: true, truncated: false, items: [] };
  }
  function page<T>(items: T[], limit: number, cursor: string | undefined, scope: unknown) {
    const offset = Number(decodeCursor(scope, cursor) ?? '0');
    const sliced = items.slice(offset, offset + limit);
    const truncated = offset + limit < items.length;
    return { sliced, truncated, ...(truncated ? { nextCursor: encodeCursor(scope, String(offset + limit)) } : {}) };
  }
  function collectionError(error: unknown) {
    const failure = requestFailure(error);
    return failure.code === 'not_found' ? { available: false as const, code: 'unavailable' as const, reason: failure.reason } : failure;
  }
  return {
    kind,
    clearCache() {},
    async listCandidates(query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> {
      try {
        const found = all.filter(row => !query.q || row.name.toLowerCase().includes(query.q.toLowerCase()));
        const { sliced, ...pagination } = page(found, query.limit, query.cursor, [kind, 'candidates', query.q, query.limit]);
        return { available: true, source, candidates: sliced, ...pagination };
      } catch (error) { return collectionError(error); }
    },
    async resolveAssociation(input: TrackerAssociationInput): Promise<TrackerAssociationResult> {
      if (input.kind !== kind || input.sourceId !== source.id) return wrongSource;
      const found = all.find(row => row.id === input.externalId);
      return found ? { available: true, association: { kind, source, externalId: found.id, externalName: found.name } } : missing;
    },
    driver(association: TrackerAssociation): TrackerDriver {
      const valid = () => association.kind === kind && association.source.id === source.id && association.source.webUrl === source.webUrl && all.some(row => row.id === association.externalId);
      const read = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
        if (!valid()) return wrongSource;
        try {
          const q = 'q' in query ? query.q.toLowerCase() : '';
          const found = all.map((_, i) => item(i + 1, association, 8000)).filter(row => (query.state === 'all' || row.status !== 'Done') && (!q || `${row.id} ${row.title} ${row.body}`.toLowerCase().includes(q)) && (query.labels ?? []).every(label => row.labels.includes(label)));
          const { sliced, ...pagination } = page(found, query.limit, query.cursor, [association, q, query.state, query.labels, query.limit]);
          return { available: true, items: sliced, ...pagination };
        } catch (error) { return collectionError(error); }
      };
      return {
        association, listIssues: read, searchItems: read,
        async getItem(id: string): Promise<TrackerItemResult> {
          if (!valid()) return wrongSource;
          const prefix = `${fixture.prefix}${association.externalId}`;
          const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
          const n = Number(match?.[1]);
          return n >= 1 && n <= 125 ? { available: true, item: item(n, association, 60000), comments: comments(n) } : missing;
        },
      };
    },
  };
}
