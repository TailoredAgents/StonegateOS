import {
  and,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  outboxEvents,
  paymentAttempts,
  payments,
  quoteChangeRequests,
  quotePdfDownloads,
  quoteResponses,
  quoteSendDeliveries,
  quoteVisibleEngagementEvents,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  salesOpportunities,
  type DatabaseClient,
} from "@/db";
import { getQuoteV2FeatureState } from "@/lib/feature-flags";
import { QuoteV2EventTypeSchema } from "@/lib/quote-v2-outbox-contract";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 30;
const KNOWN_QUOTE_EVENT_TYPES = QuoteV2EventTypeSchema.options;

const DELIVERY_STATES = [
  "queued",
  "dispatched",
  "delivered",
  "failed",
  "reconciliation_required",
  "suppressed",
] as const;
const RESPONSE_TYPES = [
  "accepted",
  "declined",
  "change_requested",
  "refresh_requested",
] as const;
const PAYMENT_ATTEMPT_STATES = [
  "created",
  "launched",
  "pending_verification",
  "completed",
  "failed",
  "expired",
  "canceled",
  "reconciliation_required",
] as const;

type CountRow = { status: string; count: number };

export type QuoteV2OperationsQuery = {
  lookbackDays: number;
};

export class QuoteV2OperationsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteV2OperationsInputError";
  }
}

export type QuoteV2OperationalAlert = {
  code: string;
  severity: "critical" | "warning";
  count: number;
  summary: string;
  runbookAnchor: string;
};

export type QuoteV2OperationalSnapshot = {
  generatedAt: string;
  window: { lookbackDays: number; since: string };
  featureFlags: ReturnType<typeof getQuoteV2FeatureState>;
  lifecycle: {
    created: number;
    ready: number;
    issued: number;
    accepted: number;
    booked: number;
    createToIssueAverageMinutes: number | null;
    createToIssueP95Minutes: number | null;
  };
  deliveries: Record<(typeof DELIVERY_STATES)[number], number>;
  responses: Record<(typeof RESPONSE_TYPES)[number], number>;
  engagement: {
    visibleProposalViews: number;
    pdfDownloads: number;
  };
  changes: {
    open: number;
    overdue: number;
    unowned: number;
    oldestOpenAt: string | null;
  };
  scheduling: {
    activeHolds: number;
    expiredActiveHolds: number;
    acceptedWithoutAppointment: number;
  };
  deposits: {
    attempts: Record<(typeof PAYMENT_ATTEMPT_STATES)[number], number>;
    captured: number;
    capturedCents: number;
  };
  outbox: {
    pending: number;
    retrying: number;
    quarantined: number;
    unknownUnquarantined: number;
  };
  integrity: {
    rawLegacyTokenOnV2Quote: number;
    acceptanceEvidenceMissing: number;
    appointmentEvidenceMismatch: number;
    capturedDepositMismatch: number;
    duplicateTerminalResponse: number;
    duplicateCapturedDeposit: number;
    duplicateActiveBooking: number;
    changeWithoutOwnerTask: number;
    issuedDocumentMissing: number;
    versionPointerMismatch: number;
    closedOpportunityRegression: number;
  };
  alerts: QuoteV2OperationalAlert[];
};

function boundedInteger(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_LOOKBACK_DAYS;
  if (!/^\d{1,2}$/u.test(value.trim())) {
    throw new QuoteV2OperationsInputError(
      `lookbackDays must be a whole number from 1 through ${MAX_LOOKBACK_DAYS}.`,
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_LOOKBACK_DAYS
  ) {
    throw new QuoteV2OperationsInputError(
      `lookbackDays must be a whole number from 1 through ${MAX_LOOKBACK_DAYS}.`,
    );
  }
  return parsed;
}

export function parseQuoteV2OperationsQuery(
  searchParams: URLSearchParams,
): QuoteV2OperationsQuery {
  for (const key of searchParams.keys()) {
    if (key !== "lookbackDays" || searchParams.getAll(key).length !== 1) {
      throw new QuoteV2OperationsInputError(
        key === "lookbackDays"
          ? "lookbackDays may be supplied only once."
          : `Unsupported query field: ${key}.`,
      );
    }
  }
  return { lookbackDays: boundedInteger(searchParams.get("lookbackDays")) };
}

function countRecord<const T extends readonly string[]>(
  keys: T,
  rows: CountRow[],
): Record<T[number], number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    T[number],
    number
  >;
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
      counts[row.status as T[number]] = row.count;
    }
  }
  return counts;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function alert(
  code: string,
  severity: QuoteV2OperationalAlert["severity"],
  count: number,
  summary: string,
  runbookAnchor: string,
): QuoteV2OperationalAlert | null {
  return count > 0 ? { code, severity, count, summary, runbookAnchor } : null;
}

export function evaluateQuoteV2OperationalAlerts(
  snapshot: Omit<QuoteV2OperationalSnapshot, "alerts">,
): QuoteV2OperationalAlert[] {
  const candidates = [
    alert(
      "quote_v2_raw_capability_disclosure",
      "critical",
      snapshot.integrity.rawLegacyTokenOnV2Quote,
      "A V2 quote retained a raw legacy customer bearer token.",
      "#raw-capability-disclosure",
    ),
    alert(
      "quote_v2_acceptance_evidence_missing",
      "critical",
      snapshot.integrity.acceptanceEvidenceMissing,
      "An accepted response is missing exact signer, configuration, consent, or document evidence.",
      "#acceptance-evidence",
    ),
    alert(
      "quote_v2_total_mismatch",
      "critical",
      snapshot.integrity.appointmentEvidenceMismatch +
        snapshot.integrity.capturedDepositMismatch,
      "Accepted, deposited, and booked values do not reconcile.",
      "#value-mismatch",
    ),
    alert(
      "quote_v2_duplicate_terminal_state",
      "critical",
      snapshot.integrity.duplicateTerminalResponse +
        snapshot.integrity.duplicateCapturedDeposit +
        snapshot.integrity.duplicateActiveBooking,
      "Duplicate acceptance, captured deposit, or active booking evidence exists.",
      "#duplicate-conversion",
    ),
    alert(
      "quote_v2_change_without_task",
      "critical",
      snapshot.integrity.changeWithoutOwnerTask,
      "A versioned change request has no assigned owner task or due time.",
      "#change-request-sla",
    ),
    alert(
      "quote_v2_unknown_event",
      "critical",
      snapshot.outbox.unknownUnquarantined,
      "An unknown quote event has not been quarantined.",
      "#outbox-and-quarantine",
    ),
    alert(
      "quote_v2_closed_opportunity_regression",
      "critical",
      snapshot.integrity.closedOpportunityRegression,
      "A closed opportunity has regressed to an actionable quote state.",
      "#closed-opportunity-regression",
    ),
    alert(
      "quote_v2_orphaned_document_or_pointer",
      "critical",
      snapshot.integrity.issuedDocumentMissing +
        snapshot.integrity.versionPointerMismatch,
      "An issued native version lacks its immutable document or a quote points at another aggregate's version.",
      "#orphaned-evidence",
    ),
    alert(
      "quote_v2_change_sla_overdue",
      "warning",
      snapshot.changes.overdue,
      "One or more customer change requests exceeded the four-business-hour due time.",
      "#change-request-sla",
    ),
    alert(
      "quote_v2_delivery_failure",
      "warning",
      snapshot.deliveries.failed + snapshot.deliveries.reconciliation_required,
      "A quote delivery failed or requires reconciliation.",
      "#delivery-recovery",
    ),
    alert(
      "quote_v2_deposit_failure",
      "warning",
      snapshot.deposits.attempts.failed +
        snapshot.deposits.attempts.reconciliation_required,
      "A quote deposit attempt failed or requires reconciliation.",
      "#square-deposit-reconciliation",
    ),
    alert(
      "quote_v2_expired_active_hold",
      "warning",
      snapshot.scheduling.expiredActiveHolds,
      "An expired quote appointment hold is still marked active.",
      "#hold-recovery",
    ),
    alert(
      "quote_v2_outbox_quarantine",
      "warning",
      snapshot.outbox.quarantined,
      "One or more quote workflow events are quarantined for review.",
      "#outbox-and-quarantine",
    ),
  ];
  return candidates.filter(
    (candidate): candidate is QuoteV2OperationalAlert => candidate !== null,
  );
}

export async function loadQuoteV2OperationalSnapshot(
  db: DatabaseClient,
  query: QuoteV2OperationsQuery,
  options: { now?: Date } = {},
): Promise<QuoteV2OperationalSnapshot> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - query.lookbackDays * DAY_MS);
  const count = sql<number>`count(*)::integer`.mapWith(Number);

  const [
    quoteLifecycleRows,
    versionLifecycleRows,
    conversionRows,
    latencyRows,
    deliveryRows,
    responseRows,
    engagementRows,
    changeRows,
    holdRows,
    paymentAttemptRows,
    capturedRows,
    outboxRows,
    integrityRows,
  ] = await Promise.all([
    db
      .select({
        created:
          sql<number>`count(*) filter (where ${gte(quotes.createdAt, since)})::integer`.mapWith(
            Number,
          ),
      })
      .from(quotes)
      .where(eq(quotes.engineVersion, "v2")),
    db
      .select({
        ready:
          sql<number>`count(*) filter (where ${gte(quoteVersions.readyAt, since)})::integer`.mapWith(
            Number,
          ),
        issued:
          sql<number>`count(*) filter (where ${gte(quoteVersions.issuedAt, since)})::integer`.mapWith(
            Number,
          ),
      })
      .from(quoteVersions),
    db
      .select({
        accepted:
          sql<number>`count(*) filter (where ${quoteResponses.responseType} = 'accepted' and ${gte(quoteResponses.respondedAt, since)})::integer`.mapWith(
            Number,
          ),
        booked:
          sql<number>`count(*) filter (where ${isNotNull(appointments.quoteResponseId)} and ${gte(appointments.createdAt, since)} and ${appointments.status} <> 'canceled')::integer`.mapWith(
            Number,
          ),
        acceptedWithoutAppointment:
          sql<number>`count(*) filter (where ${quoteResponses.responseType} = 'accepted' and not exists (select 1 from ${appointments} a where a.quote_response_id = ${quoteResponses.id} and a.status <> 'canceled'))::integer`.mapWith(
            Number,
          ),
      })
      .from(quoteResponses)
      .leftJoin(
        appointments,
        eq(appointments.quoteResponseId, quoteResponses.id),
      ),
    db
      .select({
        averageMinutes: sql<
          number | null
        >`avg(extract(epoch from (${quoteVersions.issuedAt} - ${quotes.createdAt})) / 60)::double precision`,
        p95Minutes: sql<
          number | null
        >`percentile_cont(0.95) within group (order by extract(epoch from (${quoteVersions.issuedAt} - ${quotes.createdAt})) / 60)::double precision`,
      })
      .from(quoteVersions)
      .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
      .where(
        and(
          eq(quotes.engineVersion, "v2"),
          isNotNull(quoteVersions.issuedAt),
          gte(quoteVersions.issuedAt, since),
        ),
      ),
    db
      .select({ status: quoteSendDeliveries.status, count })
      .from(quoteSendDeliveries)
      .where(gte(quoteSendDeliveries.createdAt, since))
      .groupBy(quoteSendDeliveries.status),
    db
      .select({ status: quoteResponses.responseType, count })
      .from(quoteResponses)
      .where(gte(quoteResponses.respondedAt, since))
      .groupBy(quoteResponses.responseType),
    db
      .select({
        visibleProposalViews:
          sql<number>`count(*) filter (where ${gte(quoteVisibleEngagementEvents.occurredAt, since)})::integer`.mapWith(
            Number,
          ),
        pdfDownloads:
          sql<number>`(select count(*)::integer from ${quotePdfDownloads} d where d.quote_version_id is not null and d.created_at >= ${since})`.mapWith(
            Number,
          ),
      })
      .from(quoteVisibleEngagementEvents),
    db
      .select({
        open: sql<number>`count(*) filter (where ${quoteChangeRequests.status} in ('open', 'acknowledged'))::integer`.mapWith(
          Number,
        ),
        overdue:
          sql<number>`count(*) filter (where ${quoteChangeRequests.status} in ('open', 'acknowledged') and ${lt(quoteChangeRequests.dueAt, now)})::integer`.mapWith(
            Number,
          ),
        unowned:
          sql<number>`count(*) filter (where ${isNotNull(quoteChangeRequests.quoteVersionId)} and ${quoteChangeRequests.status} in ('open', 'acknowledged') and (${isNull(quoteChangeRequests.ownerTaskId)} or ${isNull(quoteChangeRequests.dueAt)}))::integer`.mapWith(
            Number,
          ),
        oldestOpenAt: sql<Date | null>`min(${quoteChangeRequests.createdAt}) filter (where ${quoteChangeRequests.status} in ('open', 'acknowledged'))`,
      })
      .from(quoteChangeRequests),
    db
      .select({
        active:
          sql<number>`count(*) filter (where ${appointmentHolds.status} = 'active' and ${isNotNull(appointmentHolds.quoteVersionId)})::integer`.mapWith(
            Number,
          ),
        expiredActive:
          sql<number>`count(*) filter (where ${appointmentHolds.status} = 'active' and ${isNotNull(appointmentHolds.quoteVersionId)} and ${lt(appointmentHolds.expiresAt, now)})::integer`.mapWith(
            Number,
          ),
      })
      .from(appointmentHolds),
    db
      .select({ status: paymentAttempts.status, count })
      .from(paymentAttempts)
      .where(
        and(
          isNotNull(paymentAttempts.quoteVersionId),
          eq(paymentAttempts.quotePaymentKind, "deposit"),
          gte(paymentAttempts.createdAt, since),
        ),
      )
      .groupBy(paymentAttempts.status),
    db
      .select({
        count: sql<number>`count(*)::integer`.mapWith(Number),
        cents:
          sql<number>`coalesce(sum(${payments.amount}), 0)::bigint`.mapWith(
            Number,
          ),
      })
      .from(payments)
      .where(
        and(
          eq(payments.quotePaymentKind, "deposit"),
          eq(payments.canonicalStatus, "completed"),
          gte(payments.createdAt, since),
        ),
      ),
    db
      .select({
        pending:
          sql<number>`count(*) filter (where ${isNull(outboxEvents.processedAt)} and ${isNull(outboxEvents.quarantinedAt)})::integer`.mapWith(
            Number,
          ),
        retrying:
          sql<number>`count(*) filter (where ${isNull(outboxEvents.processedAt)} and ${isNull(outboxEvents.quarantinedAt)} and ${outboxEvents.attempts} > 0)::integer`.mapWith(
            Number,
          ),
        quarantined:
          sql<number>`count(*) filter (where ${isNotNull(outboxEvents.quarantinedAt)})::integer`.mapWith(
            Number,
          ),
        unknownUnquarantined:
          sql<number>`count(*) filter (where ${notInArray(outboxEvents.type, KNOWN_QUOTE_EVENT_TYPES)} and ${isNull(outboxEvents.quarantinedAt)})::integer`.mapWith(
            Number,
          ),
      })
      .from(outboxEvents)
      .where(sql`${outboxEvents.type} like 'quote.%'`),
    db
      .select({
        rawLegacyTokenOnV2Quote:
          sql<number>`(select count(*)::integer from ${quotes} q where q.engine_version = 'v2' and q.share_token is not null)`.mapWith(
            Number,
          ),
        acceptanceEvidenceMissing:
          sql<number>`(select count(*)::integer from ${quoteResponses} r where r.response_type = 'accepted' and (r.signer_snapshot is null or r.configuration_snapshot is null or r.consent_affirmed is not true or r.configuration_hash is null or r.consent_hash is null or r.content_hash is null or r.issued_pdf_hash is null))`.mapWith(
            Number,
          ),
        appointmentEvidenceMismatch:
          sql<number>`(select count(*)::integer from ${appointments} a join ${quoteResponses} r on r.id = a.quote_response_id where a.quote_response_id is not null and (a.quote_version_id is distinct from r.quote_version_id or a.quote_configuration_hash is distinct from r.configuration_hash or a.quote_content_hash is distinct from r.content_hash or a.quoted_total_cents is distinct from r.accepted_total_min_cents or a.quoted_total_max_cents is distinct from r.accepted_total_max_cents))`.mapWith(
            Number,
          ),
        capturedDepositMismatch:
          sql<number>`(select count(*)::integer from ${payments} p join ${quoteResponses} r on r.id = p.quote_response_id where p.quote_payment_kind = 'deposit' and p.canonical_status = 'completed' and (p.quote_version_id is distinct from r.quote_version_id or p.amount is distinct from r.accepted_deposit_cents or upper(p.currency) <> 'USD'))`.mapWith(
            Number,
          ),
        duplicateTerminalResponse:
          sql<number>`(select count(*)::integer from (select r.quote_version_id from ${quoteResponses} r where r.response_type in ('accepted', 'declined') group by r.quote_version_id having count(*) > 1) d)`.mapWith(
            Number,
          ),
        duplicateCapturedDeposit:
          sql<number>`(select count(*)::integer from (select p.quote_response_id from ${payments} p where p.quote_response_id is not null and p.quote_payment_kind = 'deposit' and p.canonical_status = 'completed' group by p.quote_response_id having count(*) > 1) d)`.mapWith(
            Number,
          ),
        duplicateActiveBooking:
          sql<number>`(select count(*)::integer from (select a.quote_response_id from ${appointments} a where a.quote_response_id is not null and a.status <> 'canceled' group by a.quote_response_id having count(*) > 1) d)`.mapWith(
            Number,
          ),
        changeWithoutOwnerTask:
          sql<number>`(select count(*)::integer from ${quoteChangeRequests} c where c.quote_version_id is not null and c.status in ('open', 'acknowledged') and (c.owner_task_id is null or c.due_at is null))`.mapWith(
            Number,
          ),
        issuedDocumentMissing:
          sql<number>`(select count(*)::integer from ${quoteVersions} v where v.provenance = 'native' and v.state in ('issued', 'superseded', 'accepted', 'expired', 'declined') and not exists (select 1 from ${quoteVersionDocuments} d where d.quote_version_id = v.id and d.kind = 'proposal_pdf'))`.mapWith(
            Number,
          ),
        versionPointerMismatch:
          sql<number>`(select count(*)::integer from ${quotes} q where q.engine_version = 'v2' and ((q.current_version_id is not null and not exists (select 1 from ${quoteVersions} v where v.id = q.current_version_id and v.quote_id = q.id)) or (q.published_version_id is not null and not exists (select 1 from ${quoteVersions} v where v.id = q.published_version_id and v.quote_id = q.id))))`.mapWith(
            Number,
          ),
        closedOpportunityRegression:
          sql<number>`(select count(*)::integer from ${quotes} q join ${salesOpportunities} o on o.id = q.sales_opportunity_id where o.status in ('won', 'lost', 'archived') and q.aggregate_state in ('draft', 'open'))`.mapWith(
            Number,
          ),
      })
      .from(sql`(select 1) as quote_operations_singleton`),
  ]);

  const lifecycle = quoteLifecycleRows[0] ?? { created: 0 };
  const versions = versionLifecycleRows[0] ?? { ready: 0, issued: 0 };
  const conversions = conversionRows[0] ?? {
    accepted: 0,
    booked: 0,
    acceptedWithoutAppointment: 0,
  };
  const latency = latencyRows[0] ?? {
    averageMinutes: null,
    p95Minutes: null,
  };
  const changes = changeRows[0] ?? {
    open: 0,
    overdue: 0,
    unowned: 0,
    oldestOpenAt: null,
  };
  const engagement = engagementRows[0] ?? {
    visibleProposalViews: 0,
    pdfDownloads: 0,
  };
  const holds = holdRows[0] ?? { active: 0, expiredActive: 0 };
  const captured = capturedRows[0] ?? { count: 0, cents: 0 };
  const outbox = outboxRows[0] ?? {
    pending: 0,
    retrying: 0,
    quarantined: 0,
    unknownUnquarantined: 0,
  };
  const integrity = integrityRows[0] ?? {
    rawLegacyTokenOnV2Quote: 0,
    acceptanceEvidenceMissing: 0,
    appointmentEvidenceMismatch: 0,
    capturedDepositMismatch: 0,
    duplicateTerminalResponse: 0,
    duplicateCapturedDeposit: 0,
    duplicateActiveBooking: 0,
    changeWithoutOwnerTask: 0,
    issuedDocumentMissing: 0,
    versionPointerMismatch: 0,
    closedOpportunityRegression: 0,
  };

  const withoutAlerts: Omit<QuoteV2OperationalSnapshot, "alerts"> = {
    generatedAt: now.toISOString(),
    window: { lookbackDays: query.lookbackDays, since: since.toISOString() },
    featureFlags: getQuoteV2FeatureState(),
    lifecycle: {
      created: lifecycle.created,
      ready: versions.ready,
      issued: versions.issued,
      accepted: conversions.accepted,
      booked: conversions.booked,
      createToIssueAverageMinutes: latency.averageMinutes,
      createToIssueP95Minutes: latency.p95Minutes,
    },
    deliveries: countRecord(DELIVERY_STATES, deliveryRows),
    responses: countRecord(RESPONSE_TYPES, responseRows),
    engagement,
    changes: {
      open: changes.open,
      overdue: changes.overdue,
      unowned: changes.unowned,
      oldestOpenAt: iso(changes.oldestOpenAt),
    },
    scheduling: {
      activeHolds: holds.active,
      expiredActiveHolds: holds.expiredActive,
      acceptedWithoutAppointment: conversions.acceptedWithoutAppointment,
    },
    deposits: {
      attempts: countRecord(PAYMENT_ATTEMPT_STATES, paymentAttemptRows),
      captured: captured.count,
      capturedCents: captured.cents,
    },
    outbox,
    integrity,
  };
  return {
    ...withoutAlerts,
    alerts: evaluateQuoteV2OperationalAlerts(withoutAlerts),
  };
}
