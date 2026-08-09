import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFinalTotalMutationResult } from "../../../site/src/app/mobile/final-total-mutation";
import { buildTeamRouteSecurityContract } from "@/lib/team-route-security-manifest";

const workspaceRoot = resolve(__dirname, "../../../..");
const routeSource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/api/app/api/appointments/[id]/final-total/route.ts",
  ),
  "utf8",
);
const commissionSource = readFileSync(
  resolve(workspaceRoot, "apps/api/src/lib/commissions.ts"),
  "utf8",
);
const proxySource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/site/src/app/api/mobile/appointments/[appointmentId]/final-total/route.ts",
  ),
  "utf8",
);
const sharedProxySource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/site/src/app/api/mobile/lib/appointment-proxy.ts",
  ),
  "utf8",
);
const panelSource = readFileSync(
  resolve(workspaceRoot, "apps/site/src/app/mobile/MobilePaymentPanel.tsx"),
  "utf8",
);

const appointmentId = "11111111-1111-4111-8111-111111111111";
const version = "2026-08-09T12:00:00.000Z";

function successfulResult() {
  return {
    ok: true as const,
    data: {
      appointmentId,
      finalTotalCents: 47_500,
      previousFinalTotalCents: 45_000,
      paidTowardJobCents: 10_000,
      paymentLocked: true,
      changed: true,
      version,
    },
    receipt: {
      operationId: "22222222-2222-4222-8222-222222222222",
      correlationId: "33333333-3333-4333-8333-333333333333",
      actorId: "44444444-4444-4444-8444-444444444444",
      committedAt: version,
      auditEventId: "55555555-5555-4555-8555-555555555555",
      entityType: "appointment",
      entityId: appointmentId,
      version,
    },
  };
}

describe("appointment final-total integrity", () => {
  it("authenticates a human before params/body/business DB and binds correction authority", () => {
    const baseBoundary = routeSource.indexOf(
      "const boundary = await beginTeamMutation(request, {",
    );
    const params = routeSource.indexOf("await context.params", baseBoundary);
    const body = routeSource.indexOf(
      "await readBoundedJsonRequest(request",
      params,
    );
    const database = routeSource.indexOf("const database = getDb()", body);

    expect(baseBoundary).toBeGreaterThan(0);
    expect(params).toBeGreaterThan(baseBoundary);
    expect(body).toBeGreaterThan(params);
    expect(database).toBeGreaterThan(body);
    expect(routeSource).toContain('principalTypes: ["human"]');
    expect(routeSource).toContain('requiredPermissions: ["payments.collect"]');
    expect(routeSource).toContain("hasPaymentManagementAuthority(request)");
    expect(routeSource).toContain(
      'strengthenTeamMutationPolicy(mutation, ["payments.manage"])',
    );
    expect(routeSource).toContain(
      "changed && paymentLock.hasSuccessfulPayment && canManagePayments",
    );
    expect(routeSource).not.toContain("const correctionBoundary");
    expect(routeSource).not.toContain("isAdminRequest");
    expect(routeSource).not.toContain("getAuditActorFromRequest");
    expect(routeSource).not.toContain("recordAuditEvent");
  });

  it("rejects query smuggling, malformed IDs, wildcard versions, and unbounded bodies", () => {
    expect(routeSource).toContain("request.nextUrl.search.length > 0");
    expect(routeSource).toContain("APPOINTMENT_ID_PATTERN.test(appointmentId)");
    expect(routeSource).toContain('value === "*"');
    expect(routeSource).toContain("new Date(value).toISOString() !== value");
    expect(routeSource).toContain("FINAL_TOTAL_REQUEST_MAXIMUM_BYTES = 1_024");
    expect(routeSource).toContain("readBoundedJsonRequest(request");
    expect(routeSource).toContain(".max(MAXIMUM_CENTS)");
    expect(routeSource).toContain(".strict()");
    expect(routeSource).not.toContain("request.json(");
  });

  it("uses maximum financial policy and durable payload/version idempotency", () => {
    const contract = buildTeamRouteSecurityContract({
      route: "app/api/appointments/[id]/final-total/route.ts",
      method: "PUT",
      permissions: ["payments.collect"],
    });

    expect(contract.risk).toBe("financial");
    expect(contract.requiresIdempotency).toBe(true);
    expect(contract.requiredPermissions).toEqual(["payments.collect"]);
    expect(routeSource).toContain(
      'route: "PUT /api/appointments/:appointmentId/final-total"',
    );
    expect(routeSource).toContain("payload: parsed.data");
    expect(routeSource).toContain("claimed.replay.result as FinalTotalResult");
    expect(routeSource).toContain("replayed: true");
    expect(routeSource).toContain("JSON.stringify(canonicalize(result))");
  });

  it("serializes payment safety, CAS, commissions, audit, and receipt in one transaction", () => {
    const transaction = routeSource.indexOf(
      "await database.transaction(async (tx)",
    );
    const advisoryLock = routeSource.indexOf(
      "pg_advisory_xact_lock",
      transaction,
    );
    const rowLock = routeSource.indexOf('.for("update")', advisoryLock);
    const paymentAttempt = routeSource.indexOf(
      "getBlockingSquareAttempt(",
      rowLock,
    );
    const paymentLedger = routeSource.indexOf(
      "getFinalTotalPaymentLock(tx, appointmentId)",
      paymentAttempt,
    );
    const payoutPeriod = routeSource.indexOf(
      "lockCompletedAppointmentPayoutPeriodInTransaction(",
      paymentLedger,
    );
    const cas = routeSource.indexOf(
      "eq(appointments.updatedAt, appointment.updatedAt)",
      paymentLedger,
    );
    const commissions = routeSource.indexOf(
      "recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(",
      cas,
    );
    const audit = routeSource.indexOf(
      "await mutation.audit.insertSuccess(tx",
      commissions,
    );
    const receipt = routeSource.indexOf(
      "teamMutationSuccessResult<FinalTotalData>",
      audit,
    );
    const idempotency = routeSource.indexOf(
      "await completeTeamMutationIdempotency(",
      receipt,
    );

    expect(advisoryLock).toBeGreaterThan(transaction);
    expect(rowLock).toBeGreaterThan(advisoryLock);
    expect(paymentAttempt).toBeGreaterThan(rowLock);
    expect(paymentLedger).toBeGreaterThan(paymentAttempt);
    expect(payoutPeriod).toBeGreaterThan(paymentLedger);
    expect(cas).toBeGreaterThan(payoutPeriod);
    expect(cas).toBeGreaterThan(paymentLedger);
    expect(commissions).toBeGreaterThan(cas);
    expect(audit).toBeGreaterThan(commissions);
    expect(receipt).toBeGreaterThan(audit);
    expect(idempotency).toBeGreaterThan(receipt);
    expect(routeSource).toContain(
      'if (changed && appointment.status === "completed")',
    );
    expect(routeSource).toContain(
      'changed && appointment.status === "completed"',
    );
    expect(routeSource).toContain("const appointmentVersionAt = changed");
    expect(routeSource).toContain(": appointment.updatedAt;");
    expect(routeSource).toContain("return completeFailure(");
    expect(routeSource).toContain("await insertFailure(tx");
    expect(routeSource).toContain(
      'additionalRequiredPermission: "payments.manage"',
    );
    expect(routeSource).toContain("settleTeamMutationIdempotencyFailure(");
    expect(routeSource).toContain("completedAt: appointments.completedAt");
    expect(routeSource).toContain(
      "Record a later adjustment instead of rewriting the completed job total.",
    );
    expect(routeSource).toContain("{ payoutRunIds }");
  });

  it("makes commission/schema and payout-report failures fail closed inside the caller transaction", () => {
    expect(commissionSource).toContain("failClosedOnSchemaMismatch?: boolean");
    expect(commissionSource).toContain(
      "recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction",
    );
    expect(commissionSource).toContain("failClosedOnSchemaMismatch: true");
    expect(commissionSource).toContain("await refreshDraftPayoutReports(");
    expect(commissionSource).toContain(
      "lockCompletedAppointmentPayoutPeriodInTransaction",
    );
    expect(commissionSource).toContain("payout_period_finalized");
    expect(commissionSource).toContain("acquirePayoutReportAdvisoryLock(");
    expect(commissionSource).toContain('.for("update")');
    expect(commissionSource).toContain(
      "savePayoutRunReportHtmlSerialized(tx, payoutRunId",
    );
    expect(commissionSource.match(/savePayoutRunReportHtml\(/gu)?.length).toBe(
      1,
    );
  });

  it("forwards stable mutation headers and rejects malformed upstream receipts", () => {
    expect(proxySource).toContain("forwardMutationHeaders: true");
    expect(proxySource).toContain("parseFinalTotalMutationResult(");
    expect(proxySource).toContain("invalid final-total receipt");
    for (const header of ["idempotency-key", "if-match"]) {
      expect(sharedProxySource).toContain(`"${header}"`);
    }
    expect(panelSource).toContain("pendingFinalTotalRequestRef");
    expect(panelSource).toContain("pendingRequest?.signature === signature");
    expect(panelSource).toContain('"idempotency-key": idempotencyKey');
    expect(panelSource).toContain('"if-match": requestVersion');
    expect(panelSource).toContain("parseFinalTotalMutationResult(");
    expect(panelSource).toContain("result.ok === response.ok");
    expect(panelSource).toContain("setCurrentVersion(result.data.version)");
    expect(panelSource).toContain("canManagePayments || !hasRecordedPayment");
    expect(panelSource).not.toContain("isOwner || !hasRecordedPayment");
  });
});

describe("mobile final-total receipt parser", () => {
  it("accepts only the expected appointment and exact audited receipt", () => {
    expect(
      parseFinalTotalMutationResult(successfulResult(), appointmentId),
    ).toEqual(successfulResult());
    expect(
      parseFinalTotalMutationResult(
        successfulResult(),
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).toBeNull();
  });

  it.each([
    { ok: true },
    { ...successfulResult(), receipt: { committedAt: version } },
    {
      ...successfulResult(),
      receipt: { ...successfulResult().receipt, version: "stale" },
    },
    {
      ...successfulResult(),
      data: { ...successfulResult().data, finalTotalCents: -1 },
    },
    { ...successfulResult(), forged: true },
    {
      ...successfulResult(),
      data: { ...successfulResult().data, forged: "field" },
    },
    {
      ...successfulResult(),
      receipt: { ...successfulResult().receipt, forged: "field" },
    },
    {
      ...successfulResult(),
      receipt: { ...successfulResult().receipt, auditEventId: "not-a-uuid" },
    },
    {
      ...successfulResult(),
      receipt: { ...successfulResult().receipt, actorId: "service:worker" },
    },
    { ok: false, code: "made_up", message: "No", retryable: false },
    {
      ok: false,
      code: "conflict",
      message: "No",
      retryable: false,
      forged: true,
    },
  ])("rejects a malformed upstream envelope %#", (value) => {
    expect(parseFinalTotalMutationResult(value, appointmentId)).toBeNull();
  });

  it("preserves an authoritative stale-version snapshot", () => {
    const failure = {
      ok: false,
      code: "conflict",
      message: "Review the latest total.",
      retryable: false,
      fieldErrors: { version: "Stale" },
      current: { finalTotalCents: 49_000, version },
    };
    expect(parseFinalTotalMutationResult(failure, appointmentId)).toEqual(
      failure,
    );
  });
});
