import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerJobChangeOrders,
  partnerQuotes,
  quoteActivityEvents,
  quoteChangeRequests,
  quoteResponses,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  salesOpportunities,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { acquirePartnerJobMutationLock } from "@/lib/partner-job-change-request-lifecycle";
import {
  loadOfferedPartnerJobChangeOrderForQuote,
  resolvePartnerJobChangeOrderFromQuoteResponse,
} from "@/lib/partner-job-change-orders";
import { partnerQuoteApprovalAllowsAcceptance } from "@/lib/partner-quote-v2-approval";
import {
  lockPartnerQuoteLocationForCommercialAction,
  partnerQuoteTargetLocationActiveExpression,
} from "@/lib/partner-quote-location-safety";
import { QuoteDocumentSnapshotSchema } from "@/lib/quote-v2-contract";
import {
  prepareQuoteV2AcceptanceEvidence,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import {
  persistQuoteV2TerminalDecision,
  QuoteV2TerminalDecisionConflict,
} from "@/lib/quote-v2-terminal-decision";
import {
  createPortalV2StrongEtag,
  encodePortalV2Cursor,
  evaluatePortalV2RevisionPrecondition,
  parsePortalV2Pagination,
  type PortalV2StrongEtag,
} from "@/lib/portal-v2-contract";
import { normalizePartnerJobAccessScope } from "@/lib/partner-portal-v2-resource-authorization";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";
import { TeamMutationFailure } from "@/lib/team-mutation";

const QUOTE_STATUSES = new Set([
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "superseded",
]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

type QuoteAccess = Pick<
  PartnerPrincipal,
  "accountId" | "membershipId" | "accessLevel" | "accessScope"
>;

type PartnerQuoteCursor = Readonly<{
  accountId: string;
  status: string | null;
  lastAt: string;
  lastId: string;
}>;

export type PartnerQuoteDecisionCommand =
  | Readonly<{
      decision: "accepted";
      signer: Readonly<{ name: string; title: string; company?: string }>;
      authorityAffirmed: true;
      consentAffirmed: true;
      selectedOptionIds: readonly string[];
      consentVersion: string;
    }>
  | Readonly<{
      decision: "declined";
      signer: Readonly<{ name: string; title?: string; company?: string }>;
      category: "price" | "scope" | "timing" | "competitor" | "other";
      notes?: string;
    }>;

function money(amountMinor: number, currency: string) {
  if (!Number.isSafeInteger(amountMinor) || !CURRENCY_PATTERN.test(currency)) {
    throw new TypeError("partner_quote_money_invalid");
  }
  return { amountMinor, currency, minorUnit: 2 };
}

function safeText(value: string | null, maximum = 240): string | null {
  if (!value) return null;
  const normalized = [...value.normalize("NFKC")]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127 ? " " : character;
    })
    .join("");
  return normalized.replace(/\s+/gu, " ").trim().slice(0, maximum) || null;
}

function currentStatusExpression(now: Date): SQL<string> {
  return sql<string>`case
    when ${partnerQuotes.authority} = 'legacy_snapshot' then ${partnerQuotes.status}
    when ${quoteVersions.state} in ('draft', 'ready') then 'draft'
    when ${quoteVersions.state} = 'issued' and ${quoteVersions.expiresAt} <= ${now} then 'expired'
    when ${quoteVersions.state} = 'issued' then 'sent'
    else ${quoteVersions.state}
  end`;
}

function quoteScopeCondition(access: QuoteAccess): SQL {
  if (!access.accountId || !access.membershipId) return sql`false`;
  if (access.accessLevel === "account") return sql`true`;
  const scope = normalizePartnerJobAccessScope(access);
  const bookingGrants: SQL[] = [];
  const draftGrants: SQL[] = [];
  const locationGrants: SQL[] = [];
  if (scope.propertyIds.length > 0) {
    bookingGrants.push(
      inArray(sql`quote_job.property_id`, [...scope.propertyIds]),
    );
    draftGrants.push(
      inArray(sql`quote_draft_location.property_id`, [...scope.propertyIds]),
    );
    locationGrants.push(
      inArray(sql`quote_location.property_id`, [...scope.propertyIds]),
    );
  }
  if (scope.locationIds.length > 0) {
    bookingGrants.push(
      inArray(sql`quote_job_location.id`, [...scope.locationIds]),
    );
    draftGrants.push(
      inArray(sql`quote_draft_location.id`, [...scope.locationIds]),
    );
    locationGrants.push(
      inArray(sql`quote_location.id`, [...scope.locationIds]),
    );
  }
  if (scope.costCenterIds.length > 0) {
    bookingGrants.push(sql`exists (
      select 1 from partner_account_cost_centers quote_cost_center
      where quote_cost_center.partner_account_id = ${partnerQuotes.partnerAccountId}
        and quote_cost_center.code = quote_job.cost_center
        and ${inArray(sql`quote_cost_center.id`, [...scope.costCenterIds])}
    )`);
  }
  const bookingGrant = or(...bookingGrants) ?? sql`false`;
  const draftGrant = or(...draftGrants) ?? sql`false`;
  const locationGrant = or(...locationGrants) ?? sql`false`;
  return sql`(
    (${partnerQuotes.partnerBookingId} is not null and exists (
      select 1
      from partner_bookings quote_job
      left join partner_account_locations quote_job_location
        on quote_job_location.partner_account_id = quote_job.partner_account_id
       and quote_job_location.property_id = quote_job.property_id
      where quote_job.id = ${partnerQuotes.partnerBookingId}
        and quote_job.partner_account_id = ${partnerQuotes.partnerAccountId}
        and (${bookingGrant})
    ))
    or (${partnerQuotes.bookingDraftId} is not null and exists (
      select 1
      from partner_booking_drafts quote_draft
      left join partner_account_locations quote_draft_location
        on quote_draft_location.partner_account_id = quote_draft.partner_account_id
       and quote_draft_location.id = quote_draft.location_id
      where quote_draft.id = ${partnerQuotes.bookingDraftId}
        and quote_draft.partner_account_id = ${partnerQuotes.partnerAccountId}
        and (${draftGrant})
    ))
    or (${partnerQuotes.partnerAccountLocationId} is not null and exists (
      select 1
      from partner_account_locations quote_location
      where quote_location.id = ${partnerQuotes.partnerAccountLocationId}
        and quote_location.partner_account_id = ${partnerQuotes.partnerAccountId}
        and (${locationGrant})
    ))
  )`;
}

function quoteRevision(input: {
  projectionId: string;
  aggregateRevision: number | null;
  versionId: string | null;
  state: string | null;
  updatedAt: Date;
}): string {
  return [
    "partner-quote",
    input.projectionId,
    input.aggregateRevision ?? "legacy",
    input.versionId ?? "none",
    input.state ?? "unknown",
    input.updatedAt.toISOString(),
  ].join(":");
}

function quoteEtag(
  input: Parameters<typeof quoteRevision>[0],
): PortalV2StrongEtag {
  return createPortalV2StrongEtag(quoteRevision(input));
}

function canonicalAmounts(row: {
  currency: string | null;
  subtotalMinCents: number | null;
  subtotalMaxCents: number | null;
  discountMinCents: number | null;
  discountMaxCents: number | null;
  totalMinCents: number | null;
  totalMaxCents: number | null;
  depositCents: number | null;
}): Record<string, unknown> | null {
  const currency = row.currency;
  if (
    !currency ||
    row.subtotalMinCents === null ||
    row.subtotalMaxCents === null ||
    row.discountMinCents === null ||
    row.discountMaxCents === null ||
    row.totalMinCents === null ||
    row.totalMaxCents === null ||
    row.depositCents === null
  ) {
    return null;
  }
  return {
    subtotalMin: money(row.subtotalMinCents, currency),
    subtotalMax: money(row.subtotalMaxCents, currency),
    discountMin: money(row.discountMinCents, currency),
    discountMax: money(row.discountMaxCents, currency),
    totalMin: money(row.totalMinCents, currency),
    totalMax: money(row.totalMaxCents, currency),
    deposit: money(row.depositCents, currency),
  };
}

export async function listCanonicalPartnerQuotes(input: {
  principal: QuoteAccess;
  params: URLSearchParams;
  now?: Date;
}): Promise<
  | {
      ok: true;
      items: Array<Record<string, unknown>>;
      limit: number;
      nextCursor: string | null;
    }
  | {
      ok: false;
      status: number;
      error: "invalid_cursor" | "invalid_fields";
      fieldErrors: Record<string, string>;
    }
> {
  if (!input.principal.accountId) {
    return {
      ok: false,
      status: 422,
      error: "invalid_fields",
      fieldErrors: { account: "Select an account." },
    };
  }
  const statuses = input.params.getAll("status");
  const status = statuses.length === 0 ? null : (statuses[0]?.trim() ?? null);
  if (statuses.length > 1 || (status && !QUOTE_STATUSES.has(status))) {
    return {
      ok: false,
      status: 422,
      error: "invalid_fields",
      fieldErrors: { status: "Choose one supported quote status." },
    };
  }
  const pagination = parsePortalV2Pagination(input.params, {
    cursorKind: "partner.quotes",
    allowedQueryKeys: new Set(["status"]),
    validateCursorPayload: (value): value is PartnerQuoteCursor => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, unknown>;
      return (
        record["accountId"] === input.principal.accountId &&
        record["status"] === status &&
        typeof record["lastAt"] === "string" &&
        !Number.isNaN(new Date(record["lastAt"]).getTime()) &&
        typeof record["lastId"] === "string"
      );
    },
  });
  if (!pagination.ok) {
    return {
      ok: false,
      status: 422,
      error: pagination.fieldErrors["cursor"]
        ? "invalid_cursor"
        : "invalid_fields",
      fieldErrors: { ...pagination.fieldErrors },
    };
  }
  const now = input.now ?? new Date();
  const statusSql = currentStatusExpression(now);
  const cursor = pagination.cursor?.payload ?? null;
  const cursorAt = cursor ? new Date(cursor.lastAt) : null;
  const rows = await getDb()
    .select({
      id: partnerQuotes.id,
      authority: partnerQuotes.authority,
      bookingId: partnerQuotes.partnerBookingId,
      bookingDraftId: partnerQuotes.bookingDraftId,
      locationId: partnerQuotes.partnerAccountLocationId,
      targetLocationActive: partnerQuoteTargetLocationActiveExpression(),
      legacyQuoteNumber: partnerQuotes.quoteNumber,
      legacyVersion: partnerQuotes.version,
      legacyCurrency: partnerQuotes.currency,
      legacySubtotalCents: partnerQuotes.subtotalCents,
      legacyTaxCents: partnerQuotes.taxCents,
      legacyDiscountCents: partnerQuotes.discountCents,
      legacyTotalCents: partnerQuotes.totalCents,
      legacyLines: partnerQuotes.lines,
      legacyDocumentId: partnerQuotes.documentId,
      legacyExpiresAt: partnerQuotes.expiresAt,
      legacySentAt: partnerQuotes.sentAt,
      quoteNumber: quotes.quoteNumber,
      aggregateRevision: quotes.aggregateRevision,
      versionId: quoteVersions.id,
      versionNumber: quoteVersions.versionNumber,
      state: quoteVersions.state,
      status: statusSql,
      currency: quoteVersions.currency,
      subtotalMinCents: quoteVersions.subtotalMinCents,
      subtotalMaxCents: quoteVersions.subtotalMaxCents,
      discountMinCents: quoteVersions.discountMinCents,
      discountMaxCents: quoteVersions.discountMaxCents,
      totalMinCents: quoteVersions.totalMinCents,
      totalMaxCents: quoteVersions.totalMaxCents,
      depositCents: quoteVersions.depositCents,
      projectName: quoteVersions.projectName,
      expiresAt: quoteVersions.expiresAt,
      issuedAt: quoteVersions.issuedAt,
      createdAt: partnerQuotes.createdAt,
      updatedAt: partnerQuotes.updatedAt,
    })
    .from(partnerQuotes)
    .leftJoin(
      quotes,
      and(
        eq(quotes.id, partnerQuotes.quoteId),
        eq(quotes.partnerAccountId, partnerQuotes.partnerAccountId),
      ),
    )
    .leftJoin(
      quoteVersions,
      sql`${quoteVersions.id} = coalesce(${quotes.publishedVersionId}, ${quotes.currentVersionId})`,
    )
    .where(
      and(
        eq(partnerQuotes.partnerAccountId, input.principal.accountId),
        quoteScopeCondition(input.principal),
        status ? sql`${statusSql} = ${status}` : undefined,
        cursorAt && cursor
          ? or(
              lt(partnerQuotes.createdAt, cursorAt),
              and(
                eq(partnerQuotes.createdAt, cursorAt),
                lt(partnerQuotes.id, cursor.lastId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(partnerQuotes.createdAt), desc(partnerQuotes.id))
    .limit(pagination.limit + 1);
  const page = rows.slice(0, pagination.limit);
  const items = page.map((row) => {
    if (row.authority === "legacy_snapshot") {
      const currency = row.legacyCurrency ?? "USD";
      return {
        id: row.id,
        authority: "legacy_snapshot",
        actionable: false,
        notice:
          "Historical quote snapshot. Stonegate must reconcile it before online decisions are available.",
        quoteNumber: safeText(row.legacyQuoteNumber, 120),
        version: row.legacyVersion,
        status: row.status,
        projectName: null,
        bookingId: row.bookingId,
        bookingDraftId: row.bookingDraftId,
        locationId: null,
        amounts:
          row.legacySubtotalCents !== null &&
          row.legacyTaxCents !== null &&
          row.legacyDiscountCents !== null &&
          row.legacyTotalCents !== null
            ? {
                subtotal: money(row.legacySubtotalCents, currency),
                tax: money(row.legacyTaxCents, currency),
                discount: money(row.legacyDiscountCents, currency),
                total: money(row.legacyTotalCents, currency),
              }
            : null,
        lineCount: Array.isArray(row.legacyLines)
          ? Math.min(row.legacyLines.length, 10_000)
          : 0,
        expiresAt: row.legacyExpiresAt?.toISOString() ?? null,
        issuedAt: row.legacySentAt?.toISOString() ?? null,
        documentId: row.legacyDocumentId,
        allowedActions: [],
        etag: quoteEtag({
          projectionId: row.id,
          aggregateRevision: null,
          versionId: null,
          state: row.status,
          updatedAt: row.updatedAt,
        }),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }
    return {
      id: row.id,
      authority: "quote_v2",
      actionable: row.status === "sent" && row.targetLocationActive,
      notice: row.targetLocationActive
        ? null
        : "This quote remains available as financial evidence, but its location is archived and new responses are disabled.",
      quoteNumber: safeText(row.quoteNumber, 120),
      version: row.versionNumber,
      status: row.status,
      projectName: safeText(row.projectName, 240),
      bookingId: row.bookingId,
      bookingDraftId: row.bookingDraftId,
      locationId: row.locationId,
      amounts: canonicalAmounts(row),
      lineCount: null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      documentId: null,
      allowedActions: row.status === "sent" ? ["view"] : [],
      etag: quoteEtag({
        projectionId: row.id,
        aggregateRevision: row.aggregateRevision,
        versionId: row.versionId,
        state: row.state,
        updatedAt: row.updatedAt,
      }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
  const last = page.at(-1);
  return {
    ok: true,
    items,
    limit: pagination.limit,
    nextCursor:
      last && rows.length > pagination.limit
        ? encodePortalV2Cursor({
            kind: "partner.quotes",
            limit: pagination.limit,
            payload: {
              accountId: input.principal.accountId,
              status,
              lastAt: last.createdAt.toISOString(),
              lastId: last.id,
            } satisfies PartnerQuoteCursor,
          })
        : null,
  };
}

async function loadPartnerQuoteRow(input: {
  principal: QuoteAccess;
  partnerQuoteId: string;
  now: Date;
}) {
  if (!input.principal.accountId) return null;
  const [row] = await getDb()
    .select({
      projectionId: partnerQuotes.id,
      authority: partnerQuotes.authority,
      accountId: partnerQuotes.partnerAccountId,
      bookingId: partnerQuotes.partnerBookingId,
      bookingDraftId: partnerQuotes.bookingDraftId,
      locationId: partnerQuotes.partnerAccountLocationId,
      targetLocationActive: partnerQuoteTargetLocationActiveExpression(),
      legacyQuoteNumber: partnerQuotes.quoteNumber,
      legacyVersion: partnerQuotes.version,
      legacyStatus: partnerQuotes.status,
      legacyCurrency: partnerQuotes.currency,
      legacySubtotalCents: partnerQuotes.subtotalCents,
      legacyTaxCents: partnerQuotes.taxCents,
      legacyDiscountCents: partnerQuotes.discountCents,
      legacyTotalCents: partnerQuotes.totalCents,
      legacyLines: partnerQuotes.lines,
      legacyTerms: partnerQuotes.terms,
      legacyExpiresAt: partnerQuotes.expiresAt,
      legacySentAt: partnerQuotes.sentAt,
      legacyDocumentId: partnerQuotes.documentId,
      quoteId: quotes.id,
      quoteNumber: quotes.quoteNumber,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
      opportunityId: quotes.salesOpportunityId,
      contactId: quotes.contactId,
      versionId: quoteVersions.id,
      versionNumber: quoteVersions.versionNumber,
      versionState: quoteVersions.state,
      documentSnapshot: quoteVersions.documentSnapshot,
      currency: quoteVersions.currency,
      subtotalMinCents: quoteVersions.subtotalMinCents,
      subtotalMaxCents: quoteVersions.subtotalMaxCents,
      discountMinCents: quoteVersions.discountMinCents,
      discountMaxCents: quoteVersions.discountMaxCents,
      totalMinCents: quoteVersions.totalMinCents,
      totalMaxCents: quoteVersions.totalMaxCents,
      depositCents: quoteVersions.depositCents,
      balanceMinCents: quoteVersions.balanceMinCents,
      balanceMaxCents: quoteVersions.balanceMaxCents,
      contentHash: quoteVersions.contentHash,
      projectName: quoteVersions.projectName,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
      createdAt: partnerQuotes.createdAt,
      updatedAt: partnerQuotes.updatedAt,
    })
    .from(partnerQuotes)
    .leftJoin(
      quotes,
      and(
        eq(quotes.id, partnerQuotes.quoteId),
        eq(quotes.partnerAccountId, partnerQuotes.partnerAccountId),
      ),
    )
    .leftJoin(
      quoteVersions,
      sql`${quoteVersions.id} = coalesce(${quotes.publishedVersionId}, ${quotes.currentVersionId})`,
    )
    .where(
      and(
        eq(partnerQuotes.id, input.partnerQuoteId),
        eq(partnerQuotes.partnerAccountId, input.principal.accountId),
        quoteScopeCondition(input.principal),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getCanonicalPartnerQuote(input: {
  principal: QuoteAccess;
  partnerQuoteId: string;
  now?: Date;
}): Promise<{
  quote: Record<string, unknown>;
  etag: PortalV2StrongEtag;
} | null> {
  const now = input.now ?? new Date();
  const row = await loadPartnerQuoteRow({ ...input, now });
  if (!row) return null;
  if (row.authority === "legacy_snapshot") {
    const currency = row.legacyCurrency ?? "USD";
    const etag = quoteEtag({
      projectionId: row.projectionId,
      aggregateRevision: null,
      versionId: null,
      state: row.legacyStatus,
      updatedAt: row.updatedAt,
    });
    return {
      etag,
      quote: {
        id: row.projectionId,
        authority: "legacy_snapshot",
        actionable: false,
        notice:
          "This is a historical quote snapshot. Contact Stonegate to reconcile it before responding online.",
        quoteNumber: safeText(row.legacyQuoteNumber, 120),
        version: row.legacyVersion,
        status: row.legacyStatus,
        projectName: null,
        bookingId: row.bookingId,
        bookingDraftId: row.bookingDraftId,
        locationId: null,
        amounts:
          row.legacySubtotalCents !== null &&
          row.legacyTaxCents !== null &&
          row.legacyDiscountCents !== null &&
          row.legacyTotalCents !== null
            ? {
                subtotal: money(row.legacySubtotalCents, currency),
                tax: money(row.legacyTaxCents, currency),
                discount: money(row.legacyDiscountCents, currency),
                total: money(row.legacyTotalCents, currency),
              }
            : null,
        lineCount: Array.isArray(row.legacyLines)
          ? Math.min(row.legacyLines.length, 10_000)
          : 0,
        legacyTerms: safeText(row.legacyTerms, 20_000),
        expiresAt: row.legacyExpiresAt?.toISOString() ?? null,
        issuedAt: row.legacySentAt?.toISOString() ?? null,
        documentId: row.legacyDocumentId,
        allowedActions: [],
        etag,
        document: null,
        proposalDocument: null,
        response: null,
        history: [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }
  if (
    !row.quoteId ||
    !row.quoteNumber ||
    !row.versionId ||
    !row.versionNumber ||
    !row.aggregateRevision
  ) {
    return null;
  }
  const [proposal, response, history, openChange, changeOrder] =
    await Promise.all([
      getDb()
        .select({
          id: quoteVersionDocuments.id,
          filename: quoteVersionDocuments.filename,
          byteSize: quoteVersionDocuments.byteSize,
          sha256: quoteVersionDocuments.sha256,
        })
        .from(quoteVersionDocuments)
        .where(
          and(
            eq(quoteVersionDocuments.quoteVersionId, row.versionId),
            eq(quoteVersionDocuments.kind, "proposal_pdf"),
          ),
        )
        .orderBy(desc(quoteVersionDocuments.generatedAt))
        .limit(1),
      getDb()
        .select({
          id: quoteResponses.id,
          responseType: quoteResponses.responseType,
          respondedAt: quoteResponses.respondedAt,
        })
        .from(quoteResponses)
        .where(
          and(
            eq(quoteResponses.quoteId, row.quoteId),
            eq(quoteResponses.quoteVersionId, row.versionId),
            inArray(quoteResponses.responseType, ["accepted", "declined"]),
          ),
        )
        .limit(1),
      getDb()
        .select({
          id: quoteVersions.id,
          version: quoteVersions.versionNumber,
          state: quoteVersions.state,
          issuedAt: quoteVersions.issuedAt,
          expiresAt: quoteVersions.expiresAt,
        })
        .from(quoteVersions)
        .where(eq(quoteVersions.quoteId, row.quoteId))
        .orderBy(desc(quoteVersions.versionNumber)),
      getDb()
        .select({ id: quoteChangeRequests.id })
        .from(quoteChangeRequests)
        .where(
          and(
            eq(quoteChangeRequests.quoteId, row.quoteId),
            inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
          ),
        )
        .limit(1),
      getDb()
        .select({ state: partnerJobChangeOrders.state })
        .from(partnerJobChangeOrders)
        .where(
          and(
            eq(partnerJobChangeOrders.partnerAccountId, row.accountId),
            eq(partnerJobChangeOrders.partnerQuoteId, row.projectionId),
          ),
        )
        .limit(1),
    ]);
  const approvalAllowed = await getDb().transaction((tx) =>
    partnerQuoteApprovalAllowsAcceptance(tx, {
      accountId: row.accountId,
      bookingId: row.bookingId,
      bookingDraftId: row.bookingDraftId,
      totalMinCents: row.totalMinCents,
      totalMaxCents: row.totalMaxCents,
      currency: row.currency,
    }),
  );
  const expired = Boolean(row.expiresAt && row.expiresAt <= now);
  const exactIssued =
    row.targetLocationActive &&
    row.versionState === "issued" &&
    row.aggregateState === "open" &&
    row.currentVersionId === row.versionId &&
    row.publishedVersionId === row.versionId &&
    !expired &&
    !response[0] &&
    !openChange[0];
  const documentActions = proposal[0] ? ["download"] : [];
  const acceptanceAllowed =
    exactIssued && approvalAllowed && Boolean(proposal[0]);
  const allowedActions = exactIssued
    ? [...(acceptanceAllowed ? ["accept"] : []), "decline", ...documentActions]
    : proposal[0]
      ? ["download"]
      : [];
  const status =
    response[0]?.responseType ??
    (row.versionState === "issued" && expired ? "expired" : row.versionState);
  const document = QuoteDocumentSnapshotSchema.safeParse(row.documentSnapshot);
  const etag = quoteEtag({
    projectionId: row.projectionId,
    aggregateRevision: row.aggregateRevision,
    versionId: row.versionId,
    state: status,
    updatedAt: row.updatedAt,
  });
  return {
    etag,
    quote: {
      id: row.projectionId,
      authority: "quote_v2",
      actionable:
        allowedActions.includes("accept") || allowedActions.includes("decline"),
      notice:
        changeOrder[0]?.state === "offered"
          ? "This proposal is the change order for your job. Accepting confirms its price and listed details. The current schedule, service, and proof requirements stay in place until Stonegate confirms any related change separately."
          : changeOrder[0]?.state === "accepted"
            ? "This accepted proposal is the final price record for the change order. Any requested schedule, service, or proof changes still need separate Stonegate confirmation."
            : !row.targetLocationActive
              ? "This quote remains available as financial evidence, but its location is archived and new responses are disabled."
              : exactIssued && !proposal[0]
                ? "The issued proposal evidence is unavailable. Acceptance is disabled until Stonegate reconciles it."
                : exactIssued && !approvalAllowed
                  ? "Account approval is required before this proposal can be accepted."
                  : null,
      quoteNumber: row.quoteNumber,
      version: row.versionNumber,
      status,
      projectName: safeText(row.projectName, 240),
      bookingId: row.bookingId,
      bookingDraftId: row.bookingDraftId,
      locationId: row.locationId,
      amounts: canonicalAmounts(row),
      lineCount: document.success
        ? Math.min(document.data.pricing.lineItems.length, 100)
        : null,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      document: document.success ? document.data : null,
      legacyTerms: null,
      proposalDocument: proposal[0]
        ? {
            id: proposal[0].id,
            filename: safeText(proposal[0].filename, 240),
            byteSize: proposal[0].byteSize,
            sha256: proposal[0].sha256,
          }
        : null,
      response: response[0]
        ? {
            id: response[0].id,
            decision: response[0].responseType,
            respondedAt: response[0].respondedAt.toISOString(),
          }
        : null,
      history: history.map((version) => ({
        id: version.id,
        version: version.version,
        state: version.state,
        issuedAt: version.issuedAt?.toISOString() ?? null,
        expiresAt: version.expiresAt?.toISOString() ?? null,
        current: version.id === row.versionId,
      })),
      allowedActions,
      etag,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

function failure(
  status: number,
  error: string,
  headers?: Record<string, string>,
): PortalV2StoredResult {
  return {
    status,
    body: { ok: false, error },
    ...(headers ? { headers } : {}),
  };
}

export async function decideCanonicalPartnerQuote(input: {
  principal: PartnerPrincipal;
  partnerQuoteId: string;
  command: PartnerQuoteDecisionCommand;
  idempotencyKeyHash: string;
  requestHash: string;
  ifMatch: string | null;
  correlationId: string;
  now?: Date;
}): Promise<PortalV2StoredResult> {
  if (!input.principal.accountId || !input.principal.membershipId) {
    return failure(404, "not_found");
  }
  const now = input.now ?? new Date();
  try {
    const result = await getDb().transaction(async (tx) => {
      const [projection] = await tx
        .select({
          id: partnerQuotes.id,
          authority: partnerQuotes.authority,
          accountId: partnerQuotes.partnerAccountId,
          quoteId: partnerQuotes.quoteId,
          bookingId: partnerQuotes.partnerBookingId,
          bookingDraftId: partnerQuotes.bookingDraftId,
          updatedAt: partnerQuotes.updatedAt,
        })
        .from(partnerQuotes)
        .where(
          and(
            eq(partnerQuotes.id, input.partnerQuoteId),
            eq(partnerQuotes.partnerAccountId, input.principal.accountId!),
            quoteScopeCondition(input.principal),
          ),
        )
        .limit(1);
      if (
        !projection ||
        projection.authority !== "quote_v2" ||
        !projection.quoteId
      ) {
        return failure(404, "not_found");
      }
      const initialChangeOrder = await loadOfferedPartnerJobChangeOrderForQuote(
        tx,
        {
          partnerAccountId: input.principal.accountId!,
          partnerQuoteId: projection.id,
        },
      );
      if (initialChangeOrder) {
        await acquireScheduleConflictLock(tx);
        await acquirePartnerJobMutationLock(
          tx,
          input.principal.accountId!,
          initialChangeOrder.partnerBookingId,
        );
        const lockedChangeOrder =
          await loadOfferedPartnerJobChangeOrderForQuote(tx, {
            partnerAccountId: input.principal.accountId!,
            partnerQuoteId: projection.id,
          });
        if (
          !lockedChangeOrder ||
          lockedChangeOrder.partnerBookingId !==
            initialChangeOrder.partnerBookingId
        ) {
          return failure(409, "change_order_conflict");
        }
      }
      const [quote] = await tx
        .select({
          id: quotes.id,
          partnerAccountId: quotes.partnerAccountId,
          quoteNumber: quotes.quoteNumber,
          contactId: quotes.contactId,
          opportunityId: quotes.salesOpportunityId,
          aggregateState: quotes.aggregateState,
          aggregateRevision: quotes.aggregateRevision,
          currentVersionId: quotes.currentVersionId,
          publishedVersionId: quotes.publishedVersionId,
        })
        .from(quotes)
        .where(
          and(
            eq(quotes.id, projection.quoteId),
            eq(quotes.partnerAccountId, input.principal.accountId!),
            eq(quotes.engineVersion, "v2"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !quote ||
        !quote.quoteNumber ||
        !quote.opportunityId ||
        !quote.aggregateRevision ||
        !quote.publishedVersionId
      ) {
        return failure(404, "not_found");
      }
      const [version] = await tx
        .select({
          id: quoteVersions.id,
          versionNumber: quoteVersions.versionNumber,
          state: quoteVersions.state,
          documentSnapshot: quoteVersions.documentSnapshot,
          contentHash: quoteVersions.contentHash,
          currency: quoteVersions.currency,
          issuedAt: quoteVersions.issuedAt,
          expiresAt: quoteVersions.expiresAt,
        })
        .from(quoteVersions)
        .where(
          and(
            eq(quoteVersions.id, quote.publishedVersionId),
            eq(quoteVersions.quoteId, quote.id),
          ),
        )
        .for("update")
        .limit(1);
      if (!version) return failure(404, "not_found");

      const [replay] = await tx
        .select({
          id: quoteResponses.id,
          source: quoteResponses.source,
          responseType: quoteResponses.responseType,
          requestHash: quoteResponses.requestHash,
          partnerAccountId: quoteResponses.partnerAccountId,
          partnerMembershipId: quoteResponses.partnerMembershipId,
          partnerUserId: quoteResponses.partnerUserId,
          respondedAt: quoteResponses.respondedAt,
        })
        .from(quoteResponses)
        .where(
          and(
            eq(quoteResponses.quoteVersionId, version.id),
            eq(quoteResponses.idempotencyKeyHash, input.idempotencyKeyHash),
          ),
        )
        .limit(1);
      if (replay) {
        if (
          replay.source !== "partner_member" ||
          replay.responseType !== input.command.decision ||
          replay.requestHash !== input.requestHash ||
          replay.partnerAccountId !== input.principal.accountId ||
          replay.partnerMembershipId !== input.principal.membershipId ||
          replay.partnerUserId !== input.principal.partnerUserId
        ) {
          return failure(409, "idempotency_conflict");
        }
        const replayEtag = createPortalV2StrongEtag(
          quoteRevision({
            projectionId: projection.id,
            aggregateRevision: quote.aggregateRevision,
            versionId: version.id,
            state: version.state,
            updatedAt: projection.updatedAt,
          }),
        );
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              quoteId: projection.id,
              responseId: replay.id,
              decision: replay.responseType,
              quoteRevision: quote.aggregateRevision,
              respondedAt: replay.respondedAt.toISOString(),
              replayed: true,
              ...(replay.responseType === "accepted"
                ? { certificateState: "pending" }
                : {}),
            },
          },
          headers: { ETag: replayEtag },
        };
      }

      const currentRevision = quoteRevision({
        projectionId: projection.id,
        aggregateRevision: quote.aggregateRevision,
        versionId: version.id,
        state: version.state,
        updatedAt: projection.updatedAt,
      });
      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: input.ifMatch,
        currentRevision,
        correlationId: input.correlationId,
      });
      if (!precondition.ok) return precondition.response;
      if (
        !(await lockPartnerQuoteLocationForCommercialAction(tx, {
          quoteId: quote.id,
          accountId: input.principal.accountId!,
        }))
      ) {
        return failure(409, "quote_location_archived", {
          ETag: precondition.currentEtag,
        });
      }
      if (
        quote.aggregateState !== "open" ||
        quote.currentVersionId !== version.id ||
        quote.publishedVersionId !== version.id ||
        version.state !== "issued" ||
        !version.issuedAt ||
        !version.expiresAt ||
        version.expiresAt <= now
      ) {
        return failure(409, "quote_not_actionable", {
          ETag: precondition.currentEtag,
        });
      }
      const [openChange] = await tx
        .select({ id: quoteChangeRequests.id })
        .from(quoteChangeRequests)
        .where(
          and(
            eq(quoteChangeRequests.quoteId, quote.id),
            inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
          ),
        )
        .limit(1);
      if (openChange) return failure(409, "quote_change_pending");
      const [opportunity] = await tx
        .select({
          id: salesOpportunities.id,
          status: salesOpportunities.status,
          revision: salesOpportunities.revision,
        })
        .from(salesOpportunities)
        .where(eq(salesOpportunities.id, quote.opportunityId))
        .for("update")
        .limit(1);
      if (!opportunity || opportunity.status !== "open") {
        return failure(409, "quote_not_actionable");
      }
      const [proposal] = await tx
        .select({ sha256: quoteVersionDocuments.sha256 })
        .from(quoteVersionDocuments)
        .where(
          and(
            eq(quoteVersionDocuments.quoteVersionId, version.id),
            eq(quoteVersionDocuments.kind, "proposal_pdf"),
          ),
        )
        .orderBy(desc(quoteVersionDocuments.generatedAt))
        .limit(1);

      let responseValues: typeof quoteResponses.$inferInsert;
      let acceptedTotals:
        | ReturnType<typeof prepareQuoteV2AcceptanceEvidence>["totals"]
        | null = null;
      if (input.command.decision === "accepted") {
        if (!input.command.authorityAffirmed) {
          return failure(422, "authority_required");
        }
        let evidence;
        try {
          evidence = prepareQuoteV2AcceptanceEvidence({
            row: {
              documentSnapshot: version.documentSnapshot,
              quoteNumber: quote.quoteNumber,
              versionNumber: version.versionNumber,
              contentHash: version.contentHash,
              proposalPdfHash: proposal?.sha256 ?? null,
            },
            selectedOptionIds: [...input.command.selectedOptionIds],
            signer: {
              ...input.command.signer,
              authorityAffirmed: true,
            },
            consentVersion: input.command.consentVersion,
            consentAffirmed: input.command.consentAffirmed,
          });
        } catch (error) {
          if (error instanceof QuoteV2PublicStateError) {
            return failure(422, "invalid_acceptance_evidence");
          }
          throw error;
        }
        if (
          !(await partnerQuoteApprovalAllowsAcceptance(tx, {
            accountId: projection.accountId,
            bookingId: projection.bookingId,
            bookingDraftId: projection.bookingDraftId,
            totalMinCents: evidence.totals.totalMinCents,
            totalMaxCents: evidence.totals.totalMaxCents,
            currency: version.currency,
          }))
        ) {
          return failure(422, "approval_required");
        }
        acceptedTotals = evidence.totals;
        responseValues = {
          quoteId: quote.id,
          quoteVersionId: version.id,
          responseType: "accepted",
          source: "partner_member",
          partnerAccountId: input.principal.accountId,
          partnerMembershipId: input.principal.membershipId,
          partnerUserId: input.principal.partnerUserId,
          signerSnapshot: {
            ...evidence.signerSnapshot,
            authorityAffirmed: true,
            roleKey: input.principal.roleKey,
          },
          configurationSnapshot: evidence.configurationSnapshot,
          selectedOptionIds: evidence.selectedOptionIds,
          consentText: evidence.consentText,
          consentVersion: evidence.consentVersion,
          consentAffirmed: true,
          configurationHash: evidence.configurationHash,
          consentHash: evidence.consentHash,
          contentHash: evidence.contentHash,
          issuedPdfHash: evidence.issuedPdfHash,
          acceptedTotalMinCents: evidence.totals.totalMinCents,
          acceptedTotalMaxCents: evidence.totals.totalMaxCents,
          acceptedDepositCents: evidence.totals.depositCents,
          acceptedBalanceMinCents: evidence.totals.balanceMinCents,
          acceptedBalanceMaxCents: evidence.totals.balanceMaxCents,
          idempotencyKeyHash: input.idempotencyKeyHash,
          requestHash: input.requestHash,
          requestMetadata: {
            evidenceQuality: "exact",
            interactionSource: "partner_portal_v2",
            correlationId: input.correlationId,
            certificateIntent: {
              schemaVersion: 1,
              state: "pending",
              source: "immutable_quote_response",
            },
          },
          respondedAt: now,
          createdAt: now,
        };
      } else {
        responseValues = {
          quoteId: quote.id,
          quoteVersionId: version.id,
          responseType: "declined",
          source: "partner_member",
          partnerAccountId: input.principal.accountId,
          partnerMembershipId: input.principal.membershipId,
          partnerUserId: input.principal.partnerUserId,
          signerSnapshot: {
            ...input.command.signer,
            roleKey: input.principal.roleKey,
          },
          reason: input.command.category,
          message: input.command.notes ?? null,
          idempotencyKeyHash: input.idempotencyKeyHash,
          requestHash: input.requestHash,
          requestMetadata: {
            evidenceQuality: "basic",
            interactionSource: "partner_portal_v2",
            correlationId: input.correlationId,
          },
          respondedAt: now,
          createdAt: now,
        };
      }

      const terminal = await persistQuoteV2TerminalDecision(tx, {
        context: {
          quoteId: quote.id,
          quoteNumber: quote.quoteNumber,
          versionId: version.id,
          versionNumber: version.versionNumber,
          contactId: quote.contactId,
          opportunityId: opportunity.id,
          opportunityStatus: "open",
          opportunityRevision: opportunity.revision,
          quoteRevision: quote.aggregateRevision,
        },
        decision: input.command.decision,
        responseValues,
        acceptedTotals,
        decisionNotes:
          input.command.decision === "declined"
            ? [input.command.category, input.command.notes]
                .filter(Boolean)
                .join("\n")
            : null,
        correlationId: input.correlationId,
        now,
        ...(initialChangeOrder && input.command.decision === "accepted"
          ? {
              afterAcceptance: async (hookTx: typeof tx, hook) => {
                await resolvePartnerJobChangeOrderFromQuoteResponse(hookTx, {
                  partnerAccountId: input.principal.accountId!,
                  partnerQuoteId: projection.id,
                  quoteId: hook.quoteId,
                  quoteVersionId: hook.versionId,
                  quoteResponseId: hook.responseId,
                  actorMembershipId: input.principal.membershipId!,
                  decision: "accepted",
                  acceptedAmountMinor: acceptedTotals?.totalMinCents ?? null,
                  currency: version.currency,
                  correlationId: input.correlationId,
                  now,
                });
                return null;
              },
            }
          : {}),
      });
      if (initialChangeOrder && input.command.decision === "declined") {
        await resolvePartnerJobChangeOrderFromQuoteResponse(tx, {
          partnerAccountId: input.principal.accountId!,
          partnerQuoteId: projection.id,
          quoteId: quote.id,
          quoteVersionId: version.id,
          quoteResponseId: terminal.responseId,
          actorMembershipId: input.principal.membershipId!,
          decision: "declined",
          acceptedAmountMinor: null,
          currency: version.currency,
          correlationId: input.correlationId,
          now,
        });
      }
      await tx.insert(quoteActivityEvents).values({
        quoteId: quote.id,
        quoteVersionId: version.id,
        eventType: `quote.partner_${input.command.decision}`,
        actorType: "customer",
        outboxEventId: terminal.outboxEventId,
        causationId: terminal.responseId,
        correlationId: input.correlationId,
        metadata: {
          responseId: terminal.responseId,
          partnerAccountId: input.principal.accountId,
          partnerMembershipId: input.principal.membershipId,
          evidenceQuality:
            input.command.decision === "accepted" ? "exact" : "basic",
        },
        occurredAt: now,
        createdAt: now,
      });
      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: input.principal.partnerUserId,
        actorLabel: input.principal.email,
        actorRole: input.principal.roleKey,
        sessionId: input.principal.session.id,
        authMethod: "partner_session",
        correlationId: input.correlationId,
        requiredPermissions: ["quotes.respond"],
        outcome: "succeeded",
        surface: "partner_portal_v2",
        idempotencyKeyHash: input.idempotencyKeyHash,
        action: `partner.portal.v2.quote.${input.command.decision}`,
        entityType: "quote_response",
        entityId: terminal.responseId,
        meta: sanitizeAuditMetadata({
          accountId: input.principal.accountId,
          membershipId: input.principal.membershipId,
          partnerQuoteId: projection.id,
          quoteId: quote.id,
          versionId: version.id,
          requestHash: input.requestHash,
        }),
        createdAt: now,
      });
      const nextEtag = createPortalV2StrongEtag(
        quoteRevision({
          projectionId: projection.id,
          aggregateRevision: terminal.quoteRevision,
          versionId: version.id,
          state: input.command.decision,
          updatedAt: projection.updatedAt,
        }),
      );
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            quoteId: projection.id,
            responseId: terminal.responseId,
            decision: input.command.decision,
            quoteRevision: terminal.quoteRevision,
            respondedAt: now.toISOString(),
            replayed: false,
            ...(input.command.decision === "accepted"
              ? { certificateState: "pending" }
              : {}),
          },
        },
        headers: { ETag: nextEtag },
      } satisfies PortalV2StoredResult;
    });
    return result;
  } catch (error) {
    if (error instanceof TeamMutationFailure) {
      return failure(error.status, "change_order_conflict");
    }
    return error instanceof QuoteV2TerminalDecisionConflict ||
      isUniqueViolation(error)
      ? failure(409, "quote_conflict")
      : failure(503, "service_unavailable");
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return candidate.cause !== error && isUniqueViolation(candidate.cause);
}

export async function loadCanonicalPartnerQuoteDocument(input: {
  principal: QuoteAccess;
  partnerQuoteId: string;
}): Promise<{
  quoteId: string;
  versionId: string;
  filename: string;
  contentType: string;
  storageObjectKey: string;
  byteSize: number;
  sha256: string;
} | null> {
  const detail = await loadPartnerQuoteRow({
    principal: input.principal,
    partnerQuoteId: input.partnerQuoteId,
    now: new Date(),
  });
  if (
    !detail ||
    detail.authority !== "quote_v2" ||
    !detail.quoteId ||
    !detail.versionId
  ) {
    return null;
  }
  const [document] = await getDb()
    .select({
      filename: quoteVersionDocuments.filename,
      contentType: quoteVersionDocuments.contentType,
      storageObjectKey: quoteVersionDocuments.storageObjectKey,
      byteSize: quoteVersionDocuments.byteSize,
      sha256: quoteVersionDocuments.sha256,
    })
    .from(quoteVersionDocuments)
    .where(
      and(
        eq(quoteVersionDocuments.quoteVersionId, detail.versionId),
        eq(quoteVersionDocuments.kind, "proposal_pdf"),
      ),
    )
    .orderBy(desc(quoteVersionDocuments.generatedAt))
    .limit(1);
  return document
    ? {
        quoteId: detail.quoteId,
        versionId: detail.versionId,
        filename: document.filename,
        contentType: document.contentType,
        storageObjectKey: document.storageObjectKey,
        byteSize: document.byteSize,
        sha256: document.sha256,
      }
    : null;
}
