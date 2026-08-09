import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hashSquareAttemptLaunchBinding,
  isSquareAttemptLaunchBinding,
  type SquareAttemptLaunchBinding,
} from "@/lib/square-attempt-binding";
import { classifyPaymentCollectionAttemptSafety } from "@/lib/appointment-payment-attempt-safety";
import { buildTeamRouteSecurityContract } from "@/lib/team-route-security-manifest";
import {
  parseManualPaymentMutationResult,
  parseSquareAttemptMutationResult,
} from "../../../site/src/app/mobile/payment-collection-mutation";

const workspaceRoot = resolve(__dirname, "../../../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

const squareRoute = read(
  "apps/api/app/api/appointments/[id]/payment-attempts/route.ts",
);
const manualRoute = read(
  "apps/api/app/api/appointments/[id]/manual-payments/route.ts",
);
const squarePos = read("apps/api/src/lib/square-pos.ts");
const sharedMutation = read("apps/api/src/lib/appointment-payment-mutation.ts");
const routeManifest = read("apps/api/src/lib/team-route-security-manifest.ts");
const squareProxy = read(
  "apps/site/src/app/api/mobile/appointments/[appointmentId]/payment-attempts/route.ts",
);
const manualProxy = read(
  "apps/site/src/app/api/mobile/appointments/[appointmentId]/manual-payments/route.ts",
);
const sharedProxy = read(
  "apps/site/src/app/api/mobile/lib/appointment-proxy.ts",
);
const panel = read("apps/site/src/app/mobile/MobilePaymentPanel.tsx");
const databaseSchema = read("apps/api/src/db/schema.ts");
const appointmentVersionMigration = read(
  "apps/api/src/db/migrations/0098_appointment_version_precision.sql",
);

const appointmentId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const paymentId = "33333333-3333-4333-8333-333333333333";
const clientRequestId = "44444444-4444-4444-8444-444444444444";
const version = "2026-08-09T15:00:00.000Z";

const summary = {
  status: "unpaid" as const,
  jobTotalCents: 48_000,
  paidTowardJobCents: 0,
  tipCents: 0,
  refundedCents: 0,
  balanceCents: 48_000,
  activeAttemptId: attemptId,
  latestReceiptUrl: null,
};

function receipt(entityType: "payment_attempt" | "payment", entityId: string) {
  return {
    operationId: "55555555-5555-4555-8555-555555555555",
    correlationId: "66666666-6666-4666-8666-666666666666",
    actorId: "77777777-7777-4777-8777-777777777777",
    committedAt: version,
    auditEventId: "88888888-8888-4888-8888-888888888888",
    entityType,
    entityId,
    version,
  };
}

function squareSuccess() {
  return {
    ok: true as const,
    data: {
      appointmentId,
      attemptId,
      clientRequestId,
      platform: "ios" as const,
      amountCents: 48_000,
      status: "launched" as const,
      expiresAt: "2026-08-09T15:30:00.000Z",
      launchUrl: "square-commerce-v1://payment/create?data=signed",
      paymentSummary: summary,
      version,
    },
    receipt: receipt("payment_attempt", attemptId),
  };
}

function manualSuccess() {
  return {
    ok: true as const,
    data: {
      appointmentId,
      paymentId,
      clientRequestId,
      tenderType: "cash" as const,
      jobAmountCents: 48_000,
      tipCents: 2_000,
      totalAmountCents: 50_000,
      status: "completed" as const,
      paymentSummary: {
        ...summary,
        status: "paid" as const,
        paidTowardJobCents: 48_000,
        tipCents: 2_000,
        balanceCents: 0,
        activeAttemptId: null,
      },
      version,
    },
    receipt: receipt("payment", paymentId),
  };
}

describe("appointment payment collection integrity contract", () => {
  it.each([
    ["Square", squareRoute],
    ["manual", manualRoute],
  ])(
    "authenticates %s before query, params, body, config, or DB",
    (_name, source) => {
      const boundary = source.indexOf(
        "const boundary = await beginTeamMutation(request, {",
      );
      const query = source.indexOf("request.nextUrl.search.length", boundary);
      const params = source.indexOf("await context.params", query);
      const body = source.indexOf(
        "await readBoundedJsonRequest(request",
        params,
      );
      const database = source.indexOf("database = getDb()", body);

      expect(boundary).toBeGreaterThan(0);
      expect(query).toBeGreaterThan(boundary);
      expect(params).toBeGreaterThan(query);
      expect(body).toBeGreaterThan(params);
      expect(database).toBeGreaterThan(body);
      expect(source).toContain('principalTypes: ["human"]');
      expect(source).toContain('requiredPermissions: ["payments.collect"]');
      expect(source).toContain('risk: "financial"');
      expect(source).toContain("requiresIdempotency: true");
      expect(source).not.toContain("isAdminRequest");
      expect(source).not.toContain("getAuditActorFromRequest");
      expect(source).not.toContain("recordAuditEvent");
      expect(source).not.toContain("request.json(");
    },
  );

  it("keeps Square feature/config reads behind the verified boundary", () => {
    const boundary = squareRoute.indexOf("await beginTeamMutation(request");
    const feature = squareRoute.indexOf("isSquarePosEnabled()", boundary);
    const configuration = squareRoute.indexOf(
      "squareLaunchConfiguration()",
      feature,
    );
    const database = squareRoute.indexOf("database = getDb()", configuration);
    expect(feature).toBeGreaterThan(boundary);
    expect(configuration).toBeGreaterThan(feature);
    expect(database).toBeGreaterThan(configuration);
    expect(squareRoute).not.toContain("message: String(error)");
    expect(squareRoute).not.toContain("is not set");
  });

  it.each([
    ["Square", squareRoute],
    ["manual", manualRoute],
  ])("strictly bounds and versions %s requests", (_name, source) => {
    expect(source).toContain("request.nextUrl.search.length > 0");
    expect(source).toContain(
      "APPOINTMENT_PAYMENT_ID_PATTERN.test(appointmentId)",
    );
    expect(source).toContain("requireExactAppointmentPaymentVersion(");
    expect(source).toContain("APPOINTMENT_PAYMENT_REQUEST_MAXIMUM_BYTES");
    expect(source).toContain("deadlineMs: 8_000");
    expect(source).toContain(".strict()");
    expect(sharedMutation).toContain('expectedVersion === "*"');
    expect(sharedMutation).toContain(
      "new Date(expectedVersion).toISOString() !== expectedVersion",
    );
  });

  it.each([
    ["Square", squareRoute],
    ["manual", manualRoute],
  ])("serializes %s ledger state and uses appointment CAS", (_name, source) => {
    const transaction = source.indexOf("database.transaction(async (tx)");
    const advisory = source.indexOf("pg_advisory_xact_lock", transaction);
    const appointmentLock = source.indexOf('.for("update")', advisory);
    const scope = source.indexOf(
      "getAppointmentScopeState(appointmentId, tx)",
      appointmentLock,
    );
    const attemptsLock = source.indexOf(".from(paymentAttempts)", scope);
    const paymentsLock = source.indexOf(".from(payments)", attemptsLock);
    const cas = source.indexOf(
      "eq(appointments.updatedAt, appointment.updatedAt)",
      paymentsLock,
    );
    const audit = source.indexOf("mutation.audit.insertSuccess(tx", cas);
    const receipt = source.indexOf("teamMutationSuccessResult<", audit);
    const idempotency = source.indexOf(
      "completeTeamMutationIdempotency(",
      receipt,
    );

    expect(advisory).toBeGreaterThan(transaction);
    expect(appointmentLock).toBeGreaterThan(advisory);
    expect(scope).toBeGreaterThan(appointmentLock);
    expect(attemptsLock).toBeGreaterThan(scope);
    expect(paymentsLock).toBeGreaterThan(attemptsLock);
    expect(cas).toBeGreaterThan(paymentsLock);
    expect(audit).toBeGreaterThan(cas);
    expect(receipt).toBeGreaterThan(audit);
    expect(idempotency).toBeGreaterThan(receipt);
    expect(source).toContain("completeAppointmentPaymentFailure(");
    expect(source).toContain("settleTeamMutationIdempotencyFailure(");
  });

  it("keeps database appointment versions at the precision exposed by If-Match", () => {
    const postgresDefaultWithMicroseconds = "2026-08-09T11:13:40.651796Z";
    const appointmentsStart = databaseSchema.indexOf(
      "export const appointments = pgTable(",
    );
    const appointmentHoldsStart = databaseSchema.indexOf(
      "export const appointmentHolds = pgTable(",
      appointmentsStart,
    );
    const appointmentsBlock = databaseSchema.slice(
      appointmentsStart,
      appointmentHoldsStart,
    );

    expect(appointmentsStart).toBeGreaterThan(-1);
    expect(appointmentHoldsStart).toBeGreaterThan(appointmentsStart);
    expect(new Date(postgresDefaultWithMicroseconds).toISOString()).toBe(
      "2026-08-09T11:13:40.651Z",
    );
    expect(appointmentsBlock).toContain(
      'timestamp("updated_at", { withTimezone: true, precision: 3 })',
    );
    expect(appointmentVersionMigration).toContain(
      'ALTER COLUMN "updated_at" TYPE timestamp(3) with time zone',
    );
    expect(appointmentVersionMigration).toContain(
      "USING date_trunc('milliseconds', \"updated_at\")",
    );
    expect(appointmentVersionMigration).not.toContain(
      'ALTER COLUMN "created_at"',
    );
  });

  it("co-commits the exact signed Square handoff instead of updating after response", () => {
    const transaction = squareRoute.indexOf("database.transaction(async (tx)");
    const binding = squareRoute.indexOf(
      "const binding: SquareAttemptLaunchBinding",
      transaction,
    );
    const state = squareRoute.indexOf("createSquarePosState({", binding);
    const launch = squareRoute.indexOf("buildSquarePosLaunchUrl({", state);
    const launchMetadata = squareRoute.indexOf("const launchMetadata", launch);
    const audit = squareRoute.indexOf(
      "mutation.audit.insertSuccess(tx",
      launchMetadata,
    );
    const complete = squareRoute.indexOf(
      "completeTeamMutationIdempotency(",
      audit,
    );

    expect(binding).toBeGreaterThan(transaction);
    expect(state).toBeGreaterThan(binding);
    expect(launch).toBeGreaterThan(state);
    expect(launchMetadata).toBeGreaterThan(launch);
    expect(audit).toBeGreaterThan(launchMetadata);
    expect(complete).toBeGreaterThan(audit);
    for (const field of [
      "platform",
      "amountCents",
      "appointmentId",
      "attemptId",
      "expiresAt",
      "appointmentVersion",
      "clientRequestId",
      "memberId",
      "sessionId",
      "authMethod",
    ]) {
      expect(squareRoute).toContain(`${field}:`);
    }
    expect(squareRoute).toContain("hashSquareAttemptLaunchBinding(binding)");
    expect(squareRoute).toContain("bindingHash: launchBindingHash");
    expect(squareRoute).toContain('status: "launched"');
    expect(squareRoute).toContain('payment.provider === "square"');
    expect(squarePos).toContain("bindingHash?: string");

    const launchMetadataStart = squareRoute.indexOf("const launchMetadata = {");
    const launchMetadataEnd = squareRoute.indexOf("};", launchMetadataStart);
    const launchMetadataBlock = squareRoute.slice(
      launchMetadataStart,
      launchMetadataEnd,
    );
    expect(launchMetadataStart).toBeGreaterThan(-1);
    expect(launchMetadataEnd).toBeGreaterThan(launchMetadataStart);
    expect(launchMetadataBlock).toContain("launchBinding: binding");
    expect(launchMetadataBlock).toContain("launchBindingHash");
    expect(launchMetadataBlock).not.toContain("squareReturnState");
    expect(launchMetadataBlock).not.toContain("launchUrl");
  });

  it("records only the locked full manual balance and cancels only a safe retry", () => {
    expect(manualRoute).toContain(
      "const totalAmountCents = summaryBefore.balanceCents + input.tipCents",
    );
    expect(manualRoute).toContain("jobAmountCents: summaryBefore.balanceCents");
    expect(manualRoute).toContain('eq(paymentAttempts.status, "retryable")');
    expect(manualRoute).not.toContain(
      'inArray(paymentAttempts.status, [\n            "created"',
    );
    expect(manualRoute).toContain('canonicalStatus: "completed"');
    expect(manualRoute).toContain('payment.provider === "square"');
    expect(manualRoute).toContain("paymentSummary.balanceCents !== 0");
  });

  it("declares both endpoints as human-only maximum financial actions", () => {
    for (const route of [
      "app/api/appointments/[id]/payment-attempts/route.ts",
      "app/api/appointments/[id]/manual-payments/route.ts",
    ]) {
      const contract = buildTeamRouteSecurityContract({
        route,
        method: "POST",
        permissions: ["payments.collect"],
      });
      expect(contract).toMatchObject({
        risk: "financial",
        requiresIdempotency: true,
        principalTypes: ["human"],
        requiredPermissions: ["payments.collect"],
      });
      expect(routeManifest).toContain(`"${route}#POST": "financial"`);
    }
  });

  it("forwards mutation identity and validates upstream success at both proxies", () => {
    for (const source of [squareProxy, manualProxy]) {
      expect(source).toContain("forwardMutationHeaders: true");
      expect(source).toContain("rejectQueryParameters: true");
      expect(source).toContain("maxBodyBytes: 2 * 1024");
      expect(source).toContain("if (!upstream.ok) return upstream");
    }
    expect(squareProxy).toContain("parseSquareAttemptMutationResult(");
    expect(manualProxy).toContain("parseManualPaymentMutationResult(");
    for (const header of ["idempotency-key", "if-match", "x-correlation-id"]) {
      expect(sharedProxy).toContain(`"${header}"`);
    }
    expect(sharedProxy).toContain(
      "readBoundedBinaryBody(request, maxBodyBytes)",
    );
  });

  it("keeps separate stable Square/manual identities through uncertain retries", () => {
    expect(panel).toContain("pendingSquareRequestRef");
    expect(panel).toContain("pendingManualRequestRef");
    expect(panel).toContain("previous?.signature === signature");
    expect(panel).toContain("paymentActionInFlightRef.current");
    expect(panel).toContain('"idempotency-key": pending.key');
    expect(panel).toContain('"if-match": version');
    expect(panel).toContain('"x-correlation-id": pending.correlationId');
    expect(panel).toContain("parseSquareAttemptMutationResult(");
    expect(panel).toContain("parseManualPaymentMutationResult(");
    expect(panel).toContain("result.ok !== response.ok");
    expect(panel).toContain(
      "if (!result.retryable) pendingSquareRequestRef.current = null",
    );
    expect(panel).toContain(
      "if (!result.retryable) pendingManualRequestRef.current = null",
    );
  });
});

describe("signed Square launch binding", () => {
  const binding: SquareAttemptLaunchBinding = {
    platform: "ios",
    amountCents: 48_000,
    appointmentId,
    attemptId,
    expiresAt: "2026-08-09T15:30:00.000Z",
    appointmentVersion: version,
    clientRequestId,
    memberId: "77777777-7777-4777-8777-777777777777",
    sessionId: "99999999-9999-4999-8999-999999999999",
    authMethod: "team_session",
  };

  it("is strict and every protected field changes the digest", () => {
    expect(isSquareAttemptLaunchBinding(binding)).toBe(true);
    const baseline = hashSquareAttemptLaunchBinding(binding);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/u);
    for (const [field, changed] of Object.entries({
      platform: "android",
      amountCents: 47_999,
      appointmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expiresAt: "2026-08-09T15:29:59.000Z",
      appointmentVersion: "2026-08-09T14:59:59.000Z",
      clientRequestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      memberId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      authMethod: "break_glass",
    })) {
      expect(
        hashSquareAttemptLaunchBinding({
          ...binding,
          [field]: changed,
        } as SquareAttemptLaunchBinding),
      ).not.toBe(baseline);
    }
    expect(isSquareAttemptLaunchBinding({ ...binding, extra: true })).toBe(
      false,
    );
  });
});

describe("payment-attempt ambiguity classifier", () => {
  const row = (status: string, overrides: Record<string, unknown> = {}) => ({
    id: attemptId,
    status,
    providerOrderId: null,
    providerPaymentId: null,
    ...overrides,
  });

  it.each(["created", "launched", "pending_verification"])(
    "blocks an active %s attempt for verification",
    (status) => {
      expect(
        classifyPaymentCollectionAttemptSafety({
          attempts: [row(status)],
          financiallyCompletedPaymentAttemptIds: new Set(),
        }),
      ).toEqual({ kind: "verification", attemptId });
    },
  );

  it.each(["expired", "needs_review", "unknown_provider_state"])(
    "blocks an unresolved %s attempt for reconciliation",
    (status) => {
      expect(
        classifyPaymentCollectionAttemptSafety({
          attempts: [row(status)],
          financiallyCompletedPaymentAttemptIds: new Set(),
        }),
      ).toEqual({ kind: "reconciliation", attemptId });
    },
  );

  it("treats provider references and incomplete completed attempts as ambiguous", () => {
    expect(
      classifyPaymentCollectionAttemptSafety({
        attempts: [row("retryable", { providerOrderId: "order-1" })],
        financiallyCompletedPaymentAttemptIds: new Set(),
      }),
    ).toEqual({ kind: "reconciliation", attemptId });
    expect(
      classifyPaymentCollectionAttemptSafety({
        attempts: [row("completed")],
        financiallyCompletedPaymentAttemptIds: new Set(),
      }),
    ).toEqual({ kind: "reconciliation", attemptId });
  });

  it("allows one explicit no-transaction retry and settled history only", () => {
    expect(
      classifyPaymentCollectionAttemptSafety({
        attempts: [
          row("retryable"),
          row("completed", {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            providerOrderId: "settled-order",
          }),
          row("failed", {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          }),
        ],
        financiallyCompletedPaymentAttemptIds: new Set([
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ]),
      }),
    ).toEqual({ kind: "safe", retryableAttemptId: attemptId });
  });

  it("requires reconciliation for multiple retryable rows", () => {
    expect(
      classifyPaymentCollectionAttemptSafety({
        attempts: [
          row("retryable"),
          row("retryable", {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          }),
        ],
        financiallyCompletedPaymentAttemptIds: new Set(),
      }),
    ).toEqual({ kind: "reconciliation", attemptId });
  });
});

describe("mobile payment collection receipt parsers", () => {
  it("accepts exact audited Square and manual receipts", () => {
    expect(
      parseSquareAttemptMutationResult(squareSuccess(), appointmentId),
    ).toEqual(squareSuccess());
    expect(
      parseManualPaymentMutationResult(manualSuccess(), appointmentId),
    ).toEqual(manualSuccess());
  });

  it.each([
    { ...squareSuccess(), forged: true },
    {
      ...squareSuccess(),
      data: { ...squareSuccess().data, clientRequestId: "not-a-uuid" },
    },
    {
      ...squareSuccess(),
      data: { ...squareSuccess().data, amountCents: 47_999 },
    },
    {
      ...squareSuccess(),
      receipt: { ...squareSuccess().receipt, auditEventId: "missing" },
    },
    {
      ...squareSuccess(),
      data: { ...squareSuccess().data, launchUrl: "https://evil.example" },
    },
  ])("rejects a malformed Square receipt %#", (value) => {
    expect(parseSquareAttemptMutationResult(value, appointmentId)).toBeNull();
  });

  it.each([
    { ...manualSuccess(), forged: true },
    {
      ...manualSuccess(),
      data: { ...manualSuccess().data, totalAmountCents: 49_999 },
    },
    {
      ...manualSuccess(),
      data: {
        ...manualSuccess().data,
        paymentSummary: {
          ...manualSuccess().data.paymentSummary,
          balanceCents: 1,
        },
      },
    },
    {
      ...manualSuccess(),
      receipt: { ...manualSuccess().receipt, entityId: attemptId },
    },
  ])("rejects a malformed manual receipt %#", (value) => {
    expect(parseManualPaymentMutationResult(value, appointmentId)).toBeNull();
  });

  it("accepts only strict, known failure receipts", () => {
    const failure = {
      ok: false,
      code: "conflict",
      message: "Refresh the balance.",
      retryable: false,
      fieldErrors: { version: "Stale" },
      current: { version },
      attemptId,
    };
    expect(parseSquareAttemptMutationResult(failure, appointmentId)).toEqual(
      failure,
    );
    expect(
      parseManualPaymentMutationResult(
        { ...failure, forged: true },
        appointmentId,
      ),
    ).toBeNull();
  });
});
