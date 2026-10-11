import { z } from 'zod';

/** Jira Cloud and Linear are the two read-only tracker providers supported by this contract. */
export const trackerKindSchema = z.enum(['jira', 'linear']);
export type TrackerKind = z.infer<typeof trackerKindSchema>;

const httpsUrlSchema = z.url({ protocol: /^https$/ });
const nonemptyStringSchema = z.string().min(1);
const trackerCursorSchema = z.string().min(1).max(4096);

/** Stable vendor identity and the human-facing web origin that belongs to it. */
export const trackerSourceSchema = z
  .object({
    id: nonemptyStringSchema,
    webUrl: httpsUrlSchema,
  })
  .strict();
export type TrackerSource = z.infer<typeof trackerSourceSchema>;

/** A Jira project or Linear team offered by credential-scoped discovery. */
export const trackerCandidateSchema = z
  .object({
    id: nonemptyStringSchema,
    name: nonemptyStringSchema,
  })
  .strict();
export type TrackerCandidate = z.infer<typeof trackerCandidateSchema>;

/** The non-secret, server-resolved association persisted for one cezar project. */
export const trackerAssociationSchema = z
  .object({
    kind: trackerKindSchema,
    source: trackerSourceSchema,
    externalId: z.string(),
    externalName: z.string(),
    connectionId: z.uuid().optional(),
  })
  .strict();
export type TrackerAssociation = z.infer<typeof trackerAssociationSchema>;

/** Non-secret read identity; display-name changes do not move an issue to another source. */
export function trackerReadScope(association: TrackerAssociation): string {
  return JSON.stringify([association.kind, association.source.id, association.source.webUrl, association.externalId, association.connectionId ?? null]);
}

/** Client-authored selection. Names and URLs are resolved from the vendor and cannot be supplied. */
export const trackerAssociationInputSchema = z
  .object({
    kind: trackerKindSchema,
    externalId: nonemptyStringSchema,
    sourceId: nonemptyStringSchema,
    connectionId: z.uuid().optional(),
  })
  .strict();
export type TrackerAssociationInput = z.infer<typeof trackerAssociationInputSchema>;

/**
 * Where a vendor status sits in a workflow, normalized across providers (Jira's status category,
 * Linear's state type). It orders board columns and list groups; `other` is a vendor value this
 * contract does not know, never a guess.
 */
export const trackerStatusCategorySchema = z.enum(['backlog', 'unstarted', 'started', 'done', 'canceled', 'other']);
export type TrackerStatusCategory = z.infer<typeof trackerStatusCategorySchema>;

/** A provider-neutral Jira issue or Linear issue. */
export const trackerItemSchema = z
  .object({
    kind: z.literal('issue'),
    id: z.string(),
    title: z.string(),
    author: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    labels: z.array(z.string()),
    body: z.string(),
    bodyTruncated: z.boolean(),
    unsupportedContent: z.boolean(),
    url: httpsUrlSchema,
    status: z.string(),
    /** The vendor's own id for `status`: display names are not unique and can be renamed. */
    statusId: z.string().min(1),
    statusCategory: trackerStatusCategorySchema,
    /** Who the ticket is assigned to and how urgent the vendor says it is, as display text.
     *  Absent when the ticket has neither; never an empty string. */
    assignee: z.string().min(1).optional(),
    priority: z.string().min(1).optional(),
  })
  .strict();
export type TrackerItem = z.infer<typeof trackerItemSchema>;

export const trackerFailureCodeSchema = z.enum([
  'not_configured',
  'credentials_missing',
  'unauthorized',
  'rate_limited',
  'unavailable',
  'source_changed',
  'invalid_response',
]);
export type TrackerFailureCode = z.infer<typeof trackerFailureCodeSchema>;

/** Controlled vendor/configuration failure. These remain HTTP 200 on read routes. */
export const trackerFailureSchema = z
  .object({
    available: z.literal(false),
    code: trackerFailureCodeSchema,
    reason: z.string(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TrackerFailure = z.infer<typeof trackerFailureSchema>;

/** Driver-only cursor failure, mapped by the route to HTTP 400. */
export const trackerInvalidCursorSchema = z
  .object({
    available: z.literal(false),
    code: z.literal('invalid_cursor'),
    reason: z.string(),
  })
  .strict();
export type TrackerInvalidCursor = z.infer<typeof trackerInvalidCursorSchema>;

/** Driver-only missing item/candidate result, mapped by the route to HTTP 404 where applicable. */
export const trackerNotFoundSchema = z
  .object({
    available: z.literal(false),
    code: z.literal('not_found'),
    reason: z.string(),
  })
  .strict();
export type TrackerNotFound = z.infer<typeof trackerNotFoundSchema>;

function enforcePagination(
  page: { truncated: boolean; nextCursor?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (page.truncated && page.nextCursor === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['nextCursor'],
      message: 'nextCursor is required when truncated is true',
    });
  }
  if (!page.truncated && page.nextCursor !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['nextCursor'],
      message: 'nextCursor must be omitted when truncated is false',
    });
  }
}

export const trackerCandidatesSuccessSchema = z
  .object({
    available: z.literal(true),
    source: trackerSourceSchema,
    candidates: z.array(trackerCandidateSchema),
    truncated: z.boolean(),
    nextCursor: trackerCursorSchema.optional(),
  })
  .strict()
  .superRefine(enforcePagination);
export type TrackerCandidatesSuccess = z.infer<typeof trackerCandidatesSuccessSchema>;

export const trackerItemsSuccessSchema = z
  .object({
    available: z.literal(true),
    items: z.array(trackerItemSchema),
    truncated: z.boolean(),
    nextCursor: trackerCursorSchema.optional(),
  })
  .strict()
  .superRefine(enforcePagination);
export type TrackerItemsSuccess = z.infer<typeof trackerItemsSuccessSchema>;

/** One comment on a ticket, converted and bounded like the description. */
export const trackerCommentSchema = z
  .object({
    id: z.string(),
    author: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    body: z.string(),
    bodyTruncated: z.boolean(),
    unsupportedContent: z.boolean(),
  })
  .strict();
export type TrackerComment = z.infer<typeof trackerCommentSchema>;

/**
 * A ticket's comment thread as one bounded read, oldest first. `truncated` means the ticket has
 * comments this read did not include. A failed comment read is its own state: the ticket itself
 * was read, and "unavailable" must never be rendered as "no comments".
 */
export const trackerCommentsSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), items: z.array(trackerCommentSchema), truncated: z.boolean() }).strict(),
  z.object({ available: z.literal(false), reason: z.string() }).strict(),
]);
export type TrackerComments = z.infer<typeof trackerCommentsSchema>;

export const trackerItemSuccessSchema = z
  .object({
    available: z.literal(true),
    item: trackerItemSchema,
    comments: trackerCommentsSchema,
  })
  .strict();
export type TrackerItemSuccess = z.infer<typeof trackerItemSuccessSchema>;

export const trackerAssociationSuccessSchema = z
  .object({
    available: z.literal(true),
    association: trackerAssociationSchema,
  })
  .strict();
export type TrackerAssociationSuccess = z.infer<typeof trackerAssociationSuccessSchema>;

const trackerCollectionFailureSchema = z.discriminatedUnion('code', [
  trackerFailureSchema,
  trackerInvalidCursorSchema,
]);
const trackerLookupFailureSchema = z.discriminatedUnion('code', [
  trackerFailureSchema,
  trackerNotFoundSchema,
]);

/** Driver result: HTTP routes remove `invalid_cursor` before constructing a 200 response. */
export const trackerCandidatesResultSchema = z.discriminatedUnion('available', [
  trackerCandidatesSuccessSchema,
  trackerCollectionFailureSchema,
]);
export type TrackerCandidatesResult = z.infer<typeof trackerCandidatesResultSchema>;

/** Driver result: HTTP routes remove `invalid_cursor` before constructing a 200 response. */
export const trackerItemsResultSchema = z.discriminatedUnion('available', [
  trackerItemsSuccessSchema,
  trackerCollectionFailureSchema,
]);
export type TrackerItemsResult = z.infer<typeof trackerItemsResultSchema>;

/** Driver result: the detail route maps only `not_found` to HTTP 404. */
export const trackerItemResultSchema = z.discriminatedUnion('available', [
  trackerItemSuccessSchema,
  trackerLookupFailureSchema,
]);
export type TrackerItemResult = z.infer<typeof trackerItemResultSchema>;

/** Driver result used while validating a selected candidate before persistence. */
export const trackerAssociationResultSchema = z.discriminatedUnion('available', [
  trackerAssociationSuccessSchema,
  trackerLookupFailureSchema,
]);
export type TrackerAssociationResult = z.infer<typeof trackerAssociationResultSchema>;

/** HTTP 200 response for candidate discovery; invalid cursors are HTTP 400 instead. */
export const trackerCandidatesResponseSchema = z.discriminatedUnion('available', [
  trackerCandidatesSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerCandidatesResponse = z.infer<typeof trackerCandidatesResponseSchema>;

/** HTTP 200 response for issue list/search; invalid cursors are HTTP 400 instead. */
export const trackerItemsResponseSchema = z.discriminatedUnion('available', [
  trackerItemsSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerItemsResponse = z.infer<typeof trackerItemsResponseSchema>;

/** HTTP 200 detail response; a missing item is represented by the route's HTTP 404 envelope. */
export const trackerItemResponseSchema = z.discriminatedUnion('available', [
  trackerItemSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerItemResponse = z.infer<typeof trackerItemResponseSchema>;

export const trackerAssociationResponseSchema = z
  .object({ association: trackerAssociationSchema.nullable() })
  .strict();
export type TrackerAssociationResponse = z.infer<typeof trackerAssociationResponseSchema>;

export const trackerClearedResponseSchema = z.object({ cleared: z.literal(true) }).strict();
export type TrackerClearedResponse = z.infer<typeof trackerClearedResponseSchema>;

export const trackerErrorResponseSchema = z.object({ error: z.string() }).strict();
export type TrackerErrorResponse = z.infer<typeof trackerErrorResponseSchema>;

const trackerQueryTextSchema = z.string().trim().min(1).max(256);
const trackerQueryCursorSchema = trackerCursorSchema.optional();
const trackerQueryLimitSchema = z.coerce.number<string>().int().min(1).max(100).default(50);
const trackerRefreshSchema = z.enum(['0', '1']).optional();
const trackerStateSchema = z.enum(['active', 'all']);
const trackerLabelsArraySchema = z.array(nonemptyStringSchema).max(20);
const trackerLabelsQuerySchema = z.string().transform((raw, context): string[] => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    context.addIssue({ code: 'custom', message: 'labels must be a JSON array of strings' });
    return z.NEVER;
  }
  const parsed = trackerLabelsArraySchema.safeParse(decoded);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'labels must be a JSON array of 0 to 20 nonempty strings' });
    return z.NEVER;
  }
  return parsed.data;
});

export const trackerCandidatesQuerySchema = z.object({
  kind: trackerKindSchema,
  q: trackerQueryTextSchema.optional(),
  cursor: trackerQueryCursorSchema,
  limit: trackerQueryLimitSchema,
});
export type TrackerCandidatesQueryInput = z.input<typeof trackerCandidatesQuerySchema>;
export type TrackerCandidatesQuery = z.output<typeof trackerCandidatesQuerySchema>;

const trackerExpectedScopeSchema = z.string().max(4096).optional();

export const trackerItemQuerySchema = z.object({ expectedScope: trackerExpectedScopeSchema });
export type TrackerItemQuery = z.infer<typeof trackerItemQuerySchema>;

export const trackerListQuerySchema = z.object({
  expectedScope: trackerExpectedScopeSchema,
  cursor: trackerQueryCursorSchema,
  limit: trackerQueryLimitSchema,
  refresh: trackerRefreshSchema,
  state: trackerStateSchema.default('active'),
  labels: trackerLabelsQuerySchema.optional(),
});
export type TrackerListQueryInput = z.input<typeof trackerListQuerySchema>;
export type TrackerListQuery = z.output<typeof trackerListQuerySchema>;

export const trackerSearchQuerySchema = z.object({
  expectedScope: trackerExpectedScopeSchema,
  cursor: trackerQueryCursorSchema,
  limit: trackerQueryLimitSchema,
  refresh: trackerRefreshSchema,
  state: trackerStateSchema.default('all'),
  labels: trackerLabelsQuerySchema.optional(),
  q: trackerQueryTextSchema,
});
export type TrackerSearchQueryInput = z.input<typeof trackerSearchQuerySchema>;
export type TrackerSearchQuery = z.output<typeof trackerSearchQuerySchema>;

const reservedTrackerItemIds = ['association', 'candidates', 'search', 'connection'];

/** One bounded vendor identifier path segment; static tracker routes are never detail IDs. */
const trackerItemIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/]+$/, 'id must be one path segment')
  .refine((id) => !reservedTrackerItemIds.includes(id), 'id is reserved by a static route');
export const trackerItemParamsSchema = z.object({ id: trackerItemIdSchema });
export type TrackerItemParams = z.infer<typeof trackerItemParamsSchema>;

/**
 * A run's link to the tracker ticket it works on (spec 2026-10-11-tracker-ticket-context §
 * Data model). Identity is `(provider, sourceId, itemId)`: not the connection, so rotating a
 * token does not orphan history. `title`, `url` and `snapshot` come from the server's own read
 * of the ticket and are absent when that read failed; nothing here is client-authored.
 */
export const trackerLinkSchema = z
  .object({
    provider: trackerKindSchema,
    sourceId: nonemptyStringSchema,
    scopeId: z.string(),
    itemId: nonemptyStringSchema,
    origin: z.enum(['handoff', 'automation']),
    linkedAt: z.iso.datetime({ offset: true }),
    title: z.string().optional(),
    url: httpsUrlSchema.optional(),
    snapshot: z
      .object({
        status: z.string(),
        statusCategory: trackerStatusCategorySchema.optional(),
        updatedAt: z.string(),
        /** sha256 of the title and description this run started from: a change detector only. */
        contentHash: z.string(),
        syncedAt: z.iso.datetime({ offset: true }),
      })
      .optional(),
    /** The status as the cockpit last learned it, after a move made here. `snapshot` stays what
     *  the task started from: the two answer different questions and neither overwrites the other. */
    latest: z
      .object({ status: z.string(), statusCategory: trackerStatusCategorySchema.optional(), syncedAt: z.iso.datetime({ offset: true }) })
      .optional(),
    /** What the TASK was last told about its ticket by a change note, so one change is announced
     *  once. Distinct from `latest`, which is what the cockpit knows: a status moved in the
     *  cockpit is known at once and told to the task only when it is next continued. */
    noted: z.object({ status: z.string(), contentHash: z.string(), at: z.iso.datetime({ offset: true }) }).optional(),
  });
export type TrackerLink = z.infer<typeof trackerLinkSchema>;

/** `POST /runs`' optional `tracker` key: which ticket of the project's saved scope this task is for. */
export const trackerRunLinkInputSchema = z
  .object({
    itemId: trackerItemIdSchema,
    /** `trackerReadScope` of the association the client was looking at; a mismatch is a 409. */
    expectedScope: z.string().min(1).max(4096),
  })
  .strict();
export type TrackerRunLinkInput = z.infer<typeof trackerRunLinkInputSchema>;


// Association changes are workspace events; consumers refetch authoritative local state.
export const trackerChangedEventSchema = z.object({ project: z.string().min(1) }).strict();
export type TrackerChangedEvent = z.infer<typeof trackerChangedEventSchema>;
export const trackerAssociationSavedResponseSchema = z.object({ association: trackerAssociationSchema }).strict();
export type TrackerAssociationSavedResponse = z.infer<typeof trackerAssociationSavedResponseSchema>;

/** Write-only project credentials. Never return this shape from an HTTP handler. */
const trackerSecretSchema = z.string().trim().min(1).max(8192);
export const trackerCredentialsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('jira'), origin: z.string().max(512).regex(/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\/?$/i, 'Use an HTTPS Jira Cloud site origin'), email: z.email().max(320), token: trackerSecretSchema }).strict(),
  z.object({ kind: z.literal('linear'), key: trackerSecretSchema }).strict(),
]);
export type TrackerCredentials = z.infer<typeof trackerCredentialsSchema>;
export const trackerConnectionSchema = z.object({ id: z.uuid(), kind: trackerKindSchema }).strict();
export type TrackerConnection = z.infer<typeof trackerConnectionSchema>;
export const trackerConnectionResponseSchema = z.object({
  connection: trackerConnectionSchema.nullable(), demo: z.boolean(), error: z.string().optional(),
}).strict();
export type TrackerConnectionResponse = z.infer<typeof trackerConnectionResponseSchema>;

/** Visible-list observation: bounded first page, explicit project association. */
export const trackerWatchInputSchema = z.object({
  association: trackerAssociationSchema,
  query: z.string().trim().max(256),
  state: trackerStateSchema,
  labels: z.array(z.string().trim().min(1).max(256)).max(20),
}).strict();
export type TrackerWatchInput = z.infer<typeof trackerWatchInputSchema>;
export const trackerWatchParamsSchema = z.object({ watchId: z.uuid() });
export const trackerWatchQuerySchema = z.object({ after: z.coerce.number<string>().int().nonnegative().optional() });
export const trackerWatchHandleSchema = z.object({ id: z.uuid(), topic: z.string() }).strict();
export type TrackerWatchHandle = z.infer<typeof trackerWatchHandleSchema>;
export const trackerWatchSignalSchema = z.object({ version: z.number().int().nonnegative() }).strict();
export const trackerWatchSnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  checking: z.boolean(),
  checkedAt: z.iso.datetime().nullable(),
  result: trackerItemsResponseSchema.nullable(),
}).strict();
export type TrackerWatchSnapshot = z.infer<typeof trackerWatchSnapshotSchema>;

/** `GET /runs/:id/tracker-issue`: `item` names another ticket of the run's scope; omitted, the run's own. */
export const trackerRunIssueQuerySchema = z.object({ item: trackerItemIdSchema.optional() });
export type TrackerRunIssueQuery = z.infer<typeof trackerRunIssueQuerySchema>;

/**
 * The linked ticket, read now by the cockpit for the agent of a run (spec
 * 2026-10-11-tracker-ticket-context § Phase 4). `sinceStart` compares the title and description
 * with the snapshot the run was started from; `unknown` when the run recorded none, or when the
 * ticket asked for is not the one the run is linked to.
 */
export const trackerRunIssueSuccessSchema = trackerItemSuccessSchema.extend({
  sinceStart: z.enum(['unchanged', 'changed', 'unknown']),
  statusAtStart: z.string().optional(),
});
export const trackerRunIssueResponseSchema = z.discriminatedUnion('available', [
  trackerRunIssueSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerRunIssueResponse = z.infer<typeof trackerRunIssueResponseSchema>;

// ---- status change (spec 2026-10-11-tracker-ticket-context § Phase 6) --------------------------
// The tracker's one vendor write: a person moves one ticket to another status, by hand.

/** A status this ticket could be moved to. `available: false` carries the reason it cannot be done from here. */
export const trackerTransitionTargetSchema = z
  .object({
    statusId: nonemptyStringSchema,
    status: z.string(),
    statusCategory: trackerStatusCategorySchema,
    available: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
export type TrackerTransitionTarget = z.infer<typeof trackerTransitionTargetSchema>;

/**
 * `GET /tracker/:id/transitions`. `writable: false` means this connection was refused a write
 * earlier in this process (a read-only token): the targets are then informational only.
 */
export const trackerTransitionsSuccessSchema = z
  .object({
    available: z.literal(true),
    currentStatusId: nonemptyStringSchema,
    targets: z.array(trackerTransitionTargetSchema),
    writable: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
export const trackerTransitionsResponseSchema = z.discriminatedUnion('available', [
  trackerTransitionsSuccessSchema,
  trackerFailureSchema,
]);
export type TrackerTransitionsResponse = z.infer<typeof trackerTransitionsResponseSchema>;
/** Driver result: the route maps `not_found` to HTTP 404. */
export const trackerTransitionsResultSchema = z.discriminatedUnion('available', [
  trackerTransitionsSuccessSchema,
  trackerLookupFailureSchema,
]);
export type TrackerTransitionsResult = z.infer<typeof trackerTransitionsResultSchema>;

/** `POST /tracker/:id/transition`. `expectedStatusId` is the status the user saw: compare-and-set. */
export const trackerTransitionInputSchema = z
  .object({
    expectedScope: z.string().min(1).max(4096),
    toStatusId: nonemptyStringSchema.max(256),
    expectedStatusId: nonemptyStringSchema.max(256),
  })
  .strict();
export type TrackerTransitionInput = z.infer<typeof trackerTransitionInputSchema>;

/** HTTP 200: the ticket after the move, or a controlled failure. A stale status is the 409 below. */
export const trackerTransitionResponseSchema = trackerItemResponseSchema;
export type TrackerTransitionResponse = z.infer<typeof trackerTransitionResponseSchema>;

/** HTTP 409: someone moved the ticket first. Nothing was written; `item` is the ticket as it is now. */
export const trackerTransitionConflictSchema = z
  .object({ error: z.string(), item: trackerItemSchema, comments: trackerCommentsSchema })
  .strict();
export type TrackerTransitionConflict = z.infer<typeof trackerTransitionConflictSchema>;

/** Driver result of a move: the ticket afterwards, a failure, or a conflict with the current ticket. */
export type TrackerTransitionResult =
  | TrackerItemResult
  | { available: false; code: 'conflict'; reason: string; item: TrackerItem; comments: TrackerComments };
