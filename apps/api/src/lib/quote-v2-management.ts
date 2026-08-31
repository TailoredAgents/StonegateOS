import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { z } from "zod";
import type { DatabaseClient } from "@/db";
import {
  contacts,
  properties,
  quoteActivityEvents,
  quoteCapabilities,
  quoteChangeRequests,
  quoteResponses,
  quoteSendAttempts,
  quoteSendDeliveries,
  quoteVersionAttachments,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  salesOpportunities,
  teamMembers,
} from "@/db";
import {
  QuoteDraftDocumentSchema,
  QuoteV2ListQuerySchema,
  QuoteV2RevisionCommandSchema,
} from "@/lib/quote-v2-contract";
import {
  QuoteDomainError,
  calculateQuoteV2Totals,
} from "@/lib/quote-v2-domain";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { TeamMutationFailure } from "@/lib/team-mutation";

const LIST_QUERY_KEYS = new Set([
  "engine",
  "cursor",
  "limit",
  "bucket",
  "search",
  "ownerId",
  "sort",
]);
const CURSOR_VERSION = 1 as const;
const CURSOR_MAX_BYTES = 1_024;
const NULL_EXPIRY_ISO = "9999-12-31T23:59:59.999Z";

type QuoteV2ListQuery = z.infer<typeof QuoteV2ListQuerySchema>;
type QuoteV2RevisionCommand = z.infer<typeof QuoteV2RevisionCommandSchema>;

type QuoteV2ListCursor = {
  version: typeof CURSOR_VERSION;
  filterHash: string;
  sort: QuoteV2ListQuery["sort"];
  primary: string | number;
  secondary: string;
  id: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function isExactInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validCursorPrimary(
  sort: QuoteV2ListQuery["sort"],
  value: unknown,
): value is string | number {
  return sort === "updated_desc" || sort === "expiry_asc"
    ? isExactInstant(value)
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizedListFilter(
  query: QuoteV2ListQuery,
): Record<string, unknown> {
  return {
    bucket: query.bucket ?? null,
    search: query.search?.trim().toLocaleLowerCase("en-US") || null,
    ownerId: query.ownerId ?? null,
    sort: query.sort,
    limit: query.limit,
  };
}

export function quoteV2ListFilterHash(query: QuoteV2ListQuery): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedListFilter(query)), "utf8")
    .digest("hex");
}

export function encodeQuoteV2ListCursor(cursor: QuoteV2ListCursor): string {
  if (
    cursor.version !== CURSOR_VERSION ||
    !HASH_PATTERN.test(cursor.filterHash) ||
    !UUID_PATTERN.test(cursor.id) ||
    !isExactInstant(cursor.secondary) ||
    !validCursorPrimary(cursor.sort, cursor.primary)
  ) {
    throw new TypeError("Cannot encode an invalid Quote V2 cursor.");
  }
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeQuoteV2ListCursor(
  value: string,
  query: QuoteV2ListQuery,
): QuoteV2ListCursor | null {
  try {
    if (!value || value.length > 500) return null;
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength === 0 || decoded.byteLength > CURSOR_MAX_BYTES) {
      return null;
    }
    const cursor = JSON.parse(
      decoded.toString("utf8"),
    ) as Partial<QuoteV2ListCursor>;
    if (
      cursor.version !== CURSOR_VERSION ||
      cursor.sort !== query.sort ||
      cursor.filterHash !== quoteV2ListFilterHash(query) ||
      !cursor.filterHash ||
      !HASH_PATTERN.test(cursor.filterHash) ||
      !cursor.id ||
      !UUID_PATTERN.test(cursor.id) ||
      !isExactInstant(cursor.secondary) ||
      !validCursorPrimary(query.sort, cursor.primary)
    ) {
      return null;
    }
    const complete = cursor as QuoteV2ListCursor;
    return encodeQuoteV2ListCursor(complete) === value ? complete : null;
  } catch {
    return null;
  }
}

export function parseQuoteV2ListQuery(
  searchParams: URLSearchParams,
):
  | { ok: true; query: QuoteV2ListQuery; cursor: QuoteV2ListCursor | null }
  | { ok: false; fieldErrors: Record<string, string> } {
  for (const key of searchParams.keys()) {
    if (!LIST_QUERY_KEYS.has(key)) {
      return {
        ok: false,
        fieldErrors: { [key]: "This filter is not supported." },
      };
    }
    if (searchParams.getAll(key).length > 1) {
      return {
        ok: false,
        fieldErrors: { [key]: "Provide this filter only once." },
      };
    }
  }
  if (searchParams.get("engine") !== "v2") {
    return {
      ok: false,
      fieldErrors: { engine: "Select the versioned quote view." },
    };
  }
  const candidate: Record<string, string> = {};
  for (const key of [
    "cursor",
    "limit",
    "bucket",
    "search",
    "ownerId",
    "sort",
  ]) {
    const value = searchParams.get(key);
    if (value !== null) candidate[key] = value;
  }
  const parsed = QuoteV2ListQuerySchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".") || "query"] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }
  const cursor = parsed.data.cursor
    ? decodeQuoteV2ListCursor(parsed.data.cursor, parsed.data)
    : null;
  if (parsed.data.cursor && !cursor) {
    return {
      ok: false,
      fieldErrors: {
        cursor: "This quote page is stale. Return to the first page.",
      },
    };
  }
  return { ok: true, query: parsed.data, cursor };
}

const openChange = sql<boolean>`exists (
  select 1 from ${quoteChangeRequests}
  where ${quoteChangeRequests.quoteId} = ${quotes.id}
    and ${quoteChangeRequests.status} in ('open', 'acknowledged')
)`;
const latestDeliveryStatus = sql<string | null>`(
  select ${quoteSendAttempts.status}
  from ${quoteSendAttempts}
  where ${quoteSendAttempts.quoteId} = ${quotes.id}
  order by ${quoteSendAttempts.requestedAt} desc, ${quoteSendAttempts.id} desc
  limit 1
)`;
const needsAction = sql<boolean>`(
  ${openChange}
  or ${quoteVersions.state} in ('ready', 'expired')
  or ${latestDeliveryStatus} in ('partial', 'failed', 'reconciliation_required')
  or (${quotes.aggregateState} = 'accepted' and ${quotes.acceptedAppointmentId} is null)
)`;
const nextActionRank = sql<number>`case
  when ${openChange} then 10
  when ${latestDeliveryStatus} in ('partial', 'failed', 'reconciliation_required') then 20
  when ${quotes.aggregateState} = 'accepted' and ${quotes.acceptedAppointmentId} is null then 30
  when ${quoteVersions.state} = 'ready' then 40
  when ${quoteVersions.state} = 'expired' then 45
  when ${quoteVersions.state} = 'draft' then 50
  when ${quotes.aggregateState} = 'open' then 60
  when ${quotes.acceptedAppointmentId} is not null then 70
  else 90
end`;
const expirySort = sql<Date>`coalesce(${quoteVersions.expiresAt}, ${NULL_EXPIRY_ISO}::timestamptz)`;
const totalSort = sql<number>`coalesce(${quoteVersions.totalMaxCents}, 0)`;

function bucketPredicate(bucket: QuoteV2ListQuery["bucket"]): SQL | undefined {
  if (!bucket) return undefined;
  if (bucket === "needs_action") return needsAction;
  if (bucket === "drafts") {
    return sql`not (${needsAction}) and ${quoteVersions.state} = 'draft'`;
  }
  if (bucket === "awaiting_client") {
    return sql`not (${needsAction}) and ${quotes.aggregateState} = 'open'`;
  }
  if (bucket === "accepted_booked") {
    return sql`${quotes.aggregateState} = 'accepted' and ${quotes.acceptedAppointmentId} is not null`;
  }
  return sql`${quotes.aggregateState} in ('declined', 'voided', 'archived')`;
}

export function quoteV2ListCursorPredicate(
  query: QuoteV2ListQuery,
  cursor: QuoteV2ListCursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  // Keep cursor instants as their already-validated canonical ISO strings.
  // Raw `sql` parameters do not inherit a timestamp column encoder, and passing
  // a Date here reaches postgres.js unchanged after Drizzle installs its
  // transparent timestamp serializer. The explicit cast is portable across the
  // application client and transaction-scoped performance client.
  const secondary = cursor.secondary;
  if (query.sort === "updated_desc") {
    const primary = String(cursor.primary);
    return sql`(${quotes.updatedAt}, ${quotes.id}) < (${primary}::timestamptz, ${cursor.id}::uuid)`;
  }
  if (query.sort === "expiry_asc") {
    const primary = String(cursor.primary);
    return sql`(${expirySort}, ${quotes.id}) > (${primary}::timestamptz, ${cursor.id}::uuid)`;
  }
  if (query.sort === "total_desc") {
    const primary = Number(cursor.primary);
    return sql`(${totalSort}, ${quotes.updatedAt}, ${quotes.id}) < (${primary}, ${secondary}::timestamptz, ${cursor.id}::uuid)`;
  }
  const primary = Number(cursor.primary);
  return sql`(${nextActionRank} > ${primary}) or (${nextActionRank} = ${primary} and (${quotes.updatedAt}, ${quotes.id}) < (${secondary}::timestamptz, ${cursor.id}::uuid))`;
}

function searchPredicate(search: string | undefined): SQL | undefined {
  const normalized = search?.trim();
  if (!normalized) return undefined;
  const pattern = `%${normalized.replace(/[\\%_]/gu, "\\$&")}%`;
  return or(
    ilike(quotes.quoteNumber, pattern),
    sql`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}) ilike ${pattern} escape '\\'`,
    ilike(contacts.company, pattern),
    ilike(quoteVersions.clientCompany, pattern),
    ilike(quoteVersions.projectName, pattern),
    ilike(quoteVersions.purchaseOrderNumber, pattern),
    ilike(quoteVersions.referenceNumber, pattern),
    sql`concat_ws(' ', ${properties.addressLine1}, ${properties.addressLine2}, ${properties.city}, ${properties.state}, ${properties.postalCode}) ilike ${pattern} escape '\\'`,
  );
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cursorPrimaryValue(
  sort: QuoteV2ListQuery["sort"],
  value: unknown,
  updatedAt: Date,
): string | number {
  if (sort === "updated_desc") return updatedAt.toISOString();
  if (sort === "expiry_asc") {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) {
      throw new TypeError("The quote expiry cursor is invalid.");
    }
    return date.toISOString();
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TypeError("The quote sort cursor is invalid.");
  }
  return numeric;
}

function deliveryLabel(status: string | null): string | null {
  if (!status) return null;
  return status;
}

function rowNextAction(row: {
  hasOpenChange: boolean;
  deliveryStatus: string | null;
  versionState: string | null;
  aggregateState: string | null;
  acceptedAppointmentId: string | null;
}): { code: string; label: string } {
  if (row.hasOpenChange)
    return { code: "resolve_changes", label: "Resolve requested changes" };
  if (
    ["partial", "failed", "reconciliation_required"].includes(
      row.deliveryStatus ?? "",
    )
  ) {
    return { code: "repair_delivery", label: "Review delivery failure" };
  }
  if (row.aggregateState === "accepted" && !row.acceptedAppointmentId) {
    return { code: "fulfill_acceptance", label: "Collect deposit or schedule" };
  }
  if (row.versionState === "ready")
    return { code: "review_send", label: "Review and send" };
  if (row.versionState === "expired")
    return { code: "revise_expired", label: "Revise and reissue" };
  if (row.versionState === "draft")
    return { code: "edit_draft", label: "Continue draft" };
  if (row.aggregateState === "open")
    return { code: "await_client", label: "Await client response" };
  if (row.acceptedAppointmentId)
    return { code: "view_booking", label: "View booking" };
  return { code: "view", label: "View quote" };
}

function rowBucket(row: {
  hasOpenChange: boolean;
  deliveryStatus: string | null;
  versionState: string | null;
  aggregateState: string | null;
  acceptedAppointmentId: string | null;
}): string {
  const requiresAction =
    row.hasOpenChange ||
    ["ready", "expired"].includes(row.versionState ?? "") ||
    ["partial", "failed", "reconciliation_required"].includes(
      row.deliveryStatus ?? "",
    ) ||
    (row.aggregateState === "accepted" && !row.acceptedAppointmentId);
  if (requiresAction) return "needs_action";
  if (row.versionState === "draft") return "drafts";
  if (row.aggregateState === "open") return "awaiting_client";
  if (row.aggregateState === "accepted") return "accepted_booked";
  return "closed";
}

export async function listQuoteV2Staff(
  db: DatabaseClient,
  input: { query: QuoteV2ListQuery; cursor: QuoteV2ListCursor | null },
): Promise<{
  quotes: Array<Record<string, unknown>>;
  nextCursor: string | null;
}> {
  const { query, cursor } = input;
  const primarySort: SQL<unknown> =
    query.sort === "expiry_asc"
      ? expirySort
      : query.sort === "total_desc"
        ? totalSort
        : query.sort === "next_action"
          ? nextActionRank
          : sql<Date>`${quotes.updatedAt}`;
  const predicates = [
    eq(quotes.engineVersion, "v2"),
    bucketPredicate(query.bucket),
    query.ownerId
      ? eq(salesOpportunities.ownerTeamMemberId, query.ownerId)
      : undefined,
    searchPredicate(query.search),
    quoteV2ListCursorPredicate(query, cursor),
  ].filter((value): value is SQL => Boolean(value));
  const order =
    query.sort === "expiry_asc"
      ? [asc(expirySort), asc(quotes.id)]
      : query.sort === "total_desc"
        ? [desc(totalSort), desc(quotes.updatedAt), desc(quotes.id)]
        : query.sort === "updated_desc"
          ? [desc(quotes.updatedAt), desc(quotes.id)]
          : [asc(nextActionRank), desc(quotes.updatedAt), desc(quotes.id)];

  const rows = await db
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      updatedAt: quotes.updatedAt,
      versionNumber: quoteVersions.versionNumber,
      versionState: quoteVersions.state,
      documentType: quoteVersions.documentType,
      audience: quoteVersions.audience,
      projectName: quoteVersions.projectName,
      purchaseOrderNumber: quoteVersions.purchaseOrderNumber,
      totalMinCents: quoteVersions.totalMinCents,
      totalMaxCents: quoteVersions.totalMaxCents,
      depositCents: quoteVersions.depositCents,
      expiresAt: quoteVersions.expiresAt,
      clientName: quoteVersions.clientName,
      clientCompany: quoteVersions.clientCompany,
      propertyAddress: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      ownerId: salesOpportunities.ownerTeamMemberId,
      ownerName: sql<string | null>`(
        select ${teamMembers.name} from ${teamMembers}
        where ${teamMembers.id} = ${salesOpportunities.ownerTeamMemberId}
        limit 1
      )`,
      opportunityId: salesOpportunities.id,
      opportunityName: salesOpportunities.name,
      hasOpenChange: openChange,
      deliveryStatus: latestDeliveryStatus,
      sortPrimary: primarySort,
    })
    .from(quotes)
    .leftJoin(quoteVersions, eq(quoteVersions.id, quotes.currentVersionId))
    .leftJoin(
      salesOpportunities,
      eq(salesOpportunities.id, quotes.salesOpportunityId),
    )
    .leftJoin(contacts, eq(contacts.id, quotes.contactId))
    .leftJoin(properties, eq(properties.id, quotes.propertyId))
    .where(and(...predicates))
    .orderBy(...order)
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const visible = hasMore ? rows.slice(0, query.limit) : rows;
  const last = visible.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeQuoteV2ListCursor({
          version: CURSOR_VERSION,
          filterHash: quoteV2ListFilterHash(query),
          sort: query.sort,
          primary: cursorPrimaryValue(
            query.sort,
            last.sortPrimary,
            last.updatedAt,
          ),
          secondary: last.updatedAt.toISOString(),
          id: last.id,
        })
      : null;
  return {
    quotes: visible.map((row) => ({
      id: row.id,
      quoteNumber: row.quoteNumber,
      aggregateState: row.aggregateState,
      quoteRevision: row.aggregateRevision,
      currentVersionId: row.currentVersionId,
      publishedVersionId: row.publishedVersionId,
      versionNumber: row.versionNumber,
      versionState: row.versionState,
      documentType: row.documentType,
      audience: row.audience,
      client: { name: row.clientName, company: row.clientCompany },
      project: {
        name: row.projectName ?? row.opportunityName,
        purchaseOrder: row.purchaseOrderNumber,
        property: {
          addressLine1: row.propertyAddress,
          city: row.propertyCity,
          state: row.propertyState,
        },
      },
      totals: {
        minimumCents: row.totalMinCents,
        maximumCents: row.totalMaxCents,
        depositCents: row.depositCents,
        currency: "USD",
      },
      expiresAt: iso(row.expiresAt),
      updatedAt: iso(row.updatedAt),
      deliveryState: deliveryLabel(row.deliveryStatus),
      owner: row.ownerId
        ? { id: row.ownerId, name: row.ownerName ?? "Assigned" }
        : null,
      opportunityId: row.opportunityId,
      bucket: rowBucket(row),
      nextAction: rowNextAction(row),
    })),
    nextCursor,
  };
}

export async function getQuoteV2StaffDetail(
  db: DatabaseClient,
  quoteId: string,
): Promise<Record<string, unknown> | null> {
  const [quote] = await db
    .select({
      id: quotes.id,
      engineVersion: quotes.engineVersion,
      quoteNumber: quotes.quoteNumber,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      createdAt: quotes.createdAt,
      updatedAt: quotes.updatedAt,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactCompany: contacts.company,
      contactEmail: contacts.email,
      contactPhone: sql<
        string | null
      >`coalesce(${contacts.phoneE164}, ${contacts.phone})`,
      propertyId: properties.id,
      addressLine1: properties.addressLine1,
      addressLine2: properties.addressLine2,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      opportunityId: salesOpportunities.id,
      opportunityName: salesOpportunities.name,
      opportunityStatus: salesOpportunities.status,
      opportunityStage: salesOpportunities.pipelineStage,
      opportunityRevision: salesOpportunities.revision,
      ownerId: salesOpportunities.ownerTeamMemberId,
      ownerName: sql<string | null>`(
        select ${teamMembers.name} from ${teamMembers}
        where ${teamMembers.id} = ${salesOpportunities.ownerTeamMemberId}
        limit 1
      )`,
    })
    .from(quotes)
    .leftJoin(contacts, eq(contacts.id, quotes.contactId))
    .leftJoin(properties, eq(properties.id, quotes.propertyId))
    .leftJoin(
      salesOpportunities,
      eq(salesOpportunities.id, quotes.salesOpportunityId),
    )
    .where(eq(quotes.id, quoteId))
    .limit(1);
  if (!quote || quote.engineVersion !== "v2") return null;

  const versions = await db
    .select({
      id: quoteVersions.id,
      versionNumber: quoteVersions.versionNumber,
      draftRevision: quoteVersions.draftRevision,
      supersedesVersionId: quoteVersions.supersedesVersionId,
      state: quoteVersions.state,
      provenance: quoteVersions.provenance,
      documentType: quoteVersions.documentType,
      audience: quoteVersions.audience,
      schedulingMode: quoteVersions.schedulingMode,
      documentSnapshot: quoteVersions.documentSnapshot,
      internalNotes: quoteVersions.internalNotes,
      totalMinCents: quoteVersions.totalMinCents,
      totalMaxCents: quoteVersions.totalMaxCents,
      depositCents: quoteVersions.depositCents,
      balanceMinCents: quoteVersions.balanceMinCents,
      balanceMaxCents: quoteVersions.balanceMaxCents,
      contentHash: quoteVersions.contentHash,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
      supersededAt: quoteVersions.supersededAt,
      createdAt: quoteVersions.createdAt,
      updatedAt: quoteVersions.updatedAt,
    })
    .from(quoteVersions)
    .where(eq(quoteVersions.quoteId, quote.id))
    .orderBy(desc(quoteVersions.versionNumber));
  const versionIds = versions.map((version) => version.id);
  const [
    documents,
    attachments,
    attempts,
    responses,
    activity,
    changes,
    capabilities,
  ] = await Promise.all([
    versionIds.length
      ? db
          .select({
            id: quoteVersionDocuments.id,
            quoteVersionId: quoteVersionDocuments.quoteVersionId,
            kind: quoteVersionDocuments.kind,
            filename: quoteVersionDocuments.filename,
            contentType: quoteVersionDocuments.contentType,
            byteSize: quoteVersionDocuments.byteSize,
            sha256: quoteVersionDocuments.sha256,
            generatedAt: quoteVersionDocuments.generatedAt,
          })
          .from(quoteVersionDocuments)
          .where(inArray(quoteVersionDocuments.quoteVersionId, versionIds))
          .orderBy(desc(quoteVersionDocuments.generatedAt))
      : Promise.resolve([]),
    versionIds.length
      ? db
          .select({
            id: quoteVersionAttachments.id,
            quoteVersionId: quoteVersionAttachments.quoteVersionId,
            mediaAssetId: quoteVersionAttachments.mediaAssetId,
            position: quoteVersionAttachments.position,
            label: quoteVersionAttachments.label,
            description: quoteVersionAttachments.description,
            customerVisible: quoteVersionAttachments.customerVisible,
          })
          .from(quoteVersionAttachments)
          .where(inArray(quoteVersionAttachments.quoteVersionId, versionIds))
          .orderBy(quoteVersionAttachments.position)
      : Promise.resolve([]),
    db
      .select({
        id: quoteSendAttempts.id,
        quoteVersionId: quoteSendAttempts.quoteVersionId,
        attemptNumber: quoteSendAttempts.attemptNumber,
        status: quoteSendAttempts.status,
        requestedAt: quoteSendAttempts.requestedAt,
        completedAt: quoteSendAttempts.completedAt,
        lastErrorCode: quoteSendAttempts.lastErrorCode,
        lastErrorDetail: quoteSendAttempts.lastErrorDetail,
      })
      .from(quoteSendAttempts)
      .where(eq(quoteSendAttempts.quoteId, quote.id))
      .orderBy(desc(quoteSendAttempts.requestedAt)),
    db
      .select({
        id: quoteResponses.id,
        quoteVersionId: quoteResponses.quoteVersionId,
        responseType: quoteResponses.responseType,
        source: quoteResponses.source,
        signer: quoteResponses.signerSnapshot,
        selectedOptionIds: quoteResponses.selectedOptionIds,
        reason: quoteResponses.reason,
        message: quoteResponses.message,
        consentVersion: quoteResponses.consentVersion,
        consentAffirmed: quoteResponses.consentAffirmed,
        contentHash: quoteResponses.contentHash,
        issuedPdfHash: quoteResponses.issuedPdfHash,
        totalMinCents: quoteResponses.acceptedTotalMinCents,
        totalMaxCents: quoteResponses.acceptedTotalMaxCents,
        depositCents: quoteResponses.acceptedDepositCents,
        respondedAt: quoteResponses.respondedAt,
      })
      .from(quoteResponses)
      .where(eq(quoteResponses.quoteId, quote.id))
      .orderBy(desc(quoteResponses.respondedAt)),
    db
      .select({
        id: quoteActivityEvents.id,
        quoteVersionId: quoteActivityEvents.quoteVersionId,
        eventType: quoteActivityEvents.eventType,
        actorType: quoteActivityEvents.actorType,
        actorTeamMemberId: quoteActivityEvents.actorTeamMemberId,
        correlationId: quoteActivityEvents.correlationId,
        occurredAt: quoteActivityEvents.occurredAt,
      })
      .from(quoteActivityEvents)
      .where(eq(quoteActivityEvents.quoteId, quote.id))
      .orderBy(
        desc(quoteActivityEvents.occurredAt),
        desc(quoteActivityEvents.id),
      ),
    db
      .select({
        id: quoteChangeRequests.id,
        quoteVersionId: quoteChangeRequests.quoteVersionId,
        ownerTaskId: quoteChangeRequests.ownerTaskId,
        dueAt: quoteChangeRequests.dueAt,
        status: quoteChangeRequests.status,
        reason: quoteChangeRequests.reason,
        message: quoteChangeRequests.message,
        resolutionNote: quoteChangeRequests.resolutionNote,
        resolutionKind: quoteChangeRequests.resolutionKind,
        resultingVersionId: quoteChangeRequests.resultingVersionId,
        resolvedByTeamMemberId: quoteChangeRequests.resolvedByTeamMemberId,
        resolvedByName: sql<string | null>`(
            select ${teamMembers.name} from ${teamMembers}
            where ${teamMembers.id} = ${quoteChangeRequests.resolvedByTeamMemberId}
            limit 1
          )`,
        resolvedAt: quoteChangeRequests.resolvedAt,
        createdAt: quoteChangeRequests.createdAt,
      })
      .from(quoteChangeRequests)
      .where(eq(quoteChangeRequests.quoteId, quote.id))
      .orderBy(desc(quoteChangeRequests.createdAt)),
    db
      .select({
        id: quoteCapabilities.id,
        quoteVersionId: quoteCapabilities.quoteVersionId,
        recipientRole: quoteCapabilities.recipientRole,
        status: quoteCapabilities.status,
        allowedActions: quoteCapabilities.allowedActions,
        issuedAt: quoteCapabilities.issuedAt,
        actionExpiresAt: quoteCapabilities.actionExpiresAt,
        readExpiresAt: quoteCapabilities.readExpiresAt,
        revokedAt: quoteCapabilities.revokedAt,
        revocationReason: quoteCapabilities.revocationReason,
        supersededAt: quoteCapabilities.supersededAt,
        lastUsedAt: quoteCapabilities.lastUsedAt,
        useCount: quoteCapabilities.useCount,
      })
      .from(quoteCapabilities)
      .where(eq(quoteCapabilities.quoteId, quote.id))
      .orderBy(desc(quoteCapabilities.issuedAt)),
  ]);
  const attemptIds = attempts.map((attempt) => attempt.id);
  const deliveries = attemptIds.length
    ? await db
        .select({
          id: quoteSendDeliveries.id,
          sendAttemptId: quoteSendDeliveries.sendAttemptId,
          channel: quoteSendDeliveries.channel,
          recipientRole: quoteSendDeliveries.recipientRole,
          recipientDisplayHint: quoteSendDeliveries.recipientDisplayHint,
          status: quoteSendDeliveries.status,
          provider: quoteSendDeliveries.provider,
          dispatchedAt: quoteSendDeliveries.dispatchedAt,
          deliveredAt: quoteSendDeliveries.deliveredAt,
          failedAt: quoteSendDeliveries.failedAt,
          errorCode: quoteSendDeliveries.errorCode,
          errorDetail: quoteSendDeliveries.errorDetail,
        })
        .from(quoteSendDeliveries)
        .where(inArray(quoteSendDeliveries.sendAttemptId, attemptIds))
        .orderBy(desc(quoteSendDeliveries.createdAt))
    : [];

  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    aggregateState: quote.aggregateState,
    quoteRevision: quote.aggregateRevision,
    currentVersionId: quote.currentVersionId,
    publishedVersionId: quote.publishedVersionId,
    acceptedAppointmentId: quote.acceptedAppointmentId,
    contact: quote.contactId
      ? {
          id: quote.contactId,
          name: [quote.contactFirstName, quote.contactLastName]
            .filter(Boolean)
            .join(" "),
          company: quote.contactCompany,
          email: quote.contactEmail,
          phone: quote.contactPhone,
        }
      : null,
    property: quote.propertyId
      ? {
          id: quote.propertyId,
          addressLine1: quote.addressLine1,
          addressLine2: quote.addressLine2,
          city: quote.city,
          state: quote.state,
          postalCode: quote.postalCode,
        }
      : null,
    opportunity: quote.opportunityId
      ? {
          id: quote.opportunityId,
          name: quote.opportunityName,
          status: quote.opportunityStatus,
          stage: quote.opportunityStage,
          revision: quote.opportunityRevision,
        }
      : null,
    owner: quote.ownerId
      ? { id: quote.ownerId, name: quote.ownerName ?? "Assigned" }
      : null,
    versions: versions.map((version) => ({
      ...version,
      issuedAt: iso(version.issuedAt),
      expiresAt: iso(version.expiresAt),
      supersededAt: iso(version.supersededAt),
      createdAt: iso(version.createdAt),
      updatedAt: iso(version.updatedAt),
    })),
    documents: documents.map((document) => ({
      ...document,
      generatedAt: iso(document.generatedAt),
      downloadPath:
        document.kind === "acceptance_pdf"
          ? `/api/quote-versions/${document.quoteVersionId}/acceptance-certificate`
          : null,
    })),
    attachments,
    sendAttempts: attempts.map((attempt) => ({
      ...attempt,
      requestedAt: iso(attempt.requestedAt),
      completedAt: iso(attempt.completedAt),
      deliveries: deliveries
        .filter((delivery) => delivery.sendAttemptId === attempt.id)
        .map((delivery) => ({
          ...delivery,
          dispatchedAt: iso(delivery.dispatchedAt),
          deliveredAt: iso(delivery.deliveredAt),
          failedAt: iso(delivery.failedAt),
        })),
    })),
    responses: responses.map((response) => ({
      ...response,
      respondedAt: iso(response.respondedAt),
    })),
    changeRequests: changes.map(
      ({ resolvedByTeamMemberId, resolvedByName, ...change }) => ({
        ...change,
        dueAt: iso(change.dueAt),
        createdAt: iso(change.createdAt),
        resolvedAt: iso(change.resolvedAt),
        resolvedBy: resolvedByTeamMemberId
          ? {
              id: resolvedByTeamMemberId,
              name: resolvedByName ?? "Team member",
            }
          : null,
      }),
    ),
    capabilities: capabilities.map((capability) => ({
      ...capability,
      issuedAt: iso(capability.issuedAt),
      actionExpiresAt: iso(capability.actionExpiresAt),
      readExpiresAt: iso(capability.readExpiresAt),
      revokedAt: iso(capability.revokedAt),
      supersededAt: iso(capability.supersededAt),
      lastUsedAt: iso(capability.lastUsedAt),
    })),
    activity: activity.map((event) => ({
      ...event,
      occurredAt: iso(event.occurredAt),
    })),
    createdAt: iso(quote.createdAt),
    updatedAt: iso(quote.updatedAt),
  };
}

export async function getQuoteV2StaffPreview(
  db: DatabaseClient,
  versionId: string,
): Promise<Record<string, unknown> | null> {
  const [version] = await db
    .select({
      quoteId: quoteVersions.quoteId,
      versionId: quoteVersions.id,
      versionNumber: quoteVersions.versionNumber,
      state: quoteVersions.state,
      engineVersion: quotes.engineVersion,
      quoteNumber: quotes.quoteNumber,
      document: quoteVersions.documentSnapshot,
      contentHash: quoteVersions.contentHash,
      totalMinCents: quoteVersions.totalMinCents,
      totalMaxCents: quoteVersions.totalMaxCents,
      depositCents: quoteVersions.depositCents,
      balanceMinCents: quoteVersions.balanceMinCents,
      balanceMaxCents: quoteVersions.balanceMaxCents,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
    })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(eq(quoteVersions.id, versionId))
    .limit(1);
  if (!version || version.engineVersion !== "v2") return null;
  let totals: Record<string, unknown> | null = null;
  if (version.state === "draft") {
    const parsed = QuoteDraftDocumentSchema.safeParse(version.document);
    if (parsed.success) {
      try {
        totals = calculateQuoteV2Totals(parsed.data.pricing);
      } catch (error) {
        if (!(error instanceof QuoteDomainError)) throw error;
      }
    }
  } else {
    totals = {
      totalMinCents: version.totalMinCents,
      totalMaxCents: version.totalMaxCents,
      depositCents: version.depositCents,
      balanceMinCents: version.balanceMinCents,
      balanceMaxCents: version.balanceMaxCents,
    };
  }
  const documents = await db
    .select({
      id: quoteVersionDocuments.id,
      kind: quoteVersionDocuments.kind,
      filename: quoteVersionDocuments.filename,
      contentType: quoteVersionDocuments.contentType,
      byteSize: quoteVersionDocuments.byteSize,
      sha256: quoteVersionDocuments.sha256,
      generatedAt: quoteVersionDocuments.generatedAt,
    })
    .from(quoteVersionDocuments)
    .where(eq(quoteVersionDocuments.quoteVersionId, versionId))
    .orderBy(desc(quoteVersionDocuments.generatedAt));
  return {
    quoteId: version.quoteId,
    versionId: version.versionId,
    quoteNumber: version.quoteNumber,
    versionNumber: version.versionNumber,
    state: version.state,
    document: version.document,
    totals,
    contentHash: version.contentHash,
    issuedAt: iso(version.issuedAt),
    expiresAt: iso(version.expiresAt),
    acceptanceCertificatePath:
      version.state === "accepted"
        ? `/api/quote-versions/${versionId}/acceptance-certificate`
        : null,
    documents: documents.map((document) => ({
      ...document,
      generatedAt: iso(document.generatedAt),
      downloadPath:
        document.kind === "acceptance_pdf"
          ? `/api/quote-versions/${versionId}/acceptance-certificate`
          : null,
    })),
  };
}

export async function createQuoteV2Revision(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    command: QuoteV2RevisionCommand;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<{
  quoteId: string;
  versionId: string;
  sourceVersionId: string;
  versionNumber: number;
  draftRevision: number;
  quoteRevision: number;
  state: "draft";
}> {
  const command = QuoteV2RevisionCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const [quote] = await tx
    .select({
      id: quotes.id,
      engineVersion: quotes.engineVersion,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
    })
    .from(quotes)
    .where(eq(quotes.id, input.quoteId))
    .for("update")
    .limit(1);
  if (!quote || quote.engineVersion !== "v2") {
    throw new TeamMutationFailure(
      "invalid",
      "The versioned quote was not found.",
      { status: 404 },
    );
  }
  if (
    quote.aggregateState !== "open" ||
    !quote.aggregateRevision ||
    quote.aggregateRevision !== input.expectedQuoteRevision ||
    quote.aggregateRevision !== command.quoteRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed or can no longer be revised. Refresh before continuing.",
      {
        retryable: true,
        fieldErrors: { version: "The published quote is stale." },
      },
    );
  }
  if (
    quote.publishedVersionId !== command.sourceVersionId ||
    quote.currentVersionId !== quote.publishedVersionId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "A revision is already in progress or a newer proposal is published.",
    );
  }
  const [source] = await tx
    .select()
    .from(quoteVersions)
    .where(
      and(
        eq(quoteVersions.id, command.sourceVersionId),
        eq(quoteVersions.quoteId, quote.id),
      ),
    )
    .limit(1);
  if (!source || !["issued", "expired"].includes(source.state)) {
    throw new TeamMutationFailure(
      "conflict",
      "Only the current issued or expired proposal can be revised.",
    );
  }
  const [maximum] = await tx
    .select({
      value: sql<number>`coalesce(max(${quoteVersions.versionNumber}), 0)::int`,
    })
    .from(quoteVersions)
    .where(eq(quoteVersions.quoteId, quote.id));
  const versionNumber = (maximum?.value ?? source.versionNumber) + 1;
  const versionId = randomUUID();
  await tx.insert(quoteVersions).values({
    id: versionId,
    quoteId: quote.id,
    versionNumber,
    draftRevision: 1,
    supersedesVersionId: source.id,
    state: "draft",
    provenance: "native",
    schemaVersion: source.schemaVersion,
    documentType: source.documentType,
    audience: source.audience,
    schedulingMode: source.schedulingMode,
    currency: source.currency,
    documentSnapshot: source.documentSnapshot,
    partySnapshot: source.partySnapshot,
    issuerSnapshot: source.issuerSnapshot,
    termsSnapshot: source.termsSnapshot,
    clientName: source.clientName,
    clientCompany: source.clientCompany,
    clientEmail: source.clientEmail,
    clientPhone: source.clientPhone,
    projectName: source.projectName,
    purchaseOrderNumber: source.purchaseOrderNumber,
    referenceNumber: source.referenceNumber,
    scope: source.scope,
    assumptions: source.assumptions,
    exclusions: source.exclusions,
    terms: source.terms,
    paymentTerms: source.paymentTerms,
    internalNotes: source.internalNotes,
    createdByTeamMemberId: input.actorTeamMemberId,
    createdAt: now,
    updatedAt: now,
  });
  const sourceAttachments = await tx
    .select()
    .from(quoteVersionAttachments)
    .where(eq(quoteVersionAttachments.quoteVersionId, source.id));
  if (sourceAttachments.length > 0) {
    await tx.insert(quoteVersionAttachments).values(
      sourceAttachments.map((attachment) => ({
        quoteVersionId: versionId,
        mediaAssetId: attachment.mediaAssetId,
        position: attachment.position,
        label: attachment.label,
        description: attachment.description,
        customerVisible: attachment.customerVisible,
        metadata: attachment.metadata,
        attachedByTeamMemberId: input.actorTeamMemberId,
        createdAt: now,
      })),
    );
  }
  const nextQuoteRevision = quote.aggregateRevision + 1;
  const [updated] = await tx
    .update(quotes)
    .set({
      currentVersionId: versionId,
      aggregateRevision: nextQuoteRevision,
      revision: nextQuoteRevision,
      updatedAt: now,
    })
    .where(
      and(
        eq(quotes.id, quote.id),
        eq(quotes.aggregateState, "open"),
        eq(quotes.aggregateRevision, quote.aggregateRevision),
        eq(quotes.currentVersionId, source.id),
        eq(quotes.publishedVersionId, source.id),
      ),
    )
    .returning({ id: quotes.id });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed while the revision was created. Retry shortly.",
      { retryable: true },
    );
  }
  await tx.insert(quoteActivityEvents).values({
    quoteId: quote.id,
    quoteVersionId: versionId,
    eventType: "quote.revision_created",
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    causationId: source.id,
    metadata: { sourceVersionId: source.id, reason: command.reason },
    occurredAt: now,
    createdAt: now,
  });
  return {
    quoteId: quote.id,
    versionId,
    sourceVersionId: source.id,
    versionNumber,
    draftRevision: 1,
    quoteRevision: nextQuoteRevision,
    state: "draft",
  };
}
