import {
  canReclaimSquareProviderEvent,
  canSkipFinalSquareProviderRecord,
  reconcilePendingSquareAttempts,
  SQUARE_PROVIDER_EVENT_LEASE_MS,
  squareProviderReferenceConflicts,
} from "@/lib/square-payments";
import * as paymentSchema from "@/lib/payment-schema";
import * as squareClient from "@/lib/square-client";
import {
  blocksPaymentMutationForAttempt,
  canDismissSquareAttemptAfterReview,
  requiresSquareAttemptReconciliation,
} from "@/lib/payment-ledger";

describe("Square completed-attempt reconciliation", () => {
  it("flags a second provider order or payment instead of accepting the first linked row", () => {
    expect(
      squareProviderReferenceConflicts({
        storedOrderId: "order-first",
        storedPaymentId: "payment-first",
        incomingOrderId: "order-second",
        incomingPaymentId: "payment-second",
      }),
    ).toBe(true);

    expect(
      squareProviderReferenceConflicts({
        storedOrderId: "order-first",
        storedPaymentId: "payment-first",
        incomingOrderId: "order-first",
        incomingPaymentId: "payment-first",
      }),
    ).toBe(false);

    expect(
      squareProviderReferenceConflicts({
        storedOrderId: "order-first",
        storedPaymentId: "payment-first",
        incomingOrderId: "order-first",
        incomingPaymentId: "payment-second",
      }),
    ).toBe(true);
  });
});

describe("Square provider sweep skip rules", () => {
  it("skips only final local records whose provider status is unchanged", () => {
    expect(
      canSkipFinalSquareProviderRecord({
        canonicalStatus: "completed",
        localProviderStatus: "COMPLETED",
        incomingProviderStatus: "completed",
      }),
    ).toBe(true);
    expect(
      canSkipFinalSquareProviderRecord({
        canonicalStatus: "needs_review",
        localProviderStatus: "COMPLETED",
        incomingProviderStatus: "COMPLETED",
      }),
    ).toBe(true);
    expect(
      canSkipFinalSquareProviderRecord({
        canonicalStatus: "pending",
        localProviderStatus: "COMPLETED",
        incomingProviderStatus: "COMPLETED",
      }),
    ).toBe(false);
    expect(
      canSkipFinalSquareProviderRecord({
        canonicalStatus: "completed",
        localProviderStatus: "PENDING",
        incomingProviderStatus: "COMPLETED",
      }),
    ).toBe(false);
  });
});

describe("Square worker before payment migration", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not query Square or the payment ledger before 0059 exists", async () => {
    jest
      .spyOn(paymentSchema, "isPaymentLedgerSchemaAvailable")
      .mockResolvedValue(false);
    const listPayments = jest.spyOn(squareClient, "listSquarePayments");
    const listRefunds = jest.spyOn(squareClient, "listSquareRefunds");

    await expect(reconcilePendingSquareAttempts()).resolves.toEqual({
      inspected: 0,
      verified: 0,
      pending: 0,
      needsReview: 0,
      unmatched: 0,
      paymentsInspected: 0,
      paymentsSkipped: 0,
      unmatchedPayments: 0,
      refundsInspected: 0,
      refundsReconciled: 0,
      refundsSkipped: 0,
      refundsNeedsReview: 0,
    });
    expect(listPayments).not.toHaveBeenCalled();
    expect(listRefunds).not.toHaveBeenCalled();
  });
});

describe("Square attempt collection gate", () => {
  it("requires owner reconciliation for expired and needs-review attempts", () => {
    expect(requiresSquareAttemptReconciliation("expired")).toBe(true);
    expect(requiresSquareAttemptReconciliation("needs_review")).toBe(true);
    expect(requiresSquareAttemptReconciliation("created")).toBe(false);
    expect(requiresSquareAttemptReconciliation("canceled")).toBe(false);
    expect(requiresSquareAttemptReconciliation("completed")).toBe(false);
  });

  it("blocks final-total mutations for active and unresolved attempts", () => {
    for (const status of [
      "created",
      "launched",
      "pending_verification",
      "expired",
      "needs_review",
    ]) {
      expect(blocksPaymentMutationForAttempt(status)).toBe(true);
    }
    for (const status of ["completed", "canceled", "failed", null]) {
      expect(blocksPaymentMutationForAttempt(status)).toBe(false);
    }
  });

  it("lets the owner dismiss only failed or reconciled-review attempts", () => {
    for (const status of ["failed", "expired", "needs_review"]) {
      expect(canDismissSquareAttemptAfterReview(status)).toBe(true);
    }
    for (const status of [
      "created",
      "launched",
      "pending_verification",
      "completed",
      "canceled",
      null,
    ]) {
      expect(canDismissSquareAttemptAfterReview(status)).toBe(false);
    }
  });
});

describe("Square provider event processing lease", () => {
  const now = new Date("2026-07-24T12:00:00.000Z");

  it("reclaims failed and stale in-progress events", () => {
    expect(
      canReclaimSquareProviderEvent({
        processingStatus: "failed",
        receivedAt: now,
        processedAt: now,
        now,
      }),
    ).toBe(true);
    expect(
      canReclaimSquareProviderEvent({
        processingStatus: "processing",
        receivedAt: now,
        processedAt: new Date(now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS),
        now,
      }),
    ).toBe(true);
    expect(
      canReclaimSquareProviderEvent({
        processingStatus: "received",
        receivedAt: new Date(
          now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS - 1,
        ),
        processedAt: null,
        now,
      }),
    ).toBe(true);
  });

  it("does not steal a fresh lease or reopen a final event", () => {
    expect(
      canReclaimSquareProviderEvent({
        processingStatus: "processing",
        receivedAt: now,
        processedAt: new Date(now.getTime() - 1_000),
        now,
      }),
    ).toBe(false);
    expect(
      canReclaimSquareProviderEvent({
        processingStatus: "processed",
        receivedAt: new Date(
          now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS * 2,
        ),
        processedAt: new Date(
          now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS * 2,
        ),
        now,
      }),
    ).toBe(false);
    expect(
      canReclaimSquareProviderEvent({
        processingStatus: "needs_review",
        receivedAt: new Date(
          now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS * 2,
        ),
        processedAt: new Date(
          now.getTime() - SQUARE_PROVIDER_EVENT_LEASE_MS * 2,
        ),
        now,
      }),
    ).toBe(false);
  });
});
