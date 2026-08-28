import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MobileSpendV2,
  buildExpenseDumpCorrectionBody,
  buildExpenseDumpSubmissionDetails,
  expenseAddChoices,
  expenseCaptureEvidenceHref,
  expenseConfirmationDuplicateKind,
  expenseDumpActivityValue,
  expenseHistoryCanCorrectDumpWeight,
  expenseHistoryCorrectionLabel,
  expenseHistoryDisplayStatus,
  expenseHistoryDumpDetailsValue,
  expenseOverviewReasonDetail,
  formatExpenseDumpWeight,
  parseExpenseDumpMilliTonsInput,
  parseExpenseDumpPoundsInput,
  receiptExtractionFromCapture,
} from "../src/app/mobile/MobileSpendV2";
import {
  MobileExpenseDonut,
  buildExpenseDonutSegments,
  type MobileExpenseDonutCategory,
} from "../src/app/mobile/MobileExpenseDonut";
import { parseMobileFixedCostsPayload } from "../src/app/mobile/MobileFixedCosts";
import {
  expenseCaptureQueueStatus,
  shouldPollExpenseCaptureStatus,
  summarizeExpenseCaptureQueueHealth,
  type ExpenseCaptureQueueRow,
} from "../src/app/mobile/lib/expense-capture-queue";
import {
  acknowledgeExpenseMutationAttempt,
  canonicalExpenseMutationPayload,
  getExpenseMutationAttempt,
  type ExpenseMutationGenerationStore,
} from "../src/app/mobile/lib/expense-mutation-idempotency";
import {
  addDateKeyDays,
  easternDateKey,
  expenseAllocationTotal,
  expenseReceiptContentType,
  mondayForDateKey,
  moneyInputToCents,
} from "../src/app/mobile/spend-v2-utils";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));

void test("money input remains exact in integer cents", () => {
  assert.equal(moneyInputToCents("$1,234.56"), 123_456);
  assert.equal(moneyInputToCents("0"), 0);
  assert.equal(moneyInputToCents("12.3"), 1_230);
  assert.equal(moneyInputToCents("12.345"), null);
  assert.equal(moneyInputToCents("-1.00"), null);
  assert.equal(moneyInputToCents("1000000.01"), null);
});

void test("Eastern business dates survive both DST transitions", () => {
  assert.equal(
    easternDateKey(new Date("2026-03-08T04:59:00.000Z")),
    "2026-03-07",
  );
  assert.equal(
    easternDateKey(new Date("2026-03-08T05:01:00.000Z")),
    "2026-03-08",
  );
  assert.equal(
    easternDateKey(new Date("2026-11-01T03:59:00.000Z")),
    "2026-10-31",
  );
  assert.equal(
    easternDateKey(new Date("2026-11-01T04:01:00.000Z")),
    "2026-11-01",
  );
});

void test("week controls always normalize to Monday through Sunday", () => {
  assert.equal(mondayForDateKey("2026-08-27"), "2026-08-24");
  assert.equal(mondayForDateKey("2026-08-30"), "2026-08-24");
  assert.equal(addDateKeyDays("2026-08-24", 6), "2026-08-30");
  assert.equal(addDateKeyDays("2026-08-24", -7), "2026-08-17");
});

void test("allocation totals surface incomplete rows instead of rounding", () => {
  assert.equal(
    expenseAllocationTotal([{ amountCents: 1_001 }, { amountCents: 999 }]),
    2_000,
  );
  assert.equal(
    expenseAllocationTotal([{ amountCents: 1_001 }, { amountCents: null }]),
    null,
  );
});

void test("dump weights remain exact across pounds, tons, and dollars", () => {
  assert.equal(parseExpenseDumpPoundsInput("15,780"), 15_780);
  assert.equal(parseExpenseDumpPoundsInput("0"), null);
  assert.equal(parseExpenseDumpPoundsInput("0", { allowZero: true }), 0);
  assert.equal(parseExpenseDumpPoundsInput("2900.5"), null);
  assert.equal(parseExpenseDumpMilliTonsInput("1.45"), 1_450);
  assert.equal(parseExpenseDumpMilliTonsInput("0"), 0);
  assert.equal(parseExpenseDumpMilliTonsInput("1.2345"), null);
  assert.equal(formatExpenseDumpWeight(2_900), "2,900 lb · 1.45 tons");
  assert.equal(formatExpenseDumpWeight(2_000), "2,000 lb · 1 ton");
});

void test("dump submission records only reviewed weight and preserves readable context", () => {
  const reviewed = buildExpenseDumpSubmissionDetails(
    {
      weightStatus: "confirmed",
      facilityName: "Speedway Transfer Station",
      ticketNumber: "697723",
      material: "Construction/Demo",
      grossWeightPounds: "15,780",
      tareWeightPounds: "12,880",
      netWeightPounds: "2,900",
      billedWeightTons: "1.45",
      unitRateDollarsPerTon: "50.00",
    },
    { required: true },
  );
  assert.deepEqual(reviewed, {
    ok: true,
    details: {
      weightStatus: "confirmed",
      facilityName: "Speedway Transfer Station",
      ticketNumber: "697723",
      material: "Construction/Demo",
      grossWeightPounds: 15_780,
      tareWeightPounds: 12_880,
      netWeightPounds: 2_900,
      billedWeightMilliTons: 1_450,
      unitRateCentsPerTon: 5_000,
      reviewed: true,
    },
  });

  const billedOnly = buildExpenseDumpSubmissionDetails(
    {
      weightStatus: "confirmed",
      facilityName: "",
      ticketNumber: "",
      material: "",
      grossWeightPounds: "",
      tareWeightPounds: "",
      netWeightPounds: "",
      billedWeightTons: "1.45",
      unitRateDollarsPerTon: "",
    },
    { required: true },
  );
  assert.equal(
    billedOnly.ok,
    false,
    "billed weight must not bypass net review",
  );

  const unreadable = buildExpenseDumpSubmissionDetails(
    {
      weightStatus: "unreadable",
      facilityName: "Speedway Transfer Station",
      ticketNumber: "697723",
      material: "Construction/Demo",
      grossWeightPounds: "15780",
      tareWeightPounds: "0",
      netWeightPounds: "stale invalid value",
      billedWeightTons: "0",
      unitRateDollarsPerTon: "0.00",
    },
    { required: true },
  );
  assert.deepEqual(unreadable, {
    ok: true,
    details: {
      weightStatus: "unreadable",
      facilityName: "Speedway Transfer Station",
      ticketNumber: "697723",
      material: "Construction/Demo",
      grossWeightPounds: 15_780,
      tareWeightPounds: 0,
      netWeightPounds: null,
      billedWeightMilliTons: 0,
      unitRateCentsPerTon: 0,
      reviewed: true,
    },
  });

  const invalidSecondaryWeights = buildExpenseDumpSubmissionDetails(
    {
      weightStatus: "unreadable",
      facilityName: "Speedway Transfer Station",
      ticketNumber: "697723",
      material: "Construction/Demo",
      grossWeightPounds: "12000",
      tareWeightPounds: "13000",
      netWeightPounds: "",
      billedWeightTons: "1.45",
      unitRateDollarsPerTon: "50.00",
    },
    { required: true },
  );
  assert.deepEqual(invalidSecondaryWeights, {
    ok: false,
    message: "Gross weight cannot be less than tare weight.",
  });
});

void test("scale-ticket review keeps low-confidence net blank without losing readable fields", () => {
  const extracted = receiptExtractionFromCapture({
    id: "11111111-1111-4111-8111-111111111111",
    status: "ready",
    version: 2,
    filename: "scale-ticket.jpg",
    contentPath: "/receipt",
    extraction: {
      raw: {
        documentType: "scale_ticket",
        paymentLastFour: null,
        dumpTicket: {
          facilityName: "Speedway Transfer Station",
          ticketNumber: "697723",
          material: "Construction/Demo",
          grossWeightPounds: 15_780,
          tareWeightPounds: 12_880,
          netWeightPounds: 2_900,
          billedWeightMilliTons: 1_450,
          unitRateCentsPerTon: 5_000,
        },
      },
      review: {
        fields: {
          vendor: { value: "Capital Waste Services" },
          transactionDate: { value: "2026-08-27" },
          totalCents: { value: 9_141 },
          paymentLastFour: { value: null },
          suggestedCategoryId: { value: "dump_fees" },
          dumpTicket: {
            value: {
              facilityName: "Speedway Transfer Station",
              ticketNumber: "697723",
              material: "Construction/Demo",
              grossWeightPounds: 15_780,
              tareWeightPounds: 12_880,
              netWeightPounds: null,
              billedWeightMilliTons: 1_450,
              unitRateCentsPerTon: 5_000,
            },
          },
        },
        fieldsToCheck: ["dumpTicket.netWeightPounds"],
      },
      categorySuggestion: { categoryId: "dump_fees" },
      duplicates: { highestRisk: null },
    },
  });
  assert.equal(extracted.initial?.documentType, "scale_ticket");
  assert.equal(extracted.initial?.requiresScaleTicketReview, true);
  assert.equal(extracted.initial?.categoryId, "dump_fees");
  assert.equal(extracted.initial?.dumpDetails?.netWeightPounds, "");
  assert.equal(extracted.initial?.dumpDetails?.grossWeightPounds, "15780");
  assert.equal(extracted.initial?.dumpDetails?.billedWeightTons, "1.45");
  assert.deepEqual(extracted.attention, ["dumpTicket.netWeightPounds"]);

  const standard = receiptExtractionFromCapture({
    id: "22222222-2222-4222-8222-222222222222",
    status: "ready",
    version: 2,
    filename: "vertical.jpg",
    contentPath: "/receipt",
    extraction: {
      raw: { documentType: "standard_receipt", dumpTicket: null },
      review: { fields: {}, fieldsToCheck: [] },
    },
  });
  assert.equal(standard.initial?.documentType, "standard_receipt");
  assert.equal(standard.initial?.requiresScaleTicketReview, false);
  assert.equal(standard.initial?.dumpDetails?.netWeightPounds, "");

  const ambiguous = receiptExtractionFromCapture({
    id: "33333333-3333-4333-8333-333333333333",
    status: "ready",
    version: 2,
    filename: "ambiguous.jpg",
    contentPath: "/receipt",
    extraction: {
      raw: {
        documentType: "unknown",
        dumpTicket: {
          facilityName: null,
          ticketNumber: null,
          material: null,
          grossWeightPounds: null,
          tareWeightPounds: null,
          netWeightPounds: null,
          billedWeightMilliTons: null,
          unitRateCentsPerTon: null,
        },
      },
      review: { fields: {}, fieldsToCheck: [] },
    },
  });
  assert.equal(ambiguous.initial?.documentType, "unknown");
  assert.equal(ambiguous.initial?.requiresScaleTicketReview, true);

  const malformedFutureShape = receiptExtractionFromCapture({
    id: "44444444-4444-4444-8444-444444444444",
    status: "ready",
    version: 2,
    filename: "future-shape.jpg",
    contentPath: "/receipt",
    extraction: {
      raw: { documentType: "unknown", dumpTicket: "future-shape" },
      review: { fields: {}, fieldsToCheck: [] },
    },
  });
  assert.equal(malformedFutureShape.initial?.requiresScaleTicketReview, true);
});

void test("rolling deploy defaults missing dump reporting data without crashing", () => {
  assert.deepEqual(expenseDumpActivityValue(undefined), {
    dumpFeeCents: 0,
    ticketCount: 0,
    weightedTicketCount: 0,
    netWeightPounds: 0,
    averageCostPerTonCents: null,
    missingWeightCount: 0,
  });
  assert.equal(expenseHistoryDumpDetailsValue(undefined), null);
  assert.deepEqual(
    expenseHistoryDumpDetailsValue({
      weightStatus: "confirmed",
      facilityName: "Speedway Transfer Station",
      ticketNumber: "697723",
      material: "Construction/Demo",
      grossWeightPounds: 15_780,
      tareWeightPounds: 12_880,
      netWeightPounds: 2_900,
      billedWeightMilliTons: 1_450,
      unitRateCentsPerTon: 5_000,
      confirmedBy: { id: "owner-1", name: "Owner" },
      confirmedAt: "2026-08-27T16:00:00.000Z",
    }),
    {
      weightStatus: "confirmed",
      facilityName: "Speedway Transfer Station",
      ticketNumber: "697723",
      material: "Construction/Demo",
      grossWeightPounds: 15_780,
      tareWeightPounds: 12_880,
      netWeightPounds: 2_900,
      billedWeightMilliTons: 1_450,
      unitRateCentsPerTon: 5_000,
      confirmedBy: { id: "owner-1", name: "Owner" },
      confirmedAt: "2026-08-27T16:00:00.000Z",
      createdAt: null,
    },
  );
});

void test("history prioritizes corrected and voided ledger state", () => {
  assert.equal(expenseHistoryDisplayStatus("posted", "approved"), "approved");
  assert.equal(
    expenseHistoryDisplayStatus("corrected", "approved"),
    "corrected",
  );
  assert.equal(expenseHistoryDisplayStatus("voided", "approved"), "voided");
  assert.equal(expenseHistoryDisplayStatus("posted", null), "posted");
  assert.equal(
    expenseHistoryCorrectionLabel({
      reversalOfExpenseId: "original",
      correctionOfExpenseId: null,
      correctedByExpenseId: null,
    }),
    "Correction reversal — offsets original",
  );
  assert.equal(
    expenseHistoryCorrectionLabel({
      reversalOfExpenseId: null,
      correctionOfExpenseId: "original",
      correctedByExpenseId: null,
    }),
    "Active corrected entry",
  );
  assert.equal(
    expenseHistoryCorrectionLabel({
      reversalOfExpenseId: null,
      correctionOfExpenseId: null,
      correctedByExpenseId: "replacement",
    }),
    "Original expense — replaced",
  );
});

void test("receipt evidence links stay on the authenticated mobile route", () => {
  const captureId = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    expenseCaptureEvidenceHref({
      id: captureId,
      contentPath: `/api/admin/expenses/captures/${captureId}/content`,
    }),
    `/api/mobile/expenses/captures/${captureId}/content`,
  );
  assert.equal(
    expenseCaptureEvidenceHref({
      id: "../admin",
      contentPath: "/api/admin/expenses/captures/unsafe/content",
    }),
    null,
  );
  assert.equal(expenseCaptureEvidenceHref({ id: captureId }), null);
});

void test("runtime duplicate responses distinguish scale tickets from receipt hashes", () => {
  assert.equal(
    expenseConfirmationDuplicateKind(409, {
      message: "This facility and ticket number already exist.",
      fieldErrors: {
        exactDuplicateOverrideReason: "Owner approval is required.",
      },
    }),
    "scale_ticket",
  );
  assert.equal(
    expenseConfirmationDuplicateKind(422, {
      message: "Add a specific reason for posting a duplicate receipt.",
      fieldErrors: {
        exactDuplicateOverrideReason: "Enter at least 10 characters.",
      },
    }),
    "exact_receipt",
  );
  const genericDuplicate = {
    message: "Add a specific reason for posting a duplicate expense.",
    fieldErrors: {
      exactDuplicateOverrideReason: "Enter at least 10 characters.",
    },
  };
  assert.equal(
    expenseConfirmationDuplicateKind(422, genericDuplicate, {
      attemptedDumpDetails: true,
    }),
    "scale_ticket",
  );
  assert.equal(
    expenseConfirmationDuplicateKind(422, genericDuplicate, {
      attemptedDumpDetails: true,
      knownExactReceipt: true,
    }),
    "exact_receipt",
  );
  assert.equal(
    expenseConfirmationDuplicateKind(409, {
      message: "The expense changed while it was being saved.",
    }),
    null,
  );
});

void test("posted dump corrections preserve the exact financial replacement", () => {
  const row: Parameters<typeof expenseHistoryCanCorrectDumpWeight>[0] = {
    id: "88888888-8888-4888-8888-888888888888",
    amountCents: 9_141,
    currency: "USD",
    category: "Dump Fees",
    categoryNeedsReview: false,
    vendor: "Capital Waste Services",
    notes: "Scale ticket",
    method: "card",
    source: "receipt_scan",
    lifecycleStatus: "posted",
    version: 2,
    allocations: [
      { categoryId: "dump_fees", category: "Dump Fees", amountCents: 9_141 },
    ],
    paidAt: "2026-08-27T15:45:00.000Z",
    coverageStartAt: null,
    coverageEndAt: null,
  };
  assert.equal(expenseHistoryCanCorrectDumpWeight(row, true), true);
  assert.equal(
    expenseHistoryCanCorrectDumpWeight({ ...row, source: "manual" }, true),
    true,
  );
  assert.equal(
    expenseHistoryCanCorrectDumpWeight(
      { ...row, source: "manual_correction" },
      true,
    ),
    true,
  );
  assert.equal(expenseHistoryCanCorrectDumpWeight(row, false), false);
  assert.equal(
    expenseHistoryCanCorrectDumpWeight({ ...row, paidAt: undefined }, true),
    false,
    "an older History DTO must hide the action",
  );
  assert.equal(
    expenseHistoryCanCorrectDumpWeight(
      { ...row, lifecycleStatus: "corrected" },
      true,
    ),
    false,
  );

  assert.deepEqual(
    buildExpenseDumpCorrectionBody(
      row,
      {
        weightStatus: "confirmed",
        facilityName: "Speedway Transfer Station",
        ticketNumber: "697723",
        material: "Construction/Demo",
        grossWeightPounds: "15780",
        tareWeightPounds: "12880",
        netWeightPounds: "2900",
        billedWeightTons: "1.45",
        unitRateDollarsPerTon: "50.00",
      },
      "Corrected the reviewed net weight",
    ),
    {
      ok: true,
      body: {
        amountCents: 9_141,
        currency: "USD",
        category: "Dump Fees",
        vendor: "Capital Waste Services",
        memo: "Scale ticket",
        method: "card",
        paidAt: "2026-08-27T15:45:00.000Z",
        coverageStartAt: null,
        coverageEndAt: null,
        reason: "Corrected the reviewed net weight",
        dumpDetails: {
          weightStatus: "confirmed",
          facilityName: "Speedway Transfer Station",
          ticketNumber: "697723",
          material: "Construction/Demo",
          grossWeightPounds: 15_780,
          tareWeightPounds: 12_880,
          netWeightPounds: 2_900,
          billedWeightMilliTons: 1_450,
          unitRateCentsPerTon: 5_000,
          reviewed: true,
        },
      },
    },
  );

  const removed = buildExpenseDumpCorrectionBody(
    row,
    {
      weightStatus: "confirmed",
      facilityName: "",
      ticketNumber: "",
      material: "",
      grossWeightPounds: "",
      tareWeightPounds: "",
      netWeightPounds: "",
      billedWeightTons: "",
      unitRateDollarsPerTon: "",
    },
    "Removed an incorrect scale-ticket classification",
    true,
  );
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.body.dumpDetails, null);
});

void test("mobile dump correction proxy remains owner-only and version-bound", async () => {
  const [route, historyRoute, component] = await Promise.all([
    readFile(
      `${siteRoot}/src/app/api/mobile/expenses/[expenseId]/correct/route.ts`,
      "utf8",
    ),
    readFile(
      `${siteRoot}/src/app/api/mobile/expenses/submissions/route.ts`,
      "utf8",
    ),
    readFile(`${siteRoot}/src/app/mobile/MobileSpendV2.tsx`, "utf8"),
  ]);
  assert.match(route, /permission: "expenses\.approve"/u);
  assert.match(route, /method: "POST"/u);
  assert.match(
    route,
    /\/api\/admin\/expenses\/\$\{encodeExpenseRouteId\(expenseId\)\}\/correct/u,
  );
  assert.match(component, /operation: `expense-dump-correct:\$\{row\.id\}`/u);
  assert.match(component, /"If-Match": String\(row\.version\)/u);
  assert.match(component, /"Idempotency-Key": attempt\.idempotencyKey/u);
  assert.match(component, /Save reviewed weight/u);
  assert.match(component, /Remove scale-ticket details/u);
  assert.match(component, /Save classification correction/u);
  assert.match(
    component,
    /row\.dumpDetails\s*\? "Correct weight"\s*: "Add weight"/u,
  );
  assert.match(component, /The original expense remains in History/u);
  assert.match(historyRoute, /"dump_tickets"/u);
});

void test("receipt type inference supports camera and plan-approved file types", () => {
  assert.equal(
    expenseReceiptContentType({ name: "receipt.HEIC", type: "" }),
    "image/heic",
  );
  assert.equal(
    expenseReceiptContentType({ name: "receipt.pdf", type: "application/pdf" }),
    "application/pdf",
  );
  assert.equal(
    expenseReceiptContentType({ name: "receipt.gif", type: "image/gif" }),
    null,
  );
});

class MemoryMutationGenerationStore implements ExpenseMutationGenerationStore {
  readonly generations = new Map<string, number>();

  constructor(private readonly deviceId = "test-device-00000001") {}

  getOrCreateDeviceId(): Promise<string> {
    return Promise.resolve(this.deviceId);
  }

  getOrCreateGeneration(stateKey: string): Promise<number> {
    const generation = this.generations.get(stateKey) ?? 0;
    this.generations.set(stateKey, generation);
    return Promise.resolve(generation);
  }

  advanceGeneration(
    stateKey: string,
    expectedGeneration: number,
  ): Promise<void> {
    const current = this.generations.get(stateKey) ?? 0;
    if (current === expectedGeneration) {
      this.generations.set(stateKey, current + 1);
    }
    return Promise.resolve();
  }
}

void test("expense mutation keys survive reload ambiguity and rotate safely", async () => {
  const store = new MemoryMutationGenerationStore();
  const first = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  const afterReload = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { notes: null, vendor: "Acme", amountCents: 1_234 },
    },
    store,
  );
  assert.equal(afterReload.idempotencyKey, first.idempotencyKey);
  assert.equal(afterReload.fingerprintHash, first.fingerprintHash);
  assert.match(first.idempotencyKey, /^expense-v1-[0-9a-f]{64}$/u);

  const changedPayload = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_235, vendor: "Acme", notes: null },
    },
    store,
  );
  const changedEmployee = await getExpenseMutationAttempt(
    {
      employeeId: "employee-b",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  assert.notEqual(changedPayload.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changedEmployee.idempotencyKey, first.idempotencyKey);

  await acknowledgeExpenseMutationAttempt(first, store);
  const afterSuccess = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  assert.notEqual(afterSuccess.idempotencyKey, first.idempotencyKey);
  assert.equal(afterSuccess.generation, 1);

  await acknowledgeExpenseMutationAttempt(first, store);
  const afterStaleAcknowledgement = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  assert.equal(
    afterStaleAcknowledgement.idempotencyKey,
    afterSuccess.idempotencyKey,
  );
});

void test("expense payload fingerprints are canonical and reject unsafe values", () => {
  assert.equal(
    canonicalExpenseMutationPayload({ z: 2, a: { y: 1, x: true } }),
    '{"a":{"x":true,"y":1},"z":2}',
  );
  assert.throws(
    () => canonicalExpenseMutationPayload({ amount: Number.NaN }),
    /finite/u,
  );
  assert.throws(
    () => canonicalExpenseMutationPayload({ date: new Date(0) }),
    /plain objects/u,
  );
});

void test("only active analysis polls while terminal states remain tracked", () => {
  assert.equal(expenseCaptureQueueStatus("confirmed"), "confirmed");
  assert.equal(expenseCaptureQueueStatus("discarded"), "discarded");
  assert.equal(expenseCaptureQueueStatus("ready"), "ready");
  assert.equal(expenseCaptureQueueStatus("failed"), "failed");
  assert.equal(expenseCaptureQueueStatus("analyzing"), "processing");
  assert.equal(shouldPollExpenseCaptureStatus("failed"), false);
  assert.equal(shouldPollExpenseCaptureStatus("processing"), true);
  assert.equal(shouldPollExpenseCaptureStatus("confirmed"), false);
  assert.equal(shouldPollExpenseCaptureStatus("discarded"), false);
});

void test("receipt queue telemetry counts only captures awaiting server acknowledgement", () => {
  const row = (
    status: ExpenseCaptureQueueRow["status"],
    createdAt: number,
    options: Partial<ExpenseCaptureQueueRow> = {},
  ): ExpenseCaptureQueueRow => ({
    clientCaptureId: `${status}-${createdAt}`,
    employeeId: "employee-a",
    filename: "receipt.jpg",
    contentType: "image/jpeg",
    byteLength: 10,
    checksumSha256: "a".repeat(64),
    status,
    error: null,
    attempts: 0,
    serverCapture: null,
    createdAt,
    updatedAt: createdAt,
    ...options,
  });

  assert.deepEqual(
    summarizeExpenseCaptureQueueHealth([
      row("draft", 10),
      row("queued", 20),
      row("syncing", 30, { error: "network interrupted" }),
      row("failed", 40),
      row("processing", 5, { serverCapture: { status: "analyzing" } }),
      row("ready", 1, { serverCapture: { status: "ready" } }),
    ]),
    { queuedCount: 3, failedCount: 2, oldestQueuedAt: 20 },
  );
});

void test("overview completeness explains every production reason", () => {
  const period = {
    pendingExpenseCount: 2,
    missingAdEntries: [{}, {}, {}],
    missingCommissionDataCount: 4,
    missingFinalTotalCount: 5,
    omittedUnverifiedHistoricalRecordCount: 6,
    unverifiedExpenseCategoryCount: 7,
  };
  assert.match(
    expenseOverviewReasonDetail("missing_ad_entries", period),
    /3 days missing Facebook or Google/u,
  );
  assert.match(
    expenseOverviewReasonDetail("missing_commission_data", period),
    /4 completed jobs missing commission/u,
  );
  assert.match(
    expenseOverviewReasonDetail("missing_final_totals", period),
    /5 completed jobs missing a final total/u,
  );
  assert.match(
    expenseOverviewReasonDetail("pending_expenses", period),
    /2 expenses awaiting review/u,
  );
  assert.match(
    expenseOverviewReasonDetail("unverified_historical_records", period),
    /6 unverified historical records were omitted/u,
  );
  assert.match(
    expenseOverviewReasonDetail("unverified_expense_categories", period),
    /7 expense categories need verification/u,
  );
});

void test("Add always presents three choices with one filled primary action", () => {
  const scenarios = [
    {
      canSubmit: true,
      receiptEnabled: true,
      adSpendEnabled: true,
      pendingCapture: false,
      missingYesterday: false,
      primary: "scan",
    },
    {
      canSubmit: true,
      receiptEnabled: false,
      adSpendEnabled: false,
      pendingCapture: false,
      missingYesterday: false,
      primary: "manual",
    },
    {
      canSubmit: false,
      receiptEnabled: false,
      adSpendEnabled: true,
      pendingCapture: false,
      missingYesterday: true,
      primary: "ads",
    },
  ] as const;

  for (const scenario of scenarios) {
    const choices = expenseAddChoices(scenario);
    assert.deepEqual(
      choices.map((choice) => choice.id),
      ["scan", "ads", "manual"],
    );
    assert.deepEqual(
      choices.filter((choice) => choice.primary).map((choice) => choice.id),
      [scenario.primary],
    );
  }
});

const donutCategories: MobileExpenseDonutCategory[] = [
  {
    id: "labor",
    label: "Labor",
    amountCents: 5_000,
    percentOfExpenses: 50,
    percentOfRevenue: 25,
    verified: true,
  },
  ...Array.from({ length: 6 }, (_, index) => ({
    id: `category-${index + 1}`,
    label: `Category ${index + 1}`,
    amountCents: 600 - index * 100,
    percentOfExpenses: 6 - index,
    percentOfRevenue: 3 - index / 2,
    verified: index !== 5,
  })),
];

void test("expense donut keeps five direct slices and groups the full remainder", () => {
  const segments = buildExpenseDonutSegments(donutCategories, 7_100);
  assert.equal(segments.length, 6);
  assert.deepEqual(
    segments.slice(0, 5).map((segment) => segment.label),
    ["Labor", "Category 1", "Category 2", "Category 3", "Category 4"],
  );
  assert.equal(
    new Set(segments.slice(0, 5).map((segment) => segment.color)).size,
    5,
  );
  assert.deepEqual(segments[5], {
    id: "all-other-categories",
    label: "All other categories",
    amountCents: 300,
    percent: (300 / 7_100) * 100,
    color: "#64748b",
    categoryIds: ["category-5", "category-6"],
    grouped: true,
  });
  assert.ok(
    Math.abs(
      segments.reduce((sum, segment) => sum + segment.percent, 0) - 100,
    ) < 0.000_001,
  );
  assert.deepEqual(
    buildExpenseDonutSegments([{ ...donutCategories[0]!, amountCents: 0 }]),
    [],
  );
  assert.deepEqual(buildExpenseDonutSegments(donutCategories, 7_101), []);
  assert.deepEqual(
    buildExpenseDonutSegments(
      [{ ...donutCategories[0]!, amountCents: -100 }],
      -100,
    ),
    [],
  );
});

void test("expense donut exposes a full text list and keeps the SVG decorative", () => {
  const html = renderToStaticMarkup(
    createElement(MobileExpenseDonut, {
      categories: donutCategories,
      totalExpensesCents: 7_100,
    }),
  );
  assert.match(html, /Expense mix/u);
  assert.match(html, /aria-hidden="true"/u);
  assert.match(html, /Expense distribution chart/u);
  assert.match(html, /50\.0% of expenses/u);
  assert.match(html, /25\.0% of revenue/u);
  assert.match(html, /Category needs review/u);
  assert.equal(
    (html.match(/<li class=/gu) ?? []).length,
    donutCategories.length,
  );
});

void test("expense donut refuses to misstate a net-adjustment week", () => {
  const html = renderToStaticMarkup(
    createElement(MobileExpenseDonut, {
      categories: [
        { ...donutCategories[0]!, amountCents: 5_000 },
        { ...donutCategories[1]!, amountCents: -500 },
      ],
      totalExpensesCents: 4_500,
    }),
  );
  assert.match(html, /Mix unavailable/u);
  assert.match(html, /cannot be drawn accurately/u);
  assert.doesNotMatch(html, /<svg/u);
});

void test("fixed-cost responses fail closed unless every money and version field is valid", () => {
  const valid = {
    ok: true,
    currency: "USD",
    asOf: "2026-08-27",
    summary: {
      activeCount: 1,
      monthlyAmountCents: 310_000,
      dailyAccrualCents: 10_000,
    },
    costs: [
      {
        seriesId: "11111111-1111-4111-8111-111111111111",
        version: 2,
        name: "Rent",
        categoryId: "office_admin",
        category: "Office/Admin",
        monthlyAmountCents: 310_000,
        effectiveStartDate: "2026-08-01",
        state: "active",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
    ],
  };
  assert.deepEqual(parseMobileFixedCostsPayload(valid), valid);
  assert.equal(
    parseMobileFixedCostsPayload({
      ...valid,
      costs: [{ ...valid.costs[0], version: 0 }],
    }),
    null,
  );
  assert.equal(
    parseMobileFixedCostsPayload({
      ...valid,
      summary: { ...valid.summary, dailyAccrualCents: -1 },
    }),
    null,
  );
});

void test("Spend V2 keeps the locked navigation and offline-store contracts", async () => {
  const [component, session, offlineMedia, mutationKeys, worker] =
    await Promise.all([
      readFile(`${siteRoot}/src/app/mobile/MobileSpendV2.tsx`, "utf8"),
      readFile(`${siteRoot}/src/app/mobile/lib/session.ts`, "utf8"),
      readFile(`${siteRoot}/src/app/mobile/lib/offline-media.ts`, "utf8"),
      readFile(
        `${siteRoot}/src/app/mobile/lib/expense-mutation-idempotency.ts`,
        "utf8",
      ),
      readFile(`${siteRoot}/public/mobile-sw.js`, "utf8"),
    ]);

  assert.match(component, /\["add", "overview", "history"\]/u);
  assert.match(component, /id: "scan"/u);
  assert.match(component, /id: "ads"/u);
  assert.match(component, /id: "manual"/u);
  assert.match(component, /Waiting to sync/u);
  assert.match(component, /aria-live="polite"/u);
  assert.match(
    component,
    /role="status"\s+aria-live="polite"\s+aria-atomic="true"/u,
  );
  assert.match(component, /role="group"/u);
  assert.match(component, /aria-pressed=/u);
  assert.doesNotMatch(component, /role="tablist"/u);
  assert.doesNotMatch(component, /role="tab"/u);
  assert.match(component, /focus-visible:ring-2/u);
  assert.match(component, /focus-within:ring-2/u);
  assert.match(component, /min-h-11/u);
  assert.match(component, /workflow === null \? \(/u);
  assert.match(component, /Choose a replacement receipt photo or PDF/u);
  assert.match(component, /aria-atomic="true"/u);
  assert.match(component, /Submit for approval/u);
  assert.match(component, /Reimbursement/u);
  assert.match(component, /getExpenseMutationAttempt/u);
  assert.match(component, /acknowledgeExpenseMutationAttempt/u);
  assert.doesNotMatch(component, /mutationKeyForPayload/u);
  assert.match(component, /overrideReason\.trim\(\)\.length < 10/u);
  assert.match(component, /minLength=\{10\}/u);
  assert.match(component, /It remains safely stored/u);
  assert.match(component, /refreshExpenseCapture/u);
  assert.match(component, /vendorPrimary\?: boolean/u);
  assert.match(component, /vendorPrimary = false,/u);
  assert.match(component, /\{vendorPrimary \? vendorField : null\}/u);
  assert.match(component, /\{vendorPrimary \? null : vendorField\}/u);
  assert.match(
    component,
    /attentionFields=\{extracted\.attention\}\s+vendorPrimary\s+duplicateRisk=/u,
  );
  assert.match(
    component,
    /const vendorField = \([\s\S]*?attentionFields\.includes\("vendor"\) \? <AttentionBadge \/> : null/u,
  );
  assert.match(component, /fetch\("\/api\/mobile\/expenses\/capabilities"/u);
  assert.match(component, /capabilities\?\.receiptCapture === true/u);
  assert.match(component, /capabilities\?\.dailyAdSpend === true/u);
  assert.match(component, /capabilities\?\.overview === true/u);
  assert.match(component, /capabilities\?\.reimbursement === true/u);
  assert.match(component, /capabilities\?\.exactDuplicateReview === true/u);
  assert.match(component, /capabilities\?\.fixedCosts === true/u);
  assert.match(component, /capabilities\?\.dumpTickets === true/u);
  assert.match(component, /dumpTickets: value\["dumpTickets"\] === true/u);
  assert.match(component, /MobileFixedCosts/u);
  assert.match(component, /MobileExpenseDonut/u);
  assert.match(component, /DumpActivityPanel/u);
  assert.match(component, /Scale ticket details/u);
  assert.match(component, />\s*View receipt\s*</u);
  assert.match(component, /href=\{receiptContentHref\}/u);
  assert.match(component, /target="_blank"/u);
  assert.match(component, /rel="noreferrer"/u);
  assert.match(component, /Net weight is unreadable/u);
  assert.match(component, /Portrait or landscape/u);
  assert.match(
    component,
    /if \(runtimeDuplicateKind === "scale_ticket"\)[\s\S]*?setRuntimeDuplicateKind\(null\)/u,
  );
  assert.match(
    component,
    /attemptedDumpDetails: body\.dumpDetails !== undefined/u,
  );
  assert.match(
    component,
    /knownExactReceipt:\s*receiptExtraction\(row\)\.duplicateRisk ===\s*"exact"/u,
  );
  assert.match(component, /existing receipt or scale ticket/u);
  assert.match(component, /\["dump_tickets", "Dump expenses"\]/u);
  assert.match(component, /dumpDetails\?: ExpenseDumpSubmissionDetails/u);
  assert.match(component, /This is not a scale ticket/u);
  assert.match(component, /scaleTicketDisposition/u);
  assert.equal(component.match(/receiptReviewContractVersion: 2/gu)?.length, 2);
  assert.match(
    component,
    /const requiresScaleTicketReview = Boolean\([\s\S]*?"dumpTicket" in raw[\s\S]*?"dumpDetails" in raw/u,
  );
  assert.match(
    component,
    /visibleHistoryFilters = dumpTicketsEnabled[\s\S]*?value !== "dump_tickets"/u,
  );
  assert.match(component, /Original expense — replaced/u);
  assert.match(component, /Correction reversal — offsets original/u);
  assert.match(component, /Active corrected entry/u);
  assert.match(component, /fetchExactDuplicateReviewPage/u);
  assert.match(component, /owner-duplicate-confirm:/u);
  assert.match(component, /"If-Match": String\(item\.capture\.version\)/u);
  assert.match(component, /Current receipt/u);
  assert.match(component, /Matched receipt/u);
  assert.match(component, /Prior-week comparison unavailable/u);
  assert.match(component, /priorWeekChange\.available/u);
  assert.match(component, /priorWeekChange\.states\.revenue/u);
  assert.match(component, /priorWeekChange\.states\.expenseRatio/u);
  assert.match(component, /Prior week was zero/u);
  assert.match(component, /Ratio needs revenue in both weeks/u);
  assert.match(component, /priorWeek\.completeness\.reasons/u);
  assert.match(component, /missingFinalTotalCount/u);
  assert.match(component, /omittedUnverifiedHistoricalRecordCount/u);
  assert.match(component, /unverifiedExpenseCategoryCount/u);
  assert.match(component, /Expense details/u);
  assert.match(component, /Category allocation/u);
  assert.match(
    component,
    /More details[\s\S]*?<FieldLabel>Notes<\/FieldLabel>[\s\S]*?<FieldLabel>Payment method<\/FieldLabel>[\s\S]*?<FieldLabel>Job link<\/FieldLabel>[\s\S]*?Split categories/u,
  );
  assert.equal(
    component.match(/<FieldLabel>Filter history<\/FieldLabel>/gu)?.length,
    1,
  );
  assert.doesNotMatch(component, /bulk.{0,20}approv|approv.{0,20}all/iu);
  assert.match(component, /Loss after tracked costs/u);
  assert.match(session, /"expenses\.submit"/u);
  assert.match(session, /"expenses\.approve"/u);
  assert.doesNotMatch(session, /"expenses\.write"/u);
  assert.match(offlineMedia, /DATABASE_VERSION = 4/u);
  assert.match(offlineMedia, /appointment-snapshots/u);
  assert.match(offlineMedia, /media-upload-queue/u);
  assert.match(offlineMedia, /expense-capture-queue/u);
  assert.match(mutationKeys, /expense-mutation:v1:/u);
  assert.match(mutationKeys, /advanceGeneration/u);
  assert.match(worker, /stonegate-expense-receipts/u);
  assert.match(worker, /stonegate-media-sync/u);
  assert.match(worker, /capture\?\.status === "confirmed"/u);
  assert.match(worker, /\/api\/mobile\/expenses\/queue-health/u);
  assert.match(worker, /await reportExpenseQueueHealth\(employeeId\)/u);
  const expenseProxy = await readFile(
    `${siteRoot}/src/app/api/mobile/expenses/lib/expense-proxy.ts`,
    "utf8",
  );
  assert.match(expenseProxy, /redirect: "manual"/u);
  assert.match(expenseProxy, /Referrer-Policy/u);
});

void test("fixed-cost coverage stays optional under More details for manual and receipt submissions", async () => {
  const component = await readFile(
    `${siteRoot}/src/app/mobile/MobileSpendV2.tsx`,
    "utf8",
  );

  assert.match(
    component,
    /type SubmissionBody = \{[\s\S]*?coveredByFixedCostSeriesId\?: string \| null;/u,
  );
  assert.match(
    component,
    /More details[\s\S]*?<FixedCostCoverageField[\s\S]*?Split categories/u,
  );
  assert.match(
    component,
    /coveredByFixedCostSeriesId\s*\? \{ coveredByFixedCostSeriesId \}\s*: \{\}/u,
  );
  assert.match(
    component,
    /function ReceiptWorkflow\([\s\S]*?<ExpenseEditor[\s\S]*?fixedCostCoverageEnabled=\{fixedCostCoverageEnabled\}/u,
  );
  assert.match(
    component,
    /workflow === "manual"[\s\S]*?<ExpenseEditor[\s\S]*?fixedCostCoverageEnabled=\{fixedCostsEnabled\}/u,
  );
  assert.match(
    component,
    /const requestBody = \{[\s\S]*?\.\.\.body,[\s\S]*?receipt-confirm:/u,
  );
  assert.match(
    component,
    /fetch\("\/api\/mobile\/expenses\/submissions"[\s\S]*?body: JSON\.stringify\(requestBody\)/u,
  );
  assert.match(
    component,
    /type ExpenseHistoryRow = \{[\s\S]*?coveredByFixedCostSeriesId: string \| null;[\s\S]*?coveredByFixedCostName: string \| null;/u,
  );
  assert.match(
    component,
    /Approval preferences[\s\S]*?<FixedCostCoverageField/u,
  );
  assert.match(
    component,
    /coveredByFixedCostSeriesId:\s*reviewCoveredByFixedCostSeriesId \|\| null/u,
  );
  assert.match(
    component,
    /Excluded from Overview — covered by[\s\S]*?row\.coveredByFixedCostName/u,
  );
  assert.match(
    component,
    /fixedCosts: \{[\s\S]*?coveredExpenseCount: number;[\s\S]*?coveredExpenseAmountCents: number;/u,
  );
  assert.match(
    component,
    /linked payment[\s\S]*?"remains" : "remain"[\s\S]*?in History and[\s\S]*?"is" : "are"[\s\S]*?excluded from ordinary expense totals\./u,
  );
});

void test("the initial mobile surface keeps three choices while optional tools fail closed", () => {
  const html = renderToStaticMarkup(
    createElement(MobileSpendV2, {
      employee: { id: "11111111-1111-4111-8111-111111111111", name: "Crew" },
      canSubmit: true,
      canApprove: false,
      canViewOverview: false,
      canWriteAdSpend: false,
      members: [],
      jobs: [],
    }),
  );

  assert.match(html, />Add</u);
  assert.match(html, />History</u);
  assert.match(html, /Scan receipt/u);
  assert.match(html, /Daily ad spend/u);
  assert.match(html, /Manual entry/u);
  assert.match(html, /Unavailable right now/u);
  assert.match(html, /Owner access or setup required/u);
  assert.match(html, /Loading optional expense tools/u);
  assert.doesNotMatch(html, />Overview</u);
  assert.doesNotMatch(html, /Recent expenses/u);
});
