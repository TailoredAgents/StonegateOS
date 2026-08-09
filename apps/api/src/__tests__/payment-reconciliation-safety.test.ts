import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  paymentReconciliationProviderFailure,
  PaymentReconciliationRequestSchema,
} from "@/lib/payment-reconciliation-admin";
import {
  nextPaymentReconciliationVersion,
  squareProviderEventVersion,
  summarizeSquareRecordResult,
  summarizeSquareSweep,
} from "@/lib/payment-reconciliation-safety";
import { SquareApiError } from "@/lib/square-client";
import { parsePaymentReconciliationSuccess } from "../../../site/src/app/team/lib/payment-reconciliation-result";

const API_ROOT = resolve(__dirname, "../..");
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function source(relativePath: string): string {
  return readFileSync(resolve(API_ROOT, relativePath), "utf8");
}

describe("payment reconciliation request safety", () => {
  it("accepts a confirmed read-only sweep and rejects the legacy target shape", () => {
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        operation: "run_square_reconciliation_sweep",
        confirmation: "RUN SQUARE CHECK",
      }).success,
    ).toBe(true);
    expect(
      PaymentReconciliationRequestSchema.safeParse({ sweep: true }).success,
    ).toBe(false);
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        operation: "run_square_reconciliation_sweep",
        confirmation: "RUN SQUARE CHECK",
        providerPaymentId: "unexpected-provider-target",
      }).success,
    ).toBe(false);
  });

  it("binds a Square payment retry to both local and provider IDs", () => {
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        operation: "retry_square_payment",
        paymentId: ID,
        providerPaymentId: "square-payment-123",
        confirmation: "RETRY SQUARE PAYMENT",
      }).success,
    ).toBe(true);
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        operation: "retry_square_payment",
        providerPaymentId: "square-payment-123",
        confirmation: "RETRY SQUARE PAYMENT",
      }).success,
    ).toBe(false);
  });

  it("binds a Square refund retry to both local and provider IDs", () => {
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        operation: "retry_square_refund",
        refundId: ID,
        providerRefundId: "square-refund-123",
        confirmation: "RETRY SQUARE REFUND",
      }).success,
    ).toBe(true);
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        operation: "retry_square_refund",
        refundId: ID,
        providerRefundId: "square-refund-123",
        confirmation: "RETRY SQUARE PAYMENT",
      }).success,
    ).toBe(false);
  });

  it("requires exact typed confirmation for destructive owner resolutions", () => {
    const dismiss = {
      operation: "dismiss_square_attempt",
      attemptId: ID,
      reviewNote: "Verified in Square that no charge exists.",
    } as const;
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        ...dismiss,
        confirmation: "NO SQUARE CHARGE",
      }).success,
    ).toBe(true);
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        ...dismiss,
        confirmation: "no square charge",
      }).success,
    ).toBe(false);
  });

  it("requires a complete Stripe allocation and explicit confirmation", () => {
    const request = {
      operation: "resolve_stripe_payment",
      paymentId: ID,
      appointmentId: SECOND_ID,
      jobAmountCents: 10_000,
      tipCents: 2_000,
      reviewNote: "Matched the completed Stripe receipt to this job.",
      confirmation: "ATTACH STRIPE PAYMENT",
    } as const;
    expect(PaymentReconciliationRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      PaymentReconciliationRequestSchema.safeParse({
        ...request,
        jobAmountCents: -1,
      }).success,
    ).toBe(false);
  });
});

describe("payment reconciliation outcome truthfulness", () => {
  it("maps Square throttling and timeouts to truthful retryable failures", () => {
    const throttled = paymentReconciliationProviderFailure(
      new SquareApiError("Square request failed (429)", 429, null),
    );
    expect(throttled).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryable: true,
    });
    expect(throttled.message).toContain("No charge or refund was initiated");

    const timedOut = new Error("The operation timed out");
    timedOut.name = "TimeoutError";
    const timeout = paymentReconciliationProviderFailure(timedOut);
    expect(timeout).toMatchObject({
      code: "timeout",
      status: 504,
      retryable: true,
    });
    expect(timeout.message).toContain("no charge or refund was initiated");
  });

  it("keeps unknown Square transport failures distinct from timeouts", () => {
    expect(
      paymentReconciliationProviderFailure(new TypeError("fetch failed")),
    ).toMatchObject({
      code: "provider_failed",
      status: 502,
      retryable: true,
    });
  });

  it("does not label pending or review results as verified", () => {
    expect(
      summarizeSquareRecordResult({
        kind: "attempt",
        status: "pending_verification",
      }).outcome,
    ).toBe("pending");
    expect(
      summarizeSquareRecordResult({
        kind: "refund",
        status: "needs_review",
      }).outcome,
    ).toBe("needs_review");
    expect(
      summarizeSquareRecordResult({ kind: "event", status: "failed" }).outcome,
    ).toBe("needs_review");
  });

  it("labels a clean provider result verified and states the no-money effect", () => {
    const summary = summarizeSquareRecordResult({
      kind: "payment",
      status: "processed",
    });
    expect(summary.outcome).toBe("verified");
    expect(summary.message).toContain("No charge or refund was initiated");
  });

  it("keeps a partial sweep in review without inventing an exact item count", () => {
    const summary = summarizeSquareSweep({
      pending: 1,
      needsReview: 2,
      unmatched: 1,
      refundsNeedsReview: 1,
    });
    expect(summary.outcome).toBe("completed_with_review");
    expect(summary.message).toContain("one or more payment records");
  });

  it("builds deterministic event versions and strictly increasing local versions", () => {
    expect(
      squareProviderEventVersion({
        processingStatus: "failed",
        receivedAt: new Date("2026-08-08T12:00:00.000Z"),
        processedAt: new Date("2026-08-08T12:01:00.000Z"),
      }),
    ).toBe("failed:2026-08-08T12:01:00.000Z");
    expect(
      nextPaymentReconciliationVersion(
        new Date("2026-08-08T12:00:00.000Z"),
        new Date("2026-08-08T12:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-08-08T12:00:00.001Z");
  });

  it("accepts only an operation-matched success with a complete audit receipt", () => {
    const success = {
      ok: true,
      data: {
        operation: "retry_square_payment",
        outcome: "verified",
        message: "Square verified the payment.",
        providerEffect: "read_only",
        targetId: ID,
      },
      receipt: {
        operationId: ID,
        correlationId: "request-correlation-123",
        actorId: SECOND_ID,
        committedAt: "2026-08-08T12:00:00.000Z",
        auditEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    };
    expect(
      parsePaymentReconciliationSuccess(success, "retry_square_payment"),
    ).toEqual({
      message: "Square verified the payment.",
      outcome: "verified",
      needsAttention: false,
    });
    expect(
      parsePaymentReconciliationSuccess(success, "retry_square_refund"),
    ).toBeNull();
    expect(
      parsePaymentReconciliationSuccess(
        { ...success, receipt: { ...success.receipt, auditEventId: null } },
        "retry_square_payment",
      ),
    ).toBeNull();
  });

  it("routes pending and review outcomes to an attention message", () => {
    expect(
      parsePaymentReconciliationSuccess(
        {
          ok: true,
          data: {
            operation: "retry_square_event",
            outcome: "needs_review",
            message: "The provider event still needs review.",
            providerEffect: "read_only",
            targetId: ID,
          },
          receipt: {
            operationId: ID,
            correlationId: "request-correlation-123",
            actorId: SECOND_ID,
            committedAt: "2026-08-08T12:00:00.000Z",
            auditEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          },
        },
        "retry_square_event",
      )?.needsAttention,
    ).toBe(true);
  });
});

describe("payment reconciliation implementation contract", () => {
  const route = source("app/api/admin/payments/reconciliation/route.ts");
  const engine = source("src/lib/payment-reconciliation-admin.ts");
  const idempotency = source("src/lib/team-mutation-idempotency.ts");
  const action = source("../site/src/app/team/actions.ts");
  const panel = source(
    "../site/src/app/team/components/PaymentReconciliationPanel.tsx",
  );

  it("authorizes both financial permissions before parsing or database access", () => {
    const post = route.slice(route.indexOf("export async function POST"));
    const boundary = post.indexOf("beginTeamMutation(request");
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(post).toContain(
      'requiredPermissions: ["payments.reconcile", "payments.manage"]',
    );
    expect(post).toContain('risk: "financial"');
    expect(post).toContain("requiresIdempotency: true");
    expect(boundary).toBeLessThan(post.indexOf("request.json()"));
    expect(boundary).toBeLessThan(post.indexOf("getDb()"));
  });

  it("requires idempotency, versions, a long provider lease, and one Square mutex", () => {
    expect(engine).toContain("claimTeamMutationIdempotency(");
    expect(engine).toContain("extendTeamMutationIdempotencyLease(");
    expect(engine).toContain("assertTeamMutationExpectedVersion(");
    expect(engine).toContain("pg_try_advisory_xact_lock(hashtextextended");
    expect(engine).toContain("PROVIDER_OPERATION_LEASE_MS");
    expect(idempotency).toContain("MAX_EXTENDED_CLAIM_LEASE_MS");
    expect(idempotency).toContain(
      "eq(teamMutationIdempotency.operationId, mutation.operationId)",
    );
  });

  it("commits local owner resolutions with their audit and replay receipt", () => {
    const ownerResolution = engine.slice(
      engine.indexOf("async function executeOwnerResolution"),
      engine.indexOf(
        "export async function executePaymentReconciliationMutation",
      ),
    );
    const completion = engine.slice(
      engine.indexOf("async function completeReconciliationMutation"),
      engine.indexOf("type ProviderEventRetryResult"),
    );
    expect(ownerResolution).toContain("db.transaction(async (tx)");
    expect(ownerResolution).toContain("completeReconciliationMutation");
    expect(completion).toContain("mutation.audit.insertSuccess");
    expect(completion).toContain("completeTeamMutationIdempotency");
    expect(completion.indexOf("mutation.audit.insertSuccess")).toBeLessThan(
      completion.indexOf("completeTeamMutationIdempotency"),
    );
    expect(ownerResolution).toContain('.for("update")');
    expect(ownerResolution).toContain("eq(paymentAttempts.updatedAt");
    expect(ownerResolution).toContain("eq(paymentRefunds.updatedAt");
  });

  it("prevents arbitrary provider-ID retries by comparing the local record", () => {
    expect(engine).toContain(
      "before.providerPaymentId !== input.providerPaymentId",
    );
    expect(engine).toContain(
      "before.providerRefundId !== input.providerRefundId",
    );
    expect(engine).toContain('providerEffect: "read_only"');
  });

  it("forwards safety headers and refuses a malformed 2xx success envelope", () => {
    const start = action.indexOf(
      "export async function paymentReconciliationAction",
    );
    const end = action.indexOf("export async function ", start + 30);
    const reconciliationAction = action.slice(start, end);
    expect(reconciliationAction).toContain('"Idempotency-Key": idempotencyKey');
    expect(reconciliationAction).toContain('"If-Match"');
    expect(reconciliationAction).toContain(
      "parsePaymentReconciliationSuccess(",
    );
    expect(reconciliationAction).toContain(
      'name: feedback.needsAttention ? "myst-flash-error" : "myst-flash"',
    );
  });

  it("renders a replay key, record version, local IDs, and typed confirmations", () => {
    expect(panel).toContain('name="idempotencyKey"');
    expect(panel).toContain('name="expectedVersion"');
    expect(panel).toContain('name="paymentId" value={payment.id}');
    expect(panel).toContain('name="refundId" value={refund.id}');
    expect(panel).toContain('pattern="NO SQUARE CHARGE"');
    expect(panel).toContain('pattern="ATTACH STRIPE PAYMENT"');
    expect(panel).toContain('pattern="ACKNOWLEDGE REFUND IMPACT"');
  });
});
