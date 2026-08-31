import fs from "node:fs";
import path from "node:path";
import {
  evaluateQuoteV2OperationalAlerts,
  parseQuoteV2OperationsQuery,
  QuoteV2OperationsInputError,
  type QuoteV2OperationalSnapshot,
} from "@/lib/quote-v2-operations";

function cleanSnapshot(): Omit<QuoteV2OperationalSnapshot, "alerts"> {
  return {
    generatedAt: "2026-08-30T12:00:00.000Z",
    window: { lookbackDays: 7, since: "2026-08-23T12:00:00.000Z" },
    featureFlags: {
      dualWrite: false,
      staff: true,
      sender: true,
      public: true,
      mutations: true,
      deposits: true,
      booking: true,
    },
    lifecycle: {
      created: 4,
      ready: 3,
      issued: 3,
      accepted: 2,
      booked: 1,
      createToIssueAverageMinutes: 8,
      createToIssueP95Minutes: 12,
    },
    deliveries: {
      queued: 0,
      dispatched: 0,
      delivered: 5,
      failed: 0,
      reconciliation_required: 0,
      suppressed: 0,
    },
    responses: {
      accepted: 2,
      declined: 0,
      change_requested: 1,
      refresh_requested: 0,
    },
    engagement: { visibleProposalViews: 4, pdfDownloads: 2 },
    changes: { open: 1, overdue: 0, unowned: 0, oldestOpenAt: null },
    scheduling: {
      activeHolds: 1,
      expiredActiveHolds: 0,
      acceptedWithoutAppointment: 1,
    },
    deposits: {
      attempts: {
        created: 0,
        launched: 0,
        pending_verification: 0,
        completed: 1,
        failed: 0,
        expired: 0,
        canceled: 0,
        reconciliation_required: 0,
      },
      captured: 1,
      capturedCents: 10_000,
    },
    outbox: {
      pending: 0,
      retrying: 0,
      quarantined: 0,
      unknownUnquarantined: 0,
    },
    integrity: {
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
    },
  };
}

describe("Quote V2 operations", () => {
  it("accepts a bounded lookback and rejects duplicate or unknown query fields", () => {
    expect(parseQuoteV2OperationsQuery(new URLSearchParams())).toEqual({
      lookbackDays: 7,
    });
    expect(
      parseQuoteV2OperationsQuery(new URLSearchParams("lookbackDays=30")),
    ).toEqual({ lookbackDays: 30 });
    expect(() =>
      parseQuoteV2OperationsQuery(new URLSearchParams("lookbackDays=0")),
    ).toThrow(QuoteV2OperationsInputError);
    expect(() =>
      parseQuoteV2OperationsQuery(
        new URLSearchParams("lookbackDays=7&lookbackDays=14"),
      ),
    ).toThrow("only once");
    expect(() =>
      parseQuoteV2OperationsQuery(new URLSearchParams("contactId=secret")),
    ).toThrow("Unsupported query field");
  });

  it("stays quiet for a reconciled snapshot", () => {
    expect(evaluateQuoteV2OperationalAlerts(cleanSnapshot())).toEqual([]);
  });

  it("raises stable zero-tolerance and recovery alerts without record data", () => {
    const snapshot = cleanSnapshot();
    snapshot.integrity.acceptanceEvidenceMissing = 1;
    snapshot.integrity.appointmentEvidenceMismatch = 2;
    snapshot.integrity.capturedDepositMismatch = 1;
    snapshot.integrity.changeWithoutOwnerTask = 1;
    snapshot.integrity.closedOpportunityRegression = 1;
    snapshot.outbox.unknownUnquarantined = 1;
    snapshot.changes.overdue = 3;
    snapshot.deliveries.failed = 2;
    snapshot.deposits.attempts.reconciliation_required = 1;

    const alerts = evaluateQuoteV2OperationalAlerts(snapshot);
    expect(alerts.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "quote_v2_acceptance_evidence_missing",
        "quote_v2_total_mismatch",
        "quote_v2_change_without_task",
        "quote_v2_unknown_event",
        "quote_v2_closed_opportunity_regression",
        "quote_v2_change_sla_overdue",
        "quote_v2_delivery_failure",
        "quote_v2_deposit_failure",
      ]),
    );
    expect(JSON.stringify(alerts)).not.toMatch(
      /email|phone|address|tokenHash|customerName/iu,
    );
  });

  it("keeps the admin route permissioned, bounded, and uncached", () => {
    const route = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "app/api/admin/quotes/v2/operations/route.ts",
      ),
      "utf8",
    );
    expect(route).toContain('requirePermission(request, "quotes.read")');
    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"');
    expect(route).toContain("parseQuoteV2OperationsQuery");
    expect(route).not.toContain("shareToken");
  });
});
