import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSquareReturnQueryForForwarding,
  parseSquareReturnResult,
  shouldRedirectToSquareSetup,
} from "../../../site/src/app/mobile/payment-return/routing";

const routeSource = readFileSync(
  join(process.cwd(), "../site/src/app/mobile/payment-return/route.ts"),
  "utf8",
);
const correlationId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const appointmentId = "33333333-3333-4333-8333-333333333333";
const validSuccess = {
  ok: true,
  data: {
    status: "verified",
    appointmentId,
    attemptId,
    errorCode: null,
    retryable: false,
  },
  receipt: {
    operationId: "44444444-4444-4444-8444-444444444444",
    correlationId,
    actorId: "55555555-5555-4555-8555-555555555555",
    committedAt: "2026-08-09T16:00:00.000Z",
    auditEventId: "66666666-6666-4666-8666-666666666666",
    entityType: "payment_attempt",
    entityId: attemptId,
    version: "2026-08-09T16:00:00.000Z",
    providerOperationId: "square-order-1",
  },
};

describe("mobile Square return routing", () => {
  it("accepts an exact iOS callback and retains only the signed state for hashing", () => {
    const params = new URLSearchParams({
      data: JSON.stringify({
        status: "ok",
        state: "signed-square-state.payload",
        transaction_id: "square-order-1",
      }),
    });
    expect(parseSquareReturnQueryForForwarding(params)).toEqual({
      ok: true,
      query: { data: params.get("data") },
      state: "signed-square-state.payload",
    });
  });

  it("rejects duplicates, unknown keys, mixed platforms, missing outcomes, and oversized input", () => {
    const duplicate = new URLSearchParams();
    duplicate.append("com.squareup.pos.REQUEST_METADATA", "state-1");
    duplicate.append("com.squareup.pos.REQUEST_METADATA", "state-2");
    duplicate.set("com.squareup.pos.SERVER_TRANSACTION_ID", "order-1");

    const cases = [
      duplicate,
      new URLSearchParams({ unknown: "value" }),
      new URLSearchParams({
        data: JSON.stringify({
          status: "ok",
          state: "state-1",
          transaction_id: "order-1",
        }),
        "com.squareup.pos.REQUEST_METADATA": "state-1",
      }),
      new URLSearchParams({
        "com.squareup.pos.REQUEST_METADATA": "state-1",
      }),
      new URLSearchParams({
        "com.squareup.pos.REQUEST_METADATA": "state-1",
        "com.squareup.pos.SERVER_TRANSACTION_ID": "x".repeat(16_385),
      }),
      new URLSearchParams({
        data: JSON.stringify({
          status: "ok",
          state: "state-1",
          error_code: "PAYMENT_CANCELED",
        }),
      }),
      new URLSearchParams({
        data: `{"status":"ok","state":"state-1","state":"state-2","transaction_id":"order-1"}`,
      }),
    ];

    for (const params of cases) {
      expect(parseSquareReturnQueryForForwarding(params)).toEqual({
        ok: false,
        errorCode: "invalid_square_callback",
      });
    }
  });

  it("accepts only the exact success receipt and matching correlation", () => {
    expect(parseSquareReturnResult(validSuccess, correlationId)).toEqual(
      validSuccess,
    );
    expect(
      parseSquareReturnResult(validSuccess, "other-correlation-id"),
    ).toBeNull();
    expect(
      parseSquareReturnResult(
        { ...validSuccess, extra: "ambiguous" },
        correlationId,
      ),
    ).toBeNull();
    expect(
      parseSquareReturnResult(
        {
          ...validSuccess,
          receipt: { ...validSuccess.receipt, entityId: appointmentId },
        },
        correlationId,
      ),
    ).toBeNull();
    expect(
      parseSquareReturnResult(
        {
          ...validSuccess,
          receipt: { ...validSuccess.receipt, version: null },
        },
        correlationId,
      ),
    ).toBeNull();
  });

  it("accepts an exact standard failure but rejects false or embellished failure shapes", () => {
    const failure = {
      ok: false,
      code: "conflict",
      message: "This callback has already been consumed.",
      retryable: false,
    };
    expect(parseSquareReturnResult(failure, correlationId)).toEqual(failure);
    expect(
      parseSquareReturnResult(
        { ...failure, status: "pending_verification" },
        correlationId,
      ),
    ).toBeNull();
    expect(
      parseSquareReturnResult(
        { ...failure, code: "unknown_failure" },
        correlationId,
      ),
    ).toBeNull();
  });

  it("opens setup only for an explicitly retryable setup failure", () => {
    expect(
      shouldRedirectToSquareSetup({
        status: "failed",
        errorCode: "ILLEGAL_LOCATION_ID",
        retryable: true,
      }),
    ).toBe(true);
    expect(
      shouldRedirectToSquareSetup({
        status: "pending_verification",
        errorCode: "ILLEGAL_LOCATION_ID",
        retryable: false,
      }),
    ).toBe(false);
    expect(
      shouldRedirectToSquareSetup({
        status: "failed",
        errorCode: "UNEXPECTED_PROVIDER_ERROR",
        retryable: true,
      }),
    ).toBe(false);
  });

  it("authenticates before reading callback parameters and uses a stable hashed idempotency key", () => {
    const resolvePrincipal = routeSource.indexOf(
      "await resolveTeamPrincipalFromCookies()",
    );
    const parseUrl = routeSource.indexOf("new URL(request.url)");
    const parseCallback = routeSource.indexOf(
      "parseSquareReturnQueryForForwarding",
      parseUrl,
    );
    expect(resolvePrincipal).toBeGreaterThan(-1);
    expect(parseUrl).toBeGreaterThan(resolvePrincipal);
    expect(parseCallback).toBeGreaterThan(parseUrl);
    expect(routeSource).toContain("callAdminApiAs(");
    expect(routeSource).toContain('`square-return:${createHash("sha256")');
    expect(routeSource).toContain('"Idempotency-Key": idempotencyKey');
    expect(routeSource).not.toContain("callAdminApiForCurrentSession");
  });

  it("has explicit secret-free outcomes for auth, malformed receipts, conflicts, throttling, and outages", () => {
    for (const outcome of [
      "Your session expired while returning from Square.",
      "square_return_permission_denied",
      "square_return_conflict",
      "invalid_square_callback",
      "square_return_rate_limited",
      "square_return_service_unavailable",
      "invalid_square_return_receipt",
    ]) {
      expect(routeSource).toContain(outcome);
    }
    expect(routeSource).toContain("readBoundedUpstreamJson(upstream)");
    expect(routeSource).toContain('"Referrer-Policy", "no-referrer"');
  });
});
