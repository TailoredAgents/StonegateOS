import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertSalesEscalationReconciliationSidConsistency,
  classifySalesEscalationReconciliationTaskEffect,
  planSalesEscalationCallReconciliation,
  SalesEscalationCallReconciliationSchema,
  type SalesEscalationCallReconciliationInput,
} from "@/lib/sales-escalation-call-reconciliation";
import { TeamMutationFailure } from "@/lib/team-mutation";
import { isSalesEscalationCallReconciliationSuccess } from "../../../site/src/app/team/lib/sales-escalation-call-reconciliation-result";
import {
  buildCallReconciliationIdempotencyKey,
  buildCallReconciliationScope,
} from "../../../site/src/app/team/lib/call-reconciliation-idempotency";

const REPO_ROOT = resolve(process.cwd(), "../..");
const operationId = "11111111-1111-4111-8111-111111111111";
const reconciliationId = "22222222-2222-4222-8222-222222222222";
const auditEventId = "33333333-3333-4333-8333-333333333333";
const callRecordId = "44444444-4444-4444-8444-444444444444";
const parentSid = `CA${"a".repeat(32)}`;
const customerSid = `CA${"b".repeat(32)}`;

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function input(
  overrides: Partial<SalesEscalationCallReconciliationInput> = {},
): SalesEscalationCallReconciliationInput {
  return {
    salesEscalationOperationId: operationId,
    confirmation: "RECONCILE CALL",
    outcome: "confirmed_dispatched",
    evidenceType: "provider_call_record",
    providerOperationId: parentSid,
    providerCustomerOperationId: null,
    providerCallStatus: "ringing",
    providerCustomerStatus: null,
    connectedDurationSec: null,
    reason: "Twilio shows an accepted parent call with no terminal result.",
    ...overrides,
  };
}

function operation(
  overrides: Partial<
    Parameters<typeof planSalesEscalationCallReconciliation>[0]
  > = {},
): Parameters<typeof planSalesEscalationCallReconciliation>[0] {
  return {
    state: "reconciliation_required",
    reconciliationResolutionId: null,
    terminalAt: null,
    deliveryCertainty: "uncertain",
    providerOperationId: null,
    providerCustomerOperationId: null,
    ...overrides,
  };
}

const noCallbacks = {
  count: 0,
  hasAppliedEvidence: false,
  hasAnomaly: false,
};

describe("sales escalation call reconciliation evidence", () => {
  it("keeps refresh retries stable while separating corrected evidence", () => {
    const scope = buildCallReconciliationScope(
      "sales_escalation",
      operationId,
      7,
    );
    expect(scope).toBe(`sales-call-reconcile:${operationId}:v7`);
    const first = buildCallReconciliationIdempotencyKey({
      kind: "sales_escalation",
      operationId,
      expectedVersion: 7,
      payload: { outcome: "confirmed_dispatched", reason: "Reviewed A" },
    });
    expect(
      buildCallReconciliationIdempotencyKey({
        kind: "sales_escalation",
        operationId,
        expectedVersion: 7,
        payload: { reason: "Reviewed A", outcome: "confirmed_dispatched" },
      }),
    ).toBe(first);
    expect(
      buildCallReconciliationIdempotencyKey({
        kind: "sales_escalation",
        operationId,
        expectedVersion: 7,
        payload: { outcome: "confirmed_dispatched", reason: "Reviewed B" },
      }),
    ).not.toBe(first);
  });

  it("accepts only the three conservative, outcome-specific evidence shapes", () => {
    expect(
      SalesEscalationCallReconciliationSchema.safeParse(input()).success,
    ).toBe(true);
    expect(
      SalesEscalationCallReconciliationSchema.safeParse(
        input({
          outcome: "confirmed_connected",
          providerCallStatus: "completed",
          providerCustomerOperationId: customerSid,
          providerCustomerStatus: "completed",
          connectedDurationSec: 47,
        }),
      ).success,
    ).toBe(true);
    expect(
      SalesEscalationCallReconciliationSchema.safeParse(
        input({
          outcome: "confirmed_not_dispatched",
          evidenceType: "provider_no_matching_call",
          providerOperationId: null,
          providerCallStatus: null,
        }),
      ).success,
    ).toBe(true);

    for (const invalid of [
      input({
        outcome: "confirmed_connected",
        providerCallStatus: "completed",
        providerCustomerOperationId: customerSid,
        providerCustomerStatus: "completed",
        connectedDurationSec: null,
      }),
      input({
        outcome: "confirmed_connected",
        providerCallStatus: "completed",
        providerCustomerOperationId: parentSid,
        providerCustomerStatus: "completed",
        connectedDurationSec: 5,
      }),
      input({
        outcome: "confirmed_not_dispatched",
        evidenceType: "provider_no_matching_call",
        providerOperationId: parentSid,
        providerCallStatus: "failed",
      }),
      input({
        outcome: "confirmed_dispatched",
        evidenceType: "provider_no_matching_call",
      }),
    ]) {
      expect(
        SalesEscalationCallReconciliationSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  it("keeps confirmed dispatch nondecisive and requires both completed legs for connection", () => {
    expect(
      planSalesEscalationCallReconciliation(operation(), noCallbacks, input()),
    ).toEqual({
      decisive: false,
      terminalOutcome: null,
      outcomeReason: null,
      providerOperationId: parentSid,
      providerCustomerOperationId: null,
    });
    expect(
      planSalesEscalationCallReconciliation(
        operation(),
        noCallbacks,
        input({
          outcome: "confirmed_connected",
          providerCallStatus: "completed",
          providerCustomerOperationId: customerSid,
          providerCustomerStatus: "completed",
          connectedDurationSec: 47,
        }),
      ),
    ).toMatchObject({
      decisive: true,
      terminalOutcome: "connected",
      outcomeReason: "operator_confirmed_connected",
    });
  });

  it("allows not-dispatched only for an uncertain attempt with no SID or signed callback", () => {
    const notDispatched = input({
      outcome: "confirmed_not_dispatched",
      evidenceType: "provider_no_matching_call",
      providerOperationId: null,
      providerCallStatus: null,
    });
    expect(
      planSalesEscalationCallReconciliation(
        operation(),
        noCallbacks,
        notDispatched,
      ),
    ).toMatchObject({
      decisive: true,
      terminalOutcome: "not_dispatched",
      outcomeReason: "operator_confirmed_not_dispatched",
    });

    for (const [operationOverride, callbackCount] of [
      [{ deliveryCertainty: "accepted" as const }, 0],
      [{ providerOperationId: parentSid }, 0],
      [{ providerCustomerOperationId: customerSid }, 0],
      [{}, 1],
    ] as const) {
      expect(() =>
        planSalesEscalationCallReconciliation(
          operation(operationOverride),
          { ...noCallbacks, count: callbackCount },
          notDispatched,
        ),
      ).toThrow(TeamMutationFailure);
    }
  });

  it("rejects stale/settled operations and conflicting reviewed SIDs", () => {
    for (const invalidOperation of [
      operation({ state: "succeeded" }),
      operation({ reconciliationResolutionId: reconciliationId }),
      operation({ terminalAt: new Date("2026-08-09T12:00:00.000Z") }),
    ]) {
      expect(() =>
        planSalesEscalationCallReconciliation(
          invalidOperation,
          noCallbacks,
          input(),
        ),
      ).toThrow(TeamMutationFailure);
    }
    expect(() =>
      planSalesEscalationCallReconciliation(
        operation({ providerOperationId: `CA${"c".repeat(32)}` }),
        noCallbacks,
        input(),
      ),
    ).toThrow(TeamMutationFailure);
  });

  it("rejects dispatched A to connected B and cross-operation SID reuse", () => {
    const otherParentSid = `CA${"c".repeat(32)}`;
    expect(() =>
      assertSalesEscalationReconciliationSidConsistency(
        {
          operationId,
          providerOperationId: otherParentSid,
          providerCustomerOperationId: customerSid,
        },
        [
          {
            operationId,
            providerOperationId: parentSid,
            providerCustomerOperationId: null,
          },
        ],
        [],
      ),
    ).toThrow(TeamMutationFailure);
    expect(() =>
      assertSalesEscalationReconciliationSidConsistency(
        {
          operationId,
          providerOperationId: parentSid,
          providerCustomerOperationId: null,
        },
        [],
        [
          {
            sid: parentSid,
            operationId: "88888888-8888-4888-8888-888888888888",
            leg: "parent",
          },
        ],
      ),
    ).toThrow(TeamMutationFailure);
    expect(() =>
      assertSalesEscalationReconciliationSidConsistency(
        {
          operationId,
          providerOperationId: parentSid,
          providerCustomerOperationId: customerSid,
        },
        [
          {
            operationId,
            providerOperationId: parentSid,
            providerCustomerOperationId: null,
          },
        ],
        [
          { sid: parentSid, operationId, leg: "parent" },
          { sid: customerSid, operationId, leg: "customer" },
        ],
      ),
    ).not.toThrow();
  });

  it("completes only the exact open task snapshot", () => {
    const taskUpdatedAt = new Date("2026-08-09T12:00:00.000Z");
    const operationTask = {
      contactId: "contact-1",
      agentMemberId: "member-1",
      taskUpdatedAt,
    };
    expect(
      classifySalesEscalationReconciliationTaskEffect(
        {
          contactId: "contact-1",
          assignedTo: "member-1",
          status: "open",
          updatedAt: taskUpdatedAt,
        },
        operationTask,
      ),
    ).toBe("complete");
    expect(
      classifySalesEscalationReconciliationTaskEffect(null, operationTask),
    ).toBe("already_terminal");
    expect(
      classifySalesEscalationReconciliationTaskEffect(
        {
          contactId: "contact-1",
          assignedTo: "member-2",
          status: "open",
          updatedAt: taskUpdatedAt,
        },
        operationTask,
      ),
    ).toBe("stale");
  });
});

describe("sales escalation call reconciliation contracts", () => {
  const postRoute = source(
    "apps/api/app/api/admin/calls/reconciliation/sales-escalations/route.ts",
  );
  const getRoute = source(
    "apps/api/app/api/admin/calls/reconciliation/route.ts",
  );
  const migration = source(
    "apps/api/src/db/migrations/0088_sales_escalation_call_reconciliation.sql",
  );
  const callbacks = source(
    "apps/api/src/lib/sales-escalation-call-operations.ts",
  );
  const panel = source(
    "apps/site/src/app/team/components/CallReconciliationPanel.tsx",
  );
  const action = source("apps/site/src/app/team/actions.ts");

  it("authorizes a human reviewer before bounded parsing or database access", () => {
    const boundary = postRoute.indexOf("beginTeamMutation(request");
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(postRoute).toContain('principalTypes: ["human"]');
    expect(postRoute).toContain('requiredPermissions: ["calls.reconcile"]');
    expect(postRoute).toContain('risk: "normal"');
    expect(postRoute).toContain("requiresIdempotency: true");
    expect(postRoute).toContain(
      'auditAction: "sales.escalation.call.reconciled"',
    );
    expect(boundary).toBeLessThan(
      postRoute.indexOf("readBoundedJsonRequest(request"),
    );
    expect(boundary).toBeLessThan(postRoute.indexOf("const db = getDb()"));
    expect(postRoute).toContain("maximumBytes: 4 * 1024");
  });

  it("serializes reviewer/callback races with an exact version and row lock", () => {
    const transaction = postRoute.slice(
      postRoute.indexOf("db.transaction(async (tx)"),
    );
    const operationLock = transaction.indexOf("const [operation] = await tx");
    const priorEvidence = transaction.indexOf("const priorSidEvidence");
    const callbackAggregate = transaction.indexOf(
      "const [callbackEvidence] = await tx",
    );
    const evidencePlan = transaction.indexOf(
      "planSalesEscalationCallReconciliation(",
    );
    expect(transaction).toContain("pg_advisory_xact_lock");
    expect(operationLock).toBeGreaterThanOrEqual(0);
    expect(transaction.slice(operationLock, callbackAggregate)).toContain(
      '.for("update")',
    );
    expect(operationLock).toBeLessThan(callbackAggregate);
    expect(priorEvidence).toBeGreaterThan(operationLock);
    expect(priorEvidence).toBeLessThan(callbackAggregate);
    expect(callbackAggregate).toBeLessThan(evidencePlan);
    expect(transaction).toContain("operation.version !== expectedVersion");
    expect(transaction).toContain(
      "eq(salesEscalationCallOperations.version, operation.version)",
    );
    expect(transaction).toMatch(
      /isNull\(\s*salesEscalationCallOperations\.reconciliationResolutionId/u,
    );
    expect(transaction).toContain(
      "isNull(salesEscalationCallOperations.terminalAt)",
    );
    expect(transaction).toContain("priorSidEvidence");
    expect(transaction).toContain("salesEscalationCallReconciliationSidClaims");
    expect(transaction).toContain(
      "assertSalesEscalationReconciliationSidConsistency",
    );
    const callbackLock = callbacks.slice(
      callbacks.indexOf("async function lockCallbackOperation"),
      callbacks.indexOf("async function callbackContext"),
    );
    expect(callbackLock).toContain(
      "operation.reconciliationResolutionId !== null",
    );
    expect(
      callbackLock.indexOf("operation.reconciliationResolutionId !== null"),
    ).toBeLessThan(callbackLock.indexOf('operation.state !== "dispatched"'));
  });

  it("commits audit, evidence, linked records, resolution, and replay receipt together", () => {
    const transaction = postRoute.slice(
      postRoute.indexOf("db.transaction(async (tx)"),
    );
    const sidClaim = transaction.indexOf(
      ".insert(salesEscalationCallReconciliationSidClaims)",
    );
    const audit = transaction.indexOf("mutation.audit.insertSuccess(tx");
    const evidence = transaction.indexOf(
      "tx.insert(salesEscalationCallReconciliations)",
    );
    const taskMutation = transaction.indexOf(".update(crmTasks)");
    const operationMutation = transaction.indexOf(
      ".update(salesEscalationCallOperations)",
    );
    const receipt = transaction.indexOf("completeTeamMutationIdempotency(");
    expect(sidClaim).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(sidClaim);
    expect(evidence).toBeGreaterThan(audit);
    expect(taskMutation).toBeGreaterThan(evidence);
    expect(operationMutation).toBeGreaterThan(taskMutation);
    expect(receipt).toBeGreaterThan(operationMutation);
    const safeAudit = transaction.slice(audit, evidence);
    expect(safeAudit).toContain("reasonRecorded: true");
    expect(safeAudit).toContain("reasonLength:");
    expect(safeAudit).not.toContain("reason: parsed.data.reason");
    expect(postRoute).toContain("providerCalled: false");
    expect(postRoute).toContain("providerReplayAttempted: false");
    expect(postRoute).not.toContain("createTwilioOutboundCall");
  });

  it("claims, replays, and settles one exact idempotent human request", () => {
    const claim = postRoute.indexOf("claimTeamMutationIdempotency(");
    const replay = postRoute.indexOf(
      "teamMutationIdempotencyReplayResponse(claimed.replay)",
    );
    const transaction = postRoute.indexOf("db.transaction(async (tx)");
    const failureSettlement = postRoute.indexOf(
      "settleTeamMutationIdempotencyFailure(",
    );
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(replay).toBeGreaterThan(claim);
    expect(transaction).toBeGreaterThan(replay);
    expect(failureSettlement).toBeGreaterThan(transaction);
    expect(postRoute.slice(claim, transaction)).toContain(
      'route: "POST /api/admin/calls/reconciliation/sales-escalations"',
    );
    expect(postRoute.slice(claim, transaction)).toContain(
      "payload: parsed.data",
    );
    expect(postRoute).toContain("reconciliationClaim.keyHash");
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_reconciliations_mutation_claim_key"',
    );
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_reconciliations_reviewer_request_key"',
    );
  });

  it("keeps the GET response bounded, discriminated, privacy-safe, and failure-truthful", () => {
    expect(getRoute).toContain('operationKind: "manual"');
    expect(getRoute).toContain('operationKind: "sales_escalation"');
    expect(getRoute).toContain(".limit(101)");
    expect(getRoute).toContain("items: items.slice(0, 100)");
    expect(getRoute).toContain("salesEscalationCallCallbackEvents");
    expect(getRoute).not.toContain("agentPhoneE164");
    expect(getRoute).not.toContain("customerPhoneE164");
    expect(panel).toContain("Saving this review never sends or");
    expect(panel).toContain("Worker sales escalation");
  });

  it("registers immutable migration 0088 and a one-time decisive link", () => {
    const journal = JSON.parse(
      source("apps/api/src/db/migrations/meta/_journal.json"),
    ) as { entries: Array<Record<string, unknown>> };
    expect(journal.entries).toContainEqual({
      idx: 85,
      version: "7",
      when: 1788480000000,
      tag: "0088_sales_escalation_call_reconciliation",
      breakpoints: true,
    });
    expect(migration).toContain(
      'CREATE TABLE "sales_escalation_call_reconciliations"',
    );
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_reconciliations_decisive_operation_key"',
    );
    expect(migration).toContain(
      'CREATE TABLE "sales_escalation_call_reconciliation_sid_claims"',
    );
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_reconciliation_sid_claims_operation_leg_key"',
    );
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain(
      "sales_escalation_reconciliation_sid_claim_guard",
    );
    expect(migration).toContain(
      "sales_escalation_reconciliation_no_update_or_delete",
    );
    expect(migration).toContain("sales_escalation_reconciliations_no_truncate");
    expect(migration).toContain(
      "sales_escalation_operation_resolution_scope_invalid",
    );
    expect(migration).toContain("operator_confirmed_not_dispatched");
    expect(migration).toContain("operator_confirmed_connected");
  });

  it("wires the existing panel to an exact, versioned human action", () => {
    const actionSource = action.slice(
      action.indexOf(
        "export async function reconcileSalesEscalationCallAction",
      ),
      action.indexOf("export async function openContactThreadAction"),
    );
    expect(actionSource).toContain(
      'hasTeamPermission(principal, "calls.reconcile")',
    );
    expect(actionSource).toContain('"If-Match": expectedVersion');
    expect(actionSource).toContain('"Idempotency-Key": resolvedIdempotencyKey');
    expect(actionSource).toContain("callAdminMutationWithSafeReplay");
    expect(actionSource).toContain(
      'buildCallReconciliationScope(\n        "sales_escalation"',
    );
    expect(actionSource).toContain(
      "isSalesEscalationCallReconciliationSuccess(payload",
    );
    expect(panel).toContain("reconcileSalesEscalationCallAction");
    expect(panel).toContain('name="providerCustomerOperationId"');
    expect(panel).toContain('name="connectedDurationSec"');
    expect(panel).toContain("buildCallReconciliationScope(");
    expect(panel).not.toContain("randomUUID()");
  });
});

describe("sales escalation reconciliation response validation", () => {
  const validEnvelope = {
    ok: true,
    data: {
      reconciliationId,
      salesEscalationOperationId: operationId,
      operationState: "reconciliation_required",
      outcome: "confirmed_connected",
      evidenceType: "provider_call_record",
      providerEvidenceSource: "operator_supplied",
      originalProviderOutcomePreserved: true,
      providerReplayAttempted: false,
      contactCallBlockCleared: true,
      taskEffect: "completed",
      callRecordId,
      operationVersion: 8,
    },
    receipt: {
      operationId: "55555555-5555-4555-8555-555555555555",
      correlationId: "66666666-6666-4666-8666-666666666666",
      actorId: "77777777-7777-4777-8777-777777777777",
      committedAt: "2026-08-09T12:00:00.000Z",
      auditEventId,
      entityType: "sales_escalation_call_operation",
      entityId: operationId,
      version: 8,
      providerOperationId: parentSid,
    },
  };
  const expected = {
    operationId,
    outcome: "confirmed_connected" as const,
    evidenceType: "provider_call_record" as const,
    previousVersion: 7,
    providerOperationId: parentSid,
  };

  it("accepts only the exact committed outcome, version, actor/audit receipt, and SID", () => {
    expect(
      isSalesEscalationCallReconciliationSuccess(validEnvelope, expected),
    ).toBe(true);
    for (const corrupt of [
      {
        ...validEnvelope,
        data: { ...validEnvelope.data, operationVersion: 7 },
      },
      {
        ...validEnvelope,
        data: { ...validEnvelope.data, providerReplayAttempted: true },
      },
      {
        ...validEnvelope,
        receipt: { ...validEnvelope.receipt, auditEventId: null },
      },
      {
        ...validEnvelope,
        receipt: {
          ...validEnvelope.receipt,
          providerOperationId: `CA${"c".repeat(32)}`,
        },
      },
    ]) {
      expect(
        isSalesEscalationCallReconciliationSuccess(corrupt, expected),
      ).toBe(false);
    }
  });
});
