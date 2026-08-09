import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifySalesEscalationAgentStatusOutcome,
  classifySalesEscalationCallbackDeadline,
  classifySalesEscalationDialOutcome,
  classifySalesEscalationProviderResult,
  MAX_SALES_ESCALATION_CALL_ATTEMPTS,
  salesEscalationCustomerPhoneMatchesSnapshot,
} from "@/lib/sales-escalation-call-operations";
import type { TwilioOutboundCallResult } from "@/lib/twilio-calls";

const REPO_ROOT = resolve(process.cwd(), "../..");
const callSid = `CA${"a".repeat(32)}`;

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function providerFailure(input: {
  certainty: "not_sent" | "uncertain";
  status: number;
  retryable: boolean;
}): TwilioOutboundCallResult {
  return {
    ok: false,
    callSid: null,
    provider: "twilio",
    deliveryCertainty: input.certainty,
    providerIdempotencySupported: false,
    retryable: input.retryable,
    detail: `twilio_call_failed:${input.status}`,
    status: input.status,
  };
}

describe("durable sales escalation calls", () => {
  it("maps provider certainty without ever redialing an uncertain attempt", () => {
    expect(MAX_SALES_ESCALATION_CALL_ATTEMPTS).toBe(3);
    expect(
      classifySalesEscalationProviderResult({
        ok: true,
        callSid,
        provider: "twilio",
        deliveryCertainty: "accepted",
        providerIdempotencySupported: false,
        retryable: false,
      }),
    ).toMatchObject({
      state: "succeeded",
      certainty: "accepted",
      providerOperationId: callSid,
      retryable: false,
    });
    expect(
      classifySalesEscalationProviderResult(
        providerFailure({
          certainty: "uncertain",
          status: 503,
          retryable: true,
        }),
      ),
    ).toMatchObject({
      state: "reconciliation_required",
      certainty: "uncertain",
      retryable: false,
    });
    expect(
      classifySalesEscalationProviderResult(
        providerFailure({
          certainty: "not_sent",
          status: 429,
          retryable: true,
        }),
      ),
    ).toMatchObject({
      state: "failed",
      certainty: "not_sent",
      retryable: true,
    });
  });

  it("requires positive, bridged customer-leg evidence for connection", () => {
    expect(
      classifySalesEscalationDialOutcome({
        status: "completed",
        durationSec: 42,
        bridged: true,
      }),
    ).toEqual({ kind: "connected" });
    expect(
      classifySalesEscalationDialOutcome({
        status: "completed",
        durationSec: 0,
        bridged: false,
      }),
    ).toEqual({ kind: "not_connected", reason: "customer_completed" });
    expect(
      classifySalesEscalationDialOutcome({
        status: "completed",
        durationSec: 42,
        bridged: null,
      }),
    ).toEqual({ kind: "inconsistent", reason: "dial_outcome_inconsistent" });
  });

  it("settles an ended agent leg only when no customer dial was requested", () => {
    expect(
      classifySalesEscalationAgentStatusOutcome({
        status: "no-answer",
        customerDialRequested: false,
      }),
    ).toEqual({ kind: "not_connected", reason: "agent_no_answer" });
    expect(
      classifySalesEscalationAgentStatusOutcome({
        status: "completed",
        customerDialRequested: false,
      }),
    ).toEqual({ kind: "not_connected", reason: "agent_completed" });
    expect(
      classifySalesEscalationAgentStatusOutcome({
        status: "completed",
        customerDialRequested: true,
      }),
    ).toEqual({ kind: "pending" });
    expect(
      classifySalesEscalationAgentStatusOutcome({
        status: "ringing",
        customerDialRequested: false,
      }),
    ).toEqual({ kind: "pending" });
  });

  it("never changes or reuses a stale customer dial target", () => {
    expect(
      salesEscalationCustomerPhoneMatchesSnapshot({
        phoneE164: null,
        phone: "+1 (555) 555-0199",
        snapshottedPhoneE164: "+15555550199",
      }),
    ).toBe(true);
    for (const current of [
      { phoneE164: null, phone: null },
      { phoneE164: null, phone: "not-a-phone" },
      { phoneE164: "+15555550198", phone: "+1 (555) 555-0199" },
    ]) {
      expect(
        salesEscalationCustomerPhoneMatchesSnapshot({
          ...current,
          snapshottedPhoneE164: "+15555550199",
        }),
      ).toBe(false);
    }
  });

  it("requires a terminal callback or explicit deadline reconciliation", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    expect(
      classifySalesEscalationCallbackDeadline({
        callbackDeadlineAt: new Date("2026-08-15T16:00:00.000Z"),
        terminalAt: new Date("2026-08-15T12:01:00.000Z"),
        now,
      }),
    ).toBe("terminal");
    expect(
      classifySalesEscalationCallbackDeadline({
        callbackDeadlineAt: new Date("2026-08-15T16:00:00.000Z"),
        terminalAt: null,
        now,
      }),
    ).toBe("pending");
    for (const callbackDeadlineAt of [
      null,
      new Date("2026-08-15T12:00:00.000Z"),
      new Date("2026-08-15T11:59:59.999Z"),
    ]) {
      expect(
        classifySalesEscalationCallbackDeadline({
          callbackDeadlineAt,
          terminalAt: null,
          now,
        }),
      ).toBe("expired");
    }
  });

  it("dispatches through the durable ledger and completes tasks only in the dial transaction", () => {
    const outbox = source("apps/api/src/lib/outbox-processor.ts");
    const operations = source(
      "apps/api/src/lib/sales-escalation-call-operations.ts",
    );
    const branch = outbox.slice(
      outbox.indexOf('case "sales.escalation.call"'),
      outbox.indexOf('case "sales.queue.nudge.sms"'),
    );
    expect(branch.indexOf("resumeSalesEscalationCallAttempt({")).toBeLessThan(
      branch.indexOf("if (!SALES_ESCALATION_CALL_ENABLED)"),
    );
    expect(branch.indexOf("resumeSalesEscalationCallAttempt({")).toBeLessThan(
      branch.indexOf('getTeamOperationKillSwitch(["calls.place"])'),
    );
    expect(branch.indexOf("resumeSalesEscalationCallAttempt({")).toBeLessThan(
      branch.indexOf("const [row] = await db"),
    );
    expect(branch.indexOf("getTeamOperationKillSwitch")).toBeLessThan(
      branch.indexOf("prepareSalesEscalationCallAttempt({"),
    );
    expect(branch.indexOf("prepareSalesEscalationCallAttempt({")).toBeLessThan(
      branch.indexOf("createTwilioOutboundCall({"),
    );
    expect(branch.indexOf("createTwilioOutboundCall({")).toBeLessThan(
      branch.indexOf("finalizeSalesEscalationCallAttempt({"),
    );
    expect(branch).toContain("reconcileSalesEscalationAfterStorageFailure({");
    expect(branch).toContain(
      'error: "sales_escalation_result_storage_failed",\n          skipFinalization: true',
    );
    expect(branch).toContain(
      'finalized.state === "failed" && finalized.retryable',
    );
    expect(branch).toContain("if (prepared.retryAt)");
    expect(branch).toContain(
      'finalized.state === "succeeded" && finalized.retryAt',
    );
    expect(branch).toContain('error: "sales_escalation_callback_pending"');
    expect(outbox).toContain('event.type === "sales.escalation.call" ||');
    expect(operations).toContain("handleSalesEscalationDialActionCallback");
    expect(operations).toContain(
      "eq(crmTasks.updatedAt, operation.taskUpdatedAt)",
    );
    expect(operations).toContain("ensureEscalationCallRecord(tx");
    expect(operations).toContain('state: "reconciliation_required"');
    expect(operations).toContain("inserted &&");
    expect(operations).toContain("contacts.phoneE164");
    expect(operations).toContain(
      "salesEscalationCustomerPhoneMatchesSnapshot({",
    );
    expect(operations).toContain('outcomeReason: customerDialPrevented');
    expect(operations).toContain('terminalOutcome: customerDialPrevented');
    expect(operations).toContain('guardReleasedAt: customerDialPrevented');
    expect(operations).toContain(
      "eq(salesEscalationCallOperations.providerRequestKey, operationKey)",
    );
    const prepare = operations.slice(
      operations.indexOf(
        "export async function prepareSalesEscalationCallAttempt",
      ),
      operations.indexOf(
        "export async function finalizeSalesEscalationCallAttempt",
      ),
    );
    expect(prepare).toContain("contact.doNotContact");
    expect(prepare).toContain("teamMembers.phoneE164");
    expect(prepare).toContain("sales_escalation_task:${input.taskId}");
    expect(operations).toContain("sales_escalation_dispatch_in_flight");
    expect(operations).toContain("terminal_callback_missing");
    expect(operations).toContain("markMissingTerminalCallback(");
    expect(operations).toContain(
      "export async function resumeSalesEscalationCallAttempt",
    );
    expect(operations).toContain("sales_escalation_callback_pending");
    expect(prepare).toContain(
      "eq(salesEscalationCallOperations.taskId, input.taskId)",
    );
    expect(prepare.indexOf("contact.doNotContact")).toBeLessThan(
      prepare.indexOf('.set({\n        state: "dispatched"'),
    );
  });

  it("registers migration 0083 with immutable callback evidence and bounded attempts", () => {
    const migration = source(
      "apps/api/src/db/migrations/0083_sales_escalation_call_operations.sql",
    );
    const journal = JSON.parse(
      source("apps/api/src/db/migrations/meta/_journal.json"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        idx: 80,
        tag: "0083_sales_escalation_call_operations",
      }),
    );
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_operations_unresolved_event_key"',
    );
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_operations_task_attempt_key"',
    );
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_operations_unresolved_task_key"',
    );
    expect(migration).toContain(
      'UNIQUE INDEX "sales_escalation_call_operations_provider_crossed_task_key"',
    );
    expect(migration).toContain(
      '"attempt_number" >= 1 AND "attempt_number" <= 3',
    );
    expect(migration).toContain("sales_escalation_evidence_append_only");
    expect(migration).toContain(
      "sales_escalation_operation_terminal_immutable",
    );
    expect(migration).toContain("'succeeded', 'reconciliation_required'");
  });

  it("keeps modern URLs opaque and legacy compatibility bound to exact accepted SIDs", () => {
    const connect = source("apps/api/app/api/webhooks/twilio/connect/route.ts");
    const callStatus = source(
      "apps/api/app/api/webhooks/twilio/call-status/route.ts",
    );
    const dialAction = source(
      "apps/api/app/api/webhooks/twilio/dial-action/route.ts",
    );
    const operations = source(
      "apps/api/src/lib/sales-escalation-call-operations.ts",
    );
    expect(connect).toContain("if (context.requestKey)");
    expect(connect).toContain(
      'searchParams.set("requestKey", context.requestKey)',
    );
    expect(connect).toContain("} else if (context.taskId) {");
    expect(callStatus).toContain("adoptLegacySalesEscalationCallback({");
    expect(dialAction).toContain("adoptLegacySalesEscalationCallback({");
    expect(operations).toContain(
      "export async function adoptLegacySalesEscalationCallback",
    );
    expect(operations).toContain(
      "eq(auditLogs.providerOperationId, providerCallSid)",
    );
    expect(operations).toContain("isNull(auditLogs.providerOperationId)");
    expect(operations).toContain("providerCallSids.includes(providerCallSid)");
    expect(operations).not.toContain('payload?.["taskId"]');
  });
});
