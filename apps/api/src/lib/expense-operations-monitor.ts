import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { DateTime } from "luxon";
import {
  dailyAdSpend,
  expenseReceiptCaptures,
  expenseReimbursementClaims,
  expenses,
  type DatabaseClient,
} from "@/db";
import {
  buildExpenseOverview,
  EXPENSE_OVERVIEW_TIME_ZONE,
  type ExpenseOverviewIncompleteReason,
  type ExpenseOverviewResult,
} from "@/lib/expense-overview";
import { loadExpenseOverviewInput } from "@/lib/expense-overview-repository";

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 90;
const DEFAULT_OVERVIEW_WEEKS = 4;
const MAX_OVERVIEW_WEEKS = 8;
const DAY_MS = 24 * 60 * 60 * 1_000;

const RECEIPT_STATUSES = [
  "pending_upload",
  "uploaded",
  "queued",
  "analyzing",
  "ready",
  "failed",
  "confirmed",
  "discarded",
] as const;
type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

const REIMBURSEMENT_BACKLOG_STATUSES = [
  "pending",
  "approved",
  "attached",
] as const;
type ReimbursementBacklogStatus =
  (typeof REIMBURSEMENT_BACKLOG_STATUSES)[number];

const AD_PLATFORMS = ["facebook", "google"] as const;
type AdPlatform = (typeof AD_PLATFORMS)[number];

const SAFE_RECEIPT_FAILURE_CODES = new Set([
  "expense_receipt_analysis_failed",
  "expense_receipt_sha256_missing",
  "expense_receipt_analysis_lease_expired",
  "expense_receipt_analysis_retry_scheduled",
  "expense_receipt_analysis_claim_changed",
  "expense_receipt_capture_disabled",
  "openai_expense_api_key_missing",
  "openai_expense_timeout",
  "openai_expense_network_failed",
  "openai_expense_empty_output",
  "openai_expense_invalid_json",
  "openai_expense_schema_mismatch",
]);
const SAFE_OPENAI_HTTP_FAILURE_CODE = /^openai_expense_http_[45]\d{2}$/u;

export type ExpenseOperationsMonitorQuery = {
  lookbackDays: number;
  overviewWeeks: number;
};

export class ExpenseOperationsMonitorInputError extends Error {
  constructor(
    readonly field: "lookbackDays" | "overviewWeeks",
    message: string,
  ) {
    super(message);
    this.name = "ExpenseOperationsMonitorInputError";
  }
}

function boundedInteger(input: {
  value: string | null;
  fallback: number;
  min: number;
  max: number;
  field: "lookbackDays" | "overviewWeeks";
}): number {
  if (input.value === null || input.value.trim() === "") return input.fallback;
  if (!/^\d{1,3}$/u.test(input.value.trim())) {
    throw new ExpenseOperationsMonitorInputError(
      input.field,
      `${input.field} must be a whole number from ${input.min} through ${input.max}.`,
    );
  }
  const parsed = Number(input.value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < input.min ||
    parsed > input.max
  ) {
    throw new ExpenseOperationsMonitorInputError(
      input.field,
      `${input.field} must be from ${input.min} through ${input.max}.`,
    );
  }
  return parsed;
}

export function parseExpenseOperationsMonitorQuery(
  searchParams: URLSearchParams,
): ExpenseOperationsMonitorQuery {
  return {
    lookbackDays: boundedInteger({
      value: searchParams.get("lookbackDays"),
      fallback: DEFAULT_LOOKBACK_DAYS,
      min: 1,
      max: MAX_LOOKBACK_DAYS,
      field: "lookbackDays",
    }),
    overviewWeeks: boundedInteger({
      value: searchParams.get("overviewWeeks"),
      fallback: DEFAULT_OVERVIEW_WEEKS,
      min: 1,
      max: MAX_OVERVIEW_WEEKS,
      field: "overviewWeeks",
    }),
  };
}

type OverviewWeekDiagnostic = {
  startDate: string;
  endDate: string;
  state: "complete" | "incomplete";
  reasons: ExpenseOverviewIncompleteReason[];
  pendingExpenseCount: number;
  missingAdEntryDateCount: number;
  missingCommissionDataCount: number;
  missingFinalTotalCount: number;
  omittedUnverifiedHistoricalRecordCount: number;
  unverifiedExpenseCategoryCount: number;
};

export type ExpenseOperationsMonitorAggregateInput = {
  now: Date;
  query: ExpenseOperationsMonitorQuery;
  since: Date;
  receiptStatusRows: Array<{ status: ReceiptStatus; count: number }>;
  receiptLatency: {
    analyzedCount: number;
    averageMs: number | null;
    p95Ms: number | null;
  };
  receiptFailureRows: Array<{
    code: string;
    status: ReceiptStatus;
    count: number;
  }>;
  receiptRetries: {
    attemptedCaptures: number;
    retriedCaptures: number;
    retryAttempts: number;
    scheduledRetries: number;
    dueRetries: number;
  };
  oldestQueued: {
    id: string;
    queuedAt: Date;
    analysisNextAttemptAt: Date | null;
    analysisAttemptCount: number;
    failureCode: string | null;
  } | null;
  duplicates: {
    exactWarnings: number;
    fuzzyWarnings: number;
    unresolvedExactWarnings: number;
  };
  pendingApprovals: {
    count: number;
    amountCents: number;
    oldestCreatedAt: Date | null;
  };
  reimbursementRows: Array<{
    status: ReimbursementBacklogStatus;
    count: number;
    amountCents: number;
    oldestCreatedAt: Date | null;
  }>;
  enteredYesterdayAdPlatforms: AdPlatform[];
  yesterdayBusinessDate: string;
  ledgerChanges: {
    correctedEvents: number;
    voidedEvents: number;
    recentOriginalEntries: number;
    recentChangedEntries: number;
  };
  overview: {
    available: boolean;
    requestedWeeks: number;
    weeks: OverviewWeekDiagnostic[];
    error: "overview_reconciliation_failed" | null;
  };
};

function rounded(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function ageMinutes(now: Date, value: Date | null): number | null {
  if (!value) return null;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 60_000));
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

/** Collapse unexpected provider/internal details before they reach the API. */
export function normalizeExpenseReceiptFailureCode(
  code: string | null,
): string | null {
  if (!code) return null;
  return SAFE_RECEIPT_FAILURE_CODES.has(code) ||
    SAFE_OPENAI_HTTP_FAILURE_CODE.test(code)
    ? code
    : "other";
}

function normalizeFailureRows(
  rows: ExpenseOperationsMonitorAggregateInput["receiptFailureRows"],
): ExpenseOperationsMonitorAggregateInput["receiptFailureRows"] {
  const totals = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const code = normalizeExpenseReceiptFailureCode(row.code) ?? "other";
    const key = `${row.status}:${code}`;
    const current = totals.get(key);
    totals.set(key, {
      code,
      status: row.status,
      count: (current?.count ?? 0) + row.count,
    });
  }
  return [...totals.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.status.localeCompare(right.status) ||
      left.code.localeCompare(right.code),
  );
}

function countByReceiptStatus(
  rows: ExpenseOperationsMonitorAggregateInput["receiptStatusRows"],
): Record<ReceiptStatus, number> {
  const counts = Object.fromEntries(
    RECEIPT_STATUSES.map((status) => [status, 0]),
  ) as Record<ReceiptStatus, number>;
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

function reimbursementBacklog(
  rows: ExpenseOperationsMonitorAggregateInput["reimbursementRows"],
): {
  count: number;
  amountCents: number;
  oldestCreatedAt: string | null;
  byStatus: Record<
    ReimbursementBacklogStatus,
    { count: number; amountCents: number }
  >;
} {
  const byStatus = Object.fromEntries(
    REIMBURSEMENT_BACKLOG_STATUSES.map((status) => [
      status,
      { count: 0, amountCents: 0 },
    ]),
  ) as Record<
    ReimbursementBacklogStatus,
    { count: number; amountCents: number }
  >;
  let oldest: Date | null = null;
  for (const row of rows) {
    byStatus[row.status] = {
      count: row.count,
      amountCents: row.amountCents,
    };
    if (
      row.oldestCreatedAt &&
      (!oldest || row.oldestCreatedAt.getTime() < oldest.getTime())
    ) {
      oldest = row.oldestCreatedAt;
    }
  }
  const totals = Object.values(byStatus).reduce(
    (result, row) => ({
      count: result.count + row.count,
      amountCents: result.amountCents + row.amountCents,
    }),
    { count: 0, amountCents: 0 },
  );
  return {
    ...totals,
    oldestCreatedAt: oldest?.toISOString() ?? null,
    byStatus,
  };
}

export function buildExpenseOperationsMonitorSnapshot(
  input: ExpenseOperationsMonitorAggregateInput,
) {
  const enteredPlatforms = new Set(input.enteredYesterdayAdPlatforms);
  const missingPlatforms = AD_PLATFORMS.filter(
    (platform) => !enteredPlatforms.has(platform),
  );
  const reimbursements = reimbursementBacklog(input.reimbursementRows);
  const overviewWeeks = [...input.overview.weeks]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, input.overview.requestedWeeks);

  return {
    schemaVersion: 1,
    generatedAt: input.now.toISOString(),
    timezone: EXPENSE_OVERVIEW_TIME_ZONE,
    window: {
      lookbackDays: input.query.lookbackDays,
      since: input.since.toISOString(),
      overviewWeeks: input.query.overviewWeeks,
    },
    receipts: {
      statusCounts: countByReceiptStatus(input.receiptStatusRows),
      latencyMs: {
        measurement: "uploaded_to_analysis_completed" as const,
        analyzedCount: input.receiptLatency.analyzedCount,
        average: rounded(input.receiptLatency.averageMs),
        p95: rounded(input.receiptLatency.p95Ms),
      },
      retries: input.receiptRetries,
      oldestQueued: input.oldestQueued
        ? {
            captureId: input.oldestQueued.id,
            queuedAt: input.oldestQueued.queuedAt.toISOString(),
            queuedAgeMinutes: ageMinutes(
              input.now,
              input.oldestQueued.queuedAt,
            ),
            nextAttemptAt:
              input.oldestQueued.analysisNextAttemptAt?.toISOString() ?? null,
            attemptCount: input.oldestQueued.analysisAttemptCount,
            failureCode: normalizeExpenseReceiptFailureCode(
              input.oldestQueued.failureCode,
            ),
          }
        : null,
      failureCodes: normalizeFailureRows(input.receiptFailureRows),
      duplicateWarnings: input.duplicates,
    },
    approvals: {
      pendingCount: input.pendingApprovals.count,
      pendingAmountCents: input.pendingApprovals.amountCents,
      oldestSubmittedAt:
        input.pendingApprovals.oldestCreatedAt?.toISOString() ?? null,
      oldestAgeMinutes: ageMinutes(
        input.now,
        input.pendingApprovals.oldestCreatedAt,
      ),
    },
    reimbursements: {
      ...reimbursements,
      oldestAgeMinutes: ageMinutes(
        input.now,
        reimbursements.oldestCreatedAt
          ? new Date(reimbursements.oldestCreatedAt)
          : null,
      ),
    },
    advertising: {
      yesterdayBusinessDate: input.yesterdayBusinessDate,
      enteredPlatforms: AD_PLATFORMS.filter((platform) =>
        enteredPlatforms.has(platform),
      ),
      missingPlatforms,
      complete: missingPlatforms.length === 0,
    },
    ledgerChanges: {
      ...input.ledgerChanges,
      recentChangeRatePercent: percent(
        input.ledgerChanges.recentChangedEntries,
        input.ledgerChanges.recentOriginalEntries,
      ),
    },
    recentOverviewWeeks: {
      available: input.overview.available,
      evaluatedCount: overviewWeeks.length,
      completeCount: overviewWeeks.filter((week) => week.state === "complete")
        .length,
      incompleteCount: overviewWeeks.filter(
        (week) => week.state === "incomplete",
      ).length,
      incomplete: overviewWeeks.filter((week) => week.state === "incomplete"),
      error: input.overview.error,
    },
  };
}

function currentEasternWeekStart(now: Date): DateTime {
  const eastern = DateTime.fromJSDate(now, { zone: "utc" }).setZone(
    EXPENSE_OVERVIEW_TIME_ZONE,
  );
  return eastern.startOf("day").minus({ days: eastern.weekday - 1 });
}

export function getExpenseOperationsOverviewPairStarts(
  now: Date,
  weeks: number,
): string[] {
  const latestCompletedWeek = currentEasternWeekStart(now).minus({ days: 7 });
  return Array.from({ length: Math.ceil(weeks / 2) }, (_, index) =>
    latestCompletedWeek.minus({ days: index * 14 }).toFormat("yyyy-MM-dd"),
  );
}

function overviewDiagnostic(
  overview: ExpenseOverviewResult,
  period: "current" | "prior",
): OverviewWeekDiagnostic {
  const value = period === "current" ? overview : overview.priorWeek;
  const boundary = period === "current" ? overview.week : overview.priorWeek;
  return {
    startDate: boundary.startDate,
    endDate: boundary.endDate,
    state: value.completeness.state,
    reasons: value.completeness.reasons,
    pendingExpenseCount: value.pendingExpenseCount,
    missingAdEntryDateCount: value.missingAdEntries.length,
    missingCommissionDataCount: value.missingCommissionDataCount,
    missingFinalTotalCount: value.missingFinalTotalCount,
    omittedUnverifiedHistoricalRecordCount:
      value.omittedUnverifiedHistoricalRecordCount,
    unverifiedExpenseCategoryCount: value.unverifiedExpenseCategoryCount,
  };
}

async function loadRecentOverviewDiagnostics(input: {
  db: DatabaseClient;
  now: Date;
  weeks: number;
  loader?: typeof loadExpenseOverviewInput;
}): Promise<ExpenseOperationsMonitorAggregateInput["overview"]> {
  const loader = input.loader ?? loadExpenseOverviewInput;
  try {
    const overviews = await Promise.all(
      getExpenseOperationsOverviewPairStarts(input.now, input.weeks).map(
        (weekStart) =>
          loader(input.db, weekStart, { asOf: input.now }).then(
            buildExpenseOverview,
          ),
      ),
    );
    const weeks = overviews
      .flatMap((overview) => [
        overviewDiagnostic(overview, "current"),
        overviewDiagnostic(overview, "prior"),
      ])
      .sort((left, right) => right.startDate.localeCompare(left.startDate))
      .slice(0, input.weeks);
    return {
      available: true,
      requestedWeeks: input.weeks,
      weeks,
      error: null,
    };
  } catch (error) {
    console.warn("[expense.operations] overview_diagnostics_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      available: false,
      requestedWeeks: input.weeks,
      weeks: [],
      error: "overview_reconciliation_failed",
    };
  }
}

export async function readExpenseOperationsMonitor(
  db: DatabaseClient,
  query: ExpenseOperationsMonitorQuery,
  options: {
    now?: Date;
    overviewLoader?: typeof loadExpenseOverviewInput;
  } = {},
) {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - query.lookbackDays * DAY_MS);
  const yesterdayBusinessDate =
    DateTime.fromJSDate(now, { zone: "utc" })
      .setZone(EXPENSE_OVERVIEW_TIME_ZONE)
      .minus({ days: 1 })
      .toISODate() ?? "";

  const statusCount = sql<number>`count(*)::integer`.mapWith(Number);
  const failureCount = sql<number>`count(*)::integer`.mapWith(Number);
  const reimbursementCount = sql<number>`count(*)::integer`.mapWith(Number);

  const [
    receiptStatusRows,
    latencyRows,
    receiptFailureRows,
    retryRows,
    oldestQueuedRows,
    duplicateRows,
    pendingApprovalRows,
    reimbursementRows,
    enteredYesterdayAdRows,
    ledgerChangeRows,
    overview,
  ] = await Promise.all([
    db
      .select({ status: expenseReceiptCaptures.status, count: statusCount })
      .from(expenseReceiptCaptures)
      .groupBy(expenseReceiptCaptures.status),
    db
      .select({
        analyzedCount: sql<number>`count(*)::integer`.mapWith(Number),
        averageMs: sql<number | null>`(
          avg(greatest(0, extract(epoch from (${expenseReceiptCaptures.analysisCompletedAt} - ${expenseReceiptCaptures.uploadedAt})) * 1000))
        )::double precision`,
        p95Ms: sql<number | null>`(
          percentile_cont(0.95) within group (
            order by greatest(0, extract(epoch from (${expenseReceiptCaptures.analysisCompletedAt} - ${expenseReceiptCaptures.uploadedAt})) * 1000)
          )
        )::double precision`,
      })
      .from(expenseReceiptCaptures)
      .where(
        and(
          isNotNull(expenseReceiptCaptures.uploadedAt),
          isNotNull(expenseReceiptCaptures.analysisCompletedAt),
          gte(expenseReceiptCaptures.analysisCompletedAt, since),
        ),
      ),
    db
      .select({
        code: expenseReceiptCaptures.failureCode,
        status: expenseReceiptCaptures.status,
        count: failureCount,
      })
      .from(expenseReceiptCaptures)
      .where(
        and(
          isNotNull(expenseReceiptCaptures.failureCode),
          gte(expenseReceiptCaptures.updatedAt, since),
        ),
      )
      .groupBy(
        expenseReceiptCaptures.failureCode,
        expenseReceiptCaptures.status,
      )
      .orderBy(desc(failureCount)),
    db
      .select({
        attemptedCaptures:
          sql<number>`count(*) filter (where ${gte(expenseReceiptCaptures.createdAt, since)} and ${expenseReceiptCaptures.analysisAttemptCount} > 0)::integer`.mapWith(
            Number,
          ),
        retriedCaptures:
          sql<number>`count(*) filter (where ${gte(expenseReceiptCaptures.createdAt, since)} and ${expenseReceiptCaptures.analysisAttemptCount} > 1)::integer`.mapWith(
            Number,
          ),
        retryAttempts:
          sql<number>`coalesce(sum(greatest(${expenseReceiptCaptures.analysisAttemptCount} - 1, 0)) filter (where ${gte(expenseReceiptCaptures.createdAt, since)}), 0)::integer`.mapWith(
            Number,
          ),
        scheduledRetries:
          sql<number>`count(*) filter (where ${expenseReceiptCaptures.status} = 'queued' and ${expenseReceiptCaptures.analysisNextAttemptAt} is not null)::integer`.mapWith(
            Number,
          ),
        dueRetries:
          sql<number>`count(*) filter (where ${expenseReceiptCaptures.status} = 'queued' and ${expenseReceiptCaptures.analysisNextAttemptAt} is not null and ${lte(expenseReceiptCaptures.analysisNextAttemptAt, now)})::integer`.mapWith(
            Number,
          ),
      })
      .from(expenseReceiptCaptures)
      .where(
        or(
          gte(expenseReceiptCaptures.createdAt, since),
          eq(expenseReceiptCaptures.status, "queued"),
        ),
      ),
    db
      .select({
        id: expenseReceiptCaptures.id,
        queuedAt: sql<Date>`coalesce(${expenseReceiptCaptures.analysisQueuedAt}, ${expenseReceiptCaptures.uploadedAt}, ${expenseReceiptCaptures.createdAt})`,
        analysisNextAttemptAt: expenseReceiptCaptures.analysisNextAttemptAt,
        analysisAttemptCount: expenseReceiptCaptures.analysisAttemptCount,
        failureCode: expenseReceiptCaptures.failureCode,
      })
      .from(expenseReceiptCaptures)
      .where(eq(expenseReceiptCaptures.status, "queued"))
      .orderBy(
        asc(
          sql`coalesce(${expenseReceiptCaptures.analysisQueuedAt}, ${expenseReceiptCaptures.uploadedAt}, ${expenseReceiptCaptures.createdAt})`,
        ),
      )
      .limit(1),
    db
      .select({
        exactWarnings:
          sql<number>`count(*) filter (where ${expenseReceiptCaptures.exactDuplicateOfCaptureId} is not null)::integer`.mapWith(
            Number,
          ),
        fuzzyWarnings:
          sql<number>`count(*) filter (where ${expenseReceiptCaptures.extraction} #>> '{duplicates,highestRisk}' = 'fuzzy')::integer`.mapWith(
            Number,
          ),
        unresolvedExactWarnings:
          sql<number>`count(*) filter (where ${expenseReceiptCaptures.status} = 'ready' and ${expenseReceiptCaptures.exactDuplicateOfCaptureId} is not null)::integer`.mapWith(
            Number,
          ),
      })
      .from(expenseReceiptCaptures)
      .where(gte(expenseReceiptCaptures.createdAt, since)),
    db
      .select({
        count: sql<number>`count(*)::integer`.mapWith(Number),
        amountCents:
          sql<number>`coalesce(sum(${expenses.amount}), 0)::bigint`.mapWith(
            Number,
          ),
        oldestCreatedAt: sql<Date | null>`min(${expenses.createdAt})`,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.reviewStatus, "pending"),
          eq(expenses.lifecycleStatus, "draft"),
        ),
      ),
    db
      .select({
        status: expenseReimbursementClaims.status,
        count: reimbursementCount,
        amountCents:
          sql<number>`coalesce(sum(${expenseReimbursementClaims.amountCents}), 0)::bigint`.mapWith(
            Number,
          ),
        oldestCreatedAt: sql<Date | null>`min(${expenseReimbursementClaims.createdAt})`,
      })
      .from(expenseReimbursementClaims)
      .where(
        inArray(
          expenseReimbursementClaims.status,
          REIMBURSEMENT_BACKLOG_STATUSES,
        ),
      )
      .groupBy(expenseReimbursementClaims.status),
    db
      .select({ platform: dailyAdSpend.platform })
      .from(dailyAdSpend)
      .where(eq(dailyAdSpend.businessDate, yesterdayBusinessDate)),
    db
      .select({
        correctedEvents:
          sql<number>`count(*) filter (where ${gte(expenses.correctedAt, since)} and ${expenses.reversalOfExpenseId} is null and ${expenses.correctionOfExpenseId} is null)::integer`.mapWith(
            Number,
          ),
        voidedEvents:
          sql<number>`count(*) filter (where ${gte(expenses.voidedAt, since)} and ${expenses.reversalOfExpenseId} is null and ${expenses.correctionOfExpenseId} is null)::integer`.mapWith(
            Number,
          ),
        recentOriginalEntries:
          sql<number>`count(*) filter (where ${gte(expenses.paidAt, since)} and ${expenses.reviewStatus} = 'approved' and ${expenses.source} <> 'payout_run' and ${expenses.reversalOfExpenseId} is null and ${expenses.correctionOfExpenseId} is null and ${expenses.lifecycleStatus} in ('posted', 'corrected', 'voided'))::integer`.mapWith(
            Number,
          ),
        recentChangedEntries:
          sql<number>`count(*) filter (where ${gte(expenses.paidAt, since)} and ${expenses.reviewStatus} = 'approved' and ${expenses.source} <> 'payout_run' and ${expenses.reversalOfExpenseId} is null and ${expenses.correctionOfExpenseId} is null and ${expenses.lifecycleStatus} in ('corrected', 'voided'))::integer`.mapWith(
            Number,
          ),
      })
      .from(expenses)
      .where(
        and(
          ne(expenses.source, "payout_run"),
          isNull(expenses.reversalOfExpenseId),
          isNull(expenses.correctionOfExpenseId),
          or(
            gte(expenses.paidAt, since),
            gte(expenses.correctedAt, since),
            gte(expenses.voidedAt, since),
          ),
        ),
      ),
    loadRecentOverviewDiagnostics({
      db,
      now,
      weeks: query.overviewWeeks,
      loader: options.overviewLoader,
    }),
  ]);

  return buildExpenseOperationsMonitorSnapshot({
    now,
    query,
    since,
    receiptStatusRows,
    receiptLatency: latencyRows[0] ?? {
      analyzedCount: 0,
      averageMs: null,
      p95Ms: null,
    },
    receiptFailureRows: receiptFailureRows.flatMap((row) =>
      row.code
        ? [{ code: row.code, status: row.status, count: row.count }]
        : [],
    ),
    receiptRetries: retryRows[0] ?? {
      attemptedCaptures: 0,
      retriedCaptures: 0,
      retryAttempts: 0,
      scheduledRetries: 0,
      dueRetries: 0,
    },
    oldestQueued: oldestQueuedRows[0] ?? null,
    duplicates: duplicateRows[0] ?? {
      exactWarnings: 0,
      fuzzyWarnings: 0,
      unresolvedExactWarnings: 0,
    },
    pendingApprovals: pendingApprovalRows[0] ?? {
      count: 0,
      amountCents: 0,
      oldestCreatedAt: null,
    },
    reimbursementRows: reimbursementRows.flatMap((row) =>
      REIMBURSEMENT_BACKLOG_STATUSES.includes(
        row.status as ReimbursementBacklogStatus,
      )
        ? [
            {
              status: row.status as ReimbursementBacklogStatus,
              count: row.count,
              amountCents: row.amountCents,
              oldestCreatedAt: row.oldestCreatedAt,
            },
          ]
        : [],
    ),
    enteredYesterdayAdPlatforms: enteredYesterdayAdRows.map(
      (row) => row.platform,
    ),
    yesterdayBusinessDate,
    ledgerChanges: ledgerChangeRows[0] ?? {
      correctedEvents: 0,
      voidedEvents: 0,
      recentOriginalEntries: 0,
      recentChangedEntries: 0,
    },
    overview,
  });
}
