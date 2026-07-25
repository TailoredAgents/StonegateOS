import {
  allocateRefund,
  buildAppointmentPaymentSummary,
  mapProviderPaymentStatus,
} from "@/lib/payment-summary";
import {
  summarizeSquareAttempts,
  validateFinalTotalChange,
} from "@/lib/payment-ledger";
import { isSquarePosEnabled } from "@/lib/payment-feature-flags";

describe("payment summary", () => {
  it("keeps tips separate from the appointment balance", () => {
    const summary = buildAppointmentPaymentSummary({
      jobTotalCents: 25_000,
      entries: [
        {
          canonicalStatus: "completed",
          jobAmountCents: 25_000,
          tipCents: 4_000,
          refundedAmountCents: 0,
          receiptUrl: "https://square.example/receipt",
        },
      ],
    });

    expect(summary).toEqual({
      status: "paid",
      jobTotalCents: 25_000,
      paidTowardJobCents: 25_000,
      tipCents: 4_000,
      refundedCents: 0,
      balanceCents: 0,
      activeAttemptId: null,
      latestReceiptUrl: "https://square.example/receipt",
    });
  });

  it("allocates refunds to job amount before tip", () => {
    expect(
      allocateRefund({
        jobAmountCents: 10_000,
        tipCents: 2_000,
        refundedAmountCents: 11_000,
      }),
    ).toEqual({
      refundedJobCents: 10_000,
      refundedTipCents: 1_000,
      netJobCents: 0,
      netTipCents: 1_000,
      overRefundedCents: 0,
    });
  });

  it("surfaces a refunded job without counting the refunded tip", () => {
    const summary = buildAppointmentPaymentSummary({
      jobTotalCents: 10_000,
      entries: [
        {
          canonicalStatus: "completed",
          jobAmountCents: 10_000,
          tipCents: 2_000,
          refundedAmountCents: 12_000,
        },
      ],
    });

    expect(summary.status).toBe("refunded");
    expect(summary.paidTowardJobCents).toBe(0);
    expect(summary.tipCents).toBe(0);
    expect(summary.refundedCents).toBe(12_000);
    expect(summary.balanceCents).toBe(10_000);
  });

  it("marks malformed over-refunds for review", () => {
    const summary = buildAppointmentPaymentSummary({
      jobTotalCents: 1_000,
      entries: [
        {
          canonicalStatus: "completed",
          jobAmountCents: 1_000,
          tipCents: 0,
          refundedAmountCents: 1_001,
        },
      ],
    });
    expect(summary.status).toBe("needs_review");
  });

  it("marks duplicate collection over the job total for review", () => {
    const summary = buildAppointmentPaymentSummary({
      jobTotalCents: 10_000,
      entries: [
        { canonicalStatus: "completed", jobAmountCents: 10_000 },
        { canonicalStatus: "completed", jobAmountCents: 10_000 },
      ],
    });
    expect(summary.status).toBe("needs_review");
    expect(summary.paidTowardJobCents).toBe(20_000);
    expect(summary.balanceCents).toBe(0);
  });

  it("shows real provider money while keeping its allocation in review", () => {
    const summary = buildAppointmentPaymentSummary({
      jobTotalCents: 10_000,
      entries: [
        {
          canonicalStatus: "needs_review",
          countTowardBalance: true,
          jobAmountCents: 8_000,
        },
      ],
    });
    expect(summary.status).toBe("needs_review");
    expect(summary.paidTowardJobCents).toBe(8_000);
    expect(summary.balanceCents).toBe(2_000);
  });

  it("maps provider states conservatively", () => {
    expect(mapProviderPaymentStatus("square", "COMPLETED")).toBe("completed");
    expect(mapProviderPaymentStatus("square", "MYSTERY")).toBe("needs_review");
    expect(mapProviderPaymentStatus("stripe", "succeeded")).toBe("completed");
    expect(mapProviderPaymentStatus("manual", "completed")).toBe("completed");
  });

  it("surfaces unresolved or newly stale Square attempts for review", () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const unresolved = summarizeSquareAttempts(
      [
        {
          id: "expired-attempt",
          status: "expired",
          expiresAt: new Date("2026-07-24T11:30:00.000Z"),
        },
        {
          id: "newly-stale-attempt",
          status: "launched",
          expiresAt: now,
        },
      ],
      now,
    );

    expect(unresolved).toEqual({
      activeAttemptId: null,
      needsReview: true,
    });
    expect(
      buildAppointmentPaymentSummary({
        jobTotalCents: 10_000,
        entries: [],
        needsReview: unresolved.needsReview,
      }).status,
    ).toBe("needs_review");
  });

  it("keeps an unexpired Square attempt active without marking it for review", () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const active = summarizeSquareAttempts(
      [
        {
          id: "active-attempt",
          status: "pending_verification",
          expiresAt: new Date("2026-07-24T12:30:00.000Z"),
        },
      ],
      now,
    );

    expect(active).toEqual({
      activeAttemptId: "active-attempt",
      needsReview: false,
    });
  });
});

describe("final total payment lock", () => {
  it("allows collectors to set the total before any successful payment", () => {
    expect(
      validateFinalTotalChange({
        currentFinalTotalCents: null,
        nextFinalTotalCents: 15_000,
        paidTowardJobCents: 0,
        hasSuccessfulPayment: false,
        actorRole: "crew",
      }),
    ).toEqual({ ok: true });
  });

  it("requires an owner and reason after the first successful payment", () => {
    expect(
      validateFinalTotalChange({
        currentFinalTotalCents: 15_000,
        nextFinalTotalCents: 16_000,
        paidTowardJobCents: 15_000,
        hasSuccessfulPayment: true,
        actorRole: "crew",
        changeReason: "Added volume",
      }),
    ).toMatchObject({ ok: false, code: "owner_required_after_payment" });
    expect(
      validateFinalTotalChange({
        currentFinalTotalCents: 15_000,
        nextFinalTotalCents: 16_000,
        paidTowardJobCents: 15_000,
        hasSuccessfulPayment: true,
        actorRole: "owner",
      }),
    ).toMatchObject({ ok: false, code: "change_reason_required" });
  });

  it("never allows the final total below net paid", () => {
    expect(
      validateFinalTotalChange({
        currentFinalTotalCents: 15_000,
        nextFinalTotalCents: 12_000,
        paidTowardJobCents: 13_000,
        hasSuccessfulPayment: true,
        actorRole: "owner",
        changeReason: "Correction",
      }),
    ).toMatchObject({ ok: false, code: "final_total_below_net_paid" });
  });
});

describe("payment feature flags", () => {
  const previous = process.env["SQUARE_POS_ENABLED"];

  afterEach(() => {
    if (previous === undefined) delete process.env["SQUARE_POS_ENABLED"];
    else process.env["SQUARE_POS_ENABLED"] = previous;
  });

  it("keeps Square initiation off unless explicitly enabled", () => {
    delete process.env["SQUARE_POS_ENABLED"];
    expect(isSquarePosEnabled()).toBe(false);
    process.env["SQUARE_POS_ENABLED"] = "0";
    expect(isSquarePosEnabled()).toBe(false);
    process.env["SQUARE_POS_ENABLED"] = "true";
    expect(isSquarePosEnabled()).toBe(true);
  });
});
