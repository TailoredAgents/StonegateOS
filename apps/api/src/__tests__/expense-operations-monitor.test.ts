import {
  buildExpenseOperationsMonitorSnapshot,
  CLIENT_RECEIPT_QUEUE_FRESHNESS_MINUTES,
  ExpenseOperationsMonitorInputError,
  getExpenseOperationsOverviewPairStarts,
  normalizeExpenseReceiptFailureCode,
  parseExpenseOperationsMonitorQuery,
  type ExpenseOperationsMonitorAggregateInput,
} from "@/lib/expense-operations-monitor";

const NOW = new Date("2026-08-27T14:00:00.000Z");

function aggregateInput(): ExpenseOperationsMonitorAggregateInput {
  return {
    now: NOW,
    query: { lookbackDays: 30, overviewWeeks: 4 },
    since: new Date("2026-07-28T14:00:00.000Z"),
    receiptStatusRows: [
      { status: "queued", count: 2 },
      { status: "confirmed", count: 5 },
      { status: "failed", count: 1 },
    ],
    receiptLatency: {
      analyzedCount: 6,
      averageMs: 1_200.4,
      p95Ms: 2_500.6,
    },
    receiptFailureRows: [
      {
        code: "openai_expense_http_429",
        status: "queued",
        count: 2,
      },
      {
        code: "openai_expense_http_400",
        status: "failed",
        count: 1,
      },
      {
        code: "provider-secret-detail",
        status: "failed",
        count: 3,
      },
    ],
    receiptRetries: {
      attemptedCaptures: 8,
      retriedCaptures: 2,
      retryAttempts: 3,
      scheduledRetries: 1,
      dueRetries: 0,
    },
    oldestQueued: {
      id: "11111111-1111-4111-8111-111111111111",
      queuedAt: new Date("2026-08-27T13:00:00.000Z"),
      analysisNextAttemptAt: new Date("2026-08-27T14:05:00.000Z"),
      analysisAttemptCount: 2,
      failureCode: "openai_expense_http_429",
    },
    duplicates: {
      exactWarnings: 3,
      fuzzyWarnings: 2,
      unresolvedExactWarnings: 1,
    },
    clientReceiptQueue: {
      freshReportCount: 3,
      freshDeviceCount: 2,
      queuedCount: 5,
      failedCount: 2,
      freshReportsWithQueued: 2,
      freshReportsWithFailures: 1,
      oldestQueuedAt: new Date("2026-08-27T12:00:00.000Z"),
      staleReportCount: 2,
      staleDeviceCount: 2,
      staleReportsWithQueued: 1,
      staleReportsWithFailures: 1,
    },
    pendingApprovals: {
      count: 2,
      amountCents: 12_500,
      oldestCreatedAt: new Date("2026-08-26T14:00:00.000Z"),
    },
    reimbursementRows: [
      {
        status: "pending",
        count: 2,
        amountCents: 8_000,
        oldestCreatedAt: new Date("2026-08-25T14:00:00.000Z"),
      },
      {
        status: "attached",
        count: 1,
        amountCents: 4_000,
        oldestCreatedAt: new Date("2026-08-26T14:00:00.000Z"),
      },
    ],
    enteredYesterdayAdPlatforms: ["facebook"],
    yesterdayBusinessDate: "2026-08-26",
    ledgerChanges: {
      correctedEvents: 1,
      voidedEvents: 1,
      recentOriginalEntries: 20,
      recentChangedEntries: 2,
    },
    overview: {
      available: true,
      requestedWeeks: 4,
      error: null,
      weeks: [
        {
          startDate: "2026-08-03",
          endDate: "2026-08-09",
          state: "complete",
          reasons: [],
          pendingExpenseCount: 0,
          missingAdEntryDateCount: 0,
          missingCommissionDataCount: 0,
          missingFinalTotalCount: 0,
          omittedUnverifiedHistoricalRecordCount: 0,
          unverifiedExpenseCategoryCount: 0,
        },
        {
          startDate: "2026-08-17",
          endDate: "2026-08-23",
          state: "incomplete",
          reasons: ["missing_ad_entries", "pending_expenses"],
          pendingExpenseCount: 2,
          missingAdEntryDateCount: 1,
          missingCommissionDataCount: 0,
          missingFinalTotalCount: 0,
          omittedUnverifiedHistoricalRecordCount: 0,
          unverifiedExpenseCategoryCount: 0,
        },
        {
          startDate: "2026-08-10",
          endDate: "2026-08-16",
          state: "complete",
          reasons: [],
          pendingExpenseCount: 0,
          missingAdEntryDateCount: 0,
          missingCommissionDataCount: 0,
          missingFinalTotalCount: 0,
          omittedUnverifiedHistoricalRecordCount: 0,
          unverifiedExpenseCategoryCount: 0,
        },
        {
          startDate: "2026-07-27",
          endDate: "2026-08-02",
          state: "incomplete",
          reasons: ["missing_commission_data"],
          pendingExpenseCount: 0,
          missingAdEntryDateCount: 0,
          missingCommissionDataCount: 1,
          missingFinalTotalCount: 0,
          omittedUnverifiedHistoricalRecordCount: 0,
          unverifiedExpenseCategoryCount: 0,
        },
      ],
    },
  };
}

describe("expense operations monitoring", () => {
  it("uses bounded query defaults and rejects oversized or malformed windows", () => {
    expect(parseExpenseOperationsMonitorQuery(new URLSearchParams())).toEqual({
      lookbackDays: 30,
      overviewWeeks: 4,
    });
    expect(
      parseExpenseOperationsMonitorQuery(
        new URLSearchParams("lookbackDays=90&overviewWeeks=8"),
      ),
    ).toEqual({ lookbackDays: 90, overviewWeeks: 8 });

    for (const query of [
      "lookbackDays=0",
      "lookbackDays=91",
      "lookbackDays=30.5",
      "overviewWeeks=0",
      "overviewWeeks=9",
    ]) {
      expect(() =>
        parseExpenseOperationsMonitorQuery(new URLSearchParams(query)),
      ).toThrow(ExpenseOperationsMonitorInputError);
    }
  });

  it("selects completed Eastern week pairs across the fall DST boundary", () => {
    expect(
      getExpenseOperationsOverviewPairStarts(
        new Date("2026-11-05T15:00:00.000Z"),
        5,
      ),
    ).toEqual(["2026-10-26", "2026-10-12", "2026-09-28"]);
  });

  it("allowlists operational failure codes and redacts unexpected details", () => {
    expect(normalizeExpenseReceiptFailureCode("openai_expense_http_429")).toBe(
      "openai_expense_http_429",
    );
    expect(normalizeExpenseReceiptFailureCode("openai_expense_timeout")).toBe(
      "openai_expense_timeout",
    );
    expect(normalizeExpenseReceiptFailureCode("provider said: card 4242")).toBe(
      "other",
    );
    expect(normalizeExpenseReceiptFailureCode(null)).toBeNull();
  });

  it("builds actionable aggregates without returning receipt evidence", () => {
    const snapshot = buildExpenseOperationsMonitorSnapshot(aggregateInput());

    expect(snapshot).toMatchObject({
      generatedAt: "2026-08-27T14:00:00.000Z",
      schemaVersion: 2,
      timezone: "America/New_York",
      receipts: {
        statusCounts: {
          queued: 2,
          confirmed: 5,
          failed: 1,
          analyzing: 0,
        },
        latencyMs: {
          measurement: "uploaded_to_analysis_completed",
          analyzedCount: 6,
          average: 1_200,
          p95: 2_501,
        },
        retries: {
          retriedCaptures: 2,
          retryAttempts: 3,
          scheduledRetries: 1,
          dueRetries: 0,
        },
        oldestQueued: {
          captureId: "11111111-1111-4111-8111-111111111111",
          queuedAgeMinutes: 60,
          attemptCount: 2,
          failureCode: "openai_expense_http_429",
        },
        duplicateWarnings: { unresolvedExactWarnings: 1 },
        clientQueue: {
          source: "client_reported_metadata",
          freshness: {
            basis: "server_received_at",
            windowMinutes: 15,
            freshAfter: "2026-08-27T13:45:00.000Z",
          },
          current: {
            reportCount: 3,
            deviceCount: 2,
            queuedCount: 5,
            failedCount: 2,
            reportsWithQueued: 2,
            reportsWithFailures: 1,
            oldestQueuedAt: "2026-08-27T12:00:00.000Z",
            oldestQueuedAgeMinutes: 120,
          },
          stale: {
            reportCount: 2,
            deviceCount: 2,
            reportsWithQueued: 1,
            reportsWithFailures: 1,
          },
        },
      },
      approvals: {
        pendingCount: 2,
        pendingAmountCents: 12_500,
        oldestAgeMinutes: 1_440,
      },
      reimbursements: {
        count: 3,
        amountCents: 12_000,
        oldestAgeMinutes: 2_880,
        byStatus: {
          pending: { count: 2, amountCents: 8_000 },
          approved: { count: 0, amountCents: 0 },
          attached: { count: 1, amountCents: 4_000 },
        },
      },
      advertising: {
        yesterdayBusinessDate: "2026-08-26",
        enteredPlatforms: ["facebook"],
        missingPlatforms: ["google"],
        complete: false,
      },
      ledgerChanges: {
        correctedEvents: 1,
        voidedEvents: 1,
        recentOriginalEntries: 20,
        recentChangedEntries: 2,
        recentChangeRatePercent: 10,
      },
      recentOverviewWeeks: {
        available: true,
        evaluatedCount: 4,
        completeCount: 2,
        incompleteCount: 2,
        incomplete: [
          expect.objectContaining({ startDate: "2026-08-17" }),
          expect.objectContaining({ startDate: "2026-07-27" }),
        ],
        error: null,
      },
    });
    expect(snapshot.receipts.failureCodes).toContainEqual({
      code: "other",
      status: "failed",
      count: 3,
    });

    const serialized = JSON.stringify(snapshot);
    for (const sensitiveField of [
      "filename",
      "contentPath",
      "extraction",
      "vendor",
      "paymentLastFour",
      "provider-secret-detail",
      "teamMemberId",
      "clientDeviceId",
    ]) {
      expect(serialized).not.toContain(sensitiveField);
    }
  });

  it("defines client queue freshness as three five-minute reporting windows", () => {
    expect(CLIENT_RECEIPT_QUEUE_FRESHNESS_MINUTES).toBe(15);
  });

  it("uses null instead of a misleading zero-percent rate", () => {
    const input = aggregateInput();
    input.ledgerChanges.recentOriginalEntries = 0;
    input.ledgerChanges.recentChangedEntries = 0;
    input.receiptLatency = {
      analyzedCount: 0,
      averageMs: null,
      p95Ms: null,
    };

    const snapshot = buildExpenseOperationsMonitorSnapshot(input);

    expect(snapshot.ledgerChanges.recentChangeRatePercent).toBeNull();
    expect(snapshot.receipts.latencyMs).toEqual({
      measurement: "uploaded_to_analysis_completed",
      analyzedCount: 0,
      average: null,
      p95: null,
    });
  });
});
