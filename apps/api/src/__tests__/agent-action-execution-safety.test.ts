import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_ACTION_PERMISSIONS,
  parseAgentActionApprovalProof,
  parseAgentActionPayload,
  parseAgentOperationalMutationResult,
} from "@myst-os/sdk";
import {
  AGENT_AUTHORITATIVE_OPERATION_ACTIONS,
  buildAgentAuthoritativeOperationBinding,
  canBindAgentReservationFinalization,
  verifyAgentAuthoritativeOperationEvidence,
} from "@/lib/agent-action-authority";
import { parseAgentActionMutationSuccess } from "../../../site/src/app/team/lib/agent-action-mutation";

const source = (path: string): string =>
  readFileSync(join(process.cwd(), path), "utf8");

const siteActionRoute = source("../site/src/app/api/chat/actions/route.ts");
const siteApprovalRoute = source(
  "../site/src/app/api/chat/action-approvals/route.ts",
);
const siteBookingAlias = source("../site/src/app/api/chat/book/route.ts");
const availability = source(
  "../site/src/app/team/lib/agent-action-availability.ts",
);
const agentClient = source(
  "../site/src/app/team/components/TeamChatClient.tsx",
);
const agentProposalRoute = source("../site/src/app/api/chat/route.ts");
const apiApprovalRoute = source(
  "app/api/admin/agent/action-approvals/route.ts",
);
const apiExecutionRoute = source(
  "app/api/admin/agent/action-executions/route.ts",
);
const apiBookingRoute = source("app/api/admin/booking/book/route.ts");

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const ENTITY_ID = "33333333-3333-4333-8333-333333333333";
const THREAD_ID = "77777777-7777-4777-8777-777777777777";
const VERSION = "2026-08-09T12:00:00.000Z";
const NEXT_VERSION = "2026-08-09T12:00:01.000Z";
const OLD_VERSION = "2026-08-09T11:59:59.000Z";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "44444444-4444-4444-8444-444444444444",
    correlationId: "55555555-5555-4555-8555-555555555555",
    actorId: ACTOR_ID,
    committedAt: NEXT_VERSION,
    auditEventId: "66666666-6666-4666-8666-666666666666",
    entityType: "appointment",
    entityId: ENTITY_ID,
    version: NEXT_VERSION,
    ...overrides,
  };
}

function operationalEnvelope(
  data: Record<string, unknown>,
  receiptOverrides: Record<string, unknown> = {},
) {
  return { ok: true, data, receipt: receipt(receiptOverrides) };
}

function finalEnvelope(
  actionType: "cancel_appointment" | "send_text",
  result: Record<string, unknown>,
  receiptOverrides: Record<string, unknown> = {},
) {
  return {
    ok: true,
    data: { actionType, result },
    receipt: receipt(receiptOverrides),
  };
}

describe("Agent action execution safety", () => {
  it("accepts only exact action payload schemas and bounded values", () => {
    expect(
      parseAgentActionPayload("cancel_appointment", {
        appointmentId: ENTITY_ID,
        expectedVersion: VERSION,
      }),
    ).toEqual({
      ok: true,
      payload: { appointmentId: ENTITY_ID, expectedVersion: VERSION },
    });
    expect(
      parseAgentActionPayload("cancel_appointment", {
        appointmentId: ENTITY_ID,
        expectedVersion: VERSION,
        admin: true,
      }).ok,
    ).toBe(false);
    expect(
      parseAgentActionPayload("send_text", {
        contactId: ENTITY_ID,
        body: "x".repeat(1_601),
        channel: "sms",
      }).ok,
    ).toBe(false);
    expect(
      parseAgentActionPayload("book_appointment", {
        contactId: ENTITY_ID,
        startAt: NEXT_VERSION,
        durationMinutes: 721,
        quotedTotalCents: 100_000_001,
      }).ok,
    ).toBe(false);
    expect(
      parseAgentActionPayload("google_ads_recommendations_bulk_apply", {
        items: Array.from({ length: 21 }, (_, index) => ({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
          expectedVersion: VERSION,
        })),
        confirmation: "apply_google_ads_changes",
      }).ok,
    ).toBe(false);
    expect(
      parseAgentActionPayload("google_ads_recommendations_bulk_update", {
        items: [{ id: ENTITY_ID, expectedVersion: VERSION }],
        status: "approved",
        confirmation: "approve",
      }),
    ).toEqual({
      ok: true,
      payload: {
        items: [{ id: ENTITY_ID, expectedVersion: VERSION }],
        status: "approved",
        confirmation: "approve",
      },
    });
    expect(
      parseAgentActionPayload("google_ads_recommendations_bulk_update", {
        items: [{ id: ENTITY_ID, expectedVersion: VERSION, force: true }],
        status: "approved",
        confirmation: "approve",
      }).ok,
    ).toBe(false);
    expect(
      parseAgentActionPayload("google_ads_recommendations_bulk_update", {
        items: [{ id: ENTITY_ID, expectedVersion: VERSION }],
        status: "approved",
        confirmation: "ignore",
      }).ok,
    ).toBe(false);
  });

  it("rejects forged approval proof shapes", () => {
    expect(
      parseAgentActionApprovalProof({
        approvalId: ACTION_ID,
        approvalToken: ENTITY_ID,
        expiresAt: NEXT_VERSION,
      }),
    ).toEqual({
      approvalId: ACTION_ID,
      approvalToken: ENTITY_ID,
      expiresAt: NEXT_VERSION,
    });
    expect(
      parseAgentActionApprovalProof({
        approvalId: ACTION_ID,
        approvalToken: ENTITY_ID,
        expiresAt: NEXT_VERSION,
        approved: true,
      }),
    ).toBeNull();
    expect(
      parseAgentActionApprovalProof({
        approvalId: ACTION_ID,
        approvalToken: "client-asserted",
        expiresAt: NEXT_VERSION,
      }),
    ).toBeNull();
  });

  it("requires an upstream actor/entity/version receipt and rejects bare 2xx", () => {
    const data = { appointmentId: ENTITY_ID, version: NEXT_VERSION };
    expect(
      parseAgentOperationalMutationResult(
        "cancel_appointment",
        operationalEnvelope(data),
        {
          actorId: ACTOR_ID,
          targetEntityId: ENTITY_ID,
          expectedVersion: VERSION,
        },
      ),
    ).toMatchObject({ ok: true, descriptor: { entityId: ENTITY_ID } });
    expect(
      parseAgentOperationalMutationResult(
        "cancel_appointment",
        { ok: true, appointmentId: ENTITY_ID, version: NEXT_VERSION },
        { actorId: ACTOR_ID },
      ),
    ).toBeNull();
    expect(
      parseAgentOperationalMutationResult(
        "cancel_appointment",
        operationalEnvelope(data, { actorId: ACTION_ID }),
        { actorId: ACTOR_ID },
      ),
    ).toBeNull();
    expect(
      parseAgentOperationalMutationResult(
        "cancel_appointment",
        operationalEnvelope(data, { entityId: ACTION_ID }),
        { actorId: ACTOR_ID },
      ),
    ).toBeNull();
    expect(
      parseAgentOperationalMutationResult(
        "cancel_appointment",
        operationalEnvelope(
          { appointmentId: ENTITY_ID, version: OLD_VERSION },
          { version: OLD_VERSION },
        ),
        { actorId: ACTOR_ID, expectedVersion: VERSION },
      ),
    ).toBeNull();
    const withoutAudit = operationalEnvelope(data);
    delete withoutAudit.receipt.auditEventId;
    expect(
      parseAgentOperationalMutationResult("cancel_appointment", withoutAudit, {
        actorId: ACTOR_ID,
      }),
    ).toBeNull();
  });

  it("accepts final success only when exact idempotency and audit evidence match", () => {
    const payload = {
      items: [{ id: ENTITY_ID, expectedVersion: VERSION }],
      status: "approved" as const,
      confirmation: "approve" as const,
    };
    const binding = buildAgentAuthoritativeOperationBinding(
      "google_ads_recommendations_bulk_update",
      payload,
      `${ACTION_ID}:execute`,
    );
    expect(binding).not.toBeNull();
    if (!binding) return;
    const raw = operationalEnvelope(
      {
        status: "approved",
        updated: 1,
        items: [{ id: ENTITY_ID, version: NEXT_VERSION }],
      },
      {
        entityType: "google_ads_analyst_recommendation_batch",
        entityId: ACTION_ID,
      },
    );
    const upstream = parseAgentOperationalMutationResult(
      "google_ads_recommendations_bulk_update",
      raw,
      { actorId: ACTOR_ID },
    );
    expect(upstream?.ok).toBe(true);
    if (!upstream) return;
    const idempotency = {
      operationId: raw.receipt.operationId,
      action:
        AGENT_AUTHORITATIVE_OPERATION_ACTIONS.google_ads_recommendations_bulk_update,
      keyHash: binding.keyHash,
      scopeHash: binding.scopeHash,
      requestHash: binding.requestHash,
      status: "succeeded",
      correlationId: raw.receipt.correlationId,
      responseStatus: 200,
      responseBody: raw,
    };
    const audit = {
      id: raw.receipt.auditEventId,
      actorId: ACTOR_ID,
      sessionId: ACTION_ID,
      authMethod: "team_session",
      correlationId: raw.receipt.correlationId,
      requiredPermissions: ["marketing.write"],
      outcome: "succeeded",
      providerOperationId: null,
      idempotencyKeyHash: binding.keyHash,
      action: idempotency.action,
      entityType: raw.receipt.entityType,
      entityId: raw.receipt.entityId,
      createdAt: new Date(raw.receipt.committedAt),
    };
    const evidence = {
      actionType: "google_ads_recommendations_bulk_update" as const,
      actorId: ACTOR_ID,
      sessionId: ACTION_ID,
      authMethod: "team_session",
      correlationId: raw.receipt.correlationId,
      upstreamStatus: 200,
      upstreamRaw: raw,
      upstream,
      binding,
      idempotency,
      audit,
    };
    expect(verifyAgentAuthoritativeOperationEvidence(evidence)).toEqual({
      ok: true,
    });
    expect(
      verifyAgentAuthoritativeOperationEvidence({
        ...evidence,
        upstreamRaw: {
          ...raw,
          data: { ...raw.data, updated: 999 },
        },
      }),
    ).toEqual({ ok: false, reason: "idempotency_evidence_mismatch" });
    expect(
      verifyAgentAuthoritativeOperationEvidence({
        ...evidence,
        audit: { ...audit, sessionId: ENTITY_ID },
      }),
    ).toEqual({ ok: false, reason: "audit_evidence_mismatch" });
  });

  it("requires queued-message identity and creation version evidence", () => {
    const data = {
      threadId: THREAD_ID,
      message: {
        id: ENTITY_ID,
        threadId: THREAD_ID,
        deliveryStatus: "queued",
        createdAt: NEXT_VERSION,
      },
    };
    expect(
      parseAgentOperationalMutationResult(
        "send_text",
        operationalEnvelope(data, {
          entityType: "conversation_message",
          version: NEXT_VERSION,
        }),
        { actorId: ACTOR_ID },
      ),
    ).toMatchObject({ ok: true, descriptor: { entityId: ENTITY_ID } });
    expect(
      parseAgentOperationalMutationResult(
        "send_text",
        operationalEnvelope(
          {
            ...data,
            message: { ...data.message, deliveryStatus: "failed" },
          },
          { entityType: "conversation_message" },
        ),
        { actorId: ACTOR_ID },
      ),
    ).toBeNull();
  });

  it("accepts only a strict final action receipt", () => {
    const result = { appointmentId: ENTITY_ID, version: NEXT_VERSION };
    expect(
      parseAgentActionMutationSuccess(
        finalEnvelope("cancel_appointment", result),
        {
          actionType: "cancel_appointment",
          actorId: ACTOR_ID,
          targetEntityId: ENTITY_ID,
          expectedVersion: VERSION,
        },
      ),
    ).not.toBeNull();
    expect(
      parseAgentActionMutationSuccess(
        { ...finalEnvelope("cancel_appointment", result), debug: true },
        {
          actionType: "cancel_appointment",
          actorId: ACTOR_ID,
          targetEntityId: ENTITY_ID,
          expectedVersion: VERSION,
        },
      ),
    ).toBeNull();
  });

  it("issues a durable short-lived proof bound to actor, session, payload, and version", () => {
    const boundary = apiApprovalRoute.indexOf("beginTeamMutation(request");
    const bodyRead = apiApprovalRoute.indexOf("readBoundedJsonRequest(request");
    expect(boundary).toBeGreaterThan(-1);
    expect(boundary).toBeLessThan(bodyRead);
    expect(apiApprovalRoute).toContain("APPROVAL_LIFETIME_MS = 5 * 60 * 1_000");
    expect(apiApprovalRoute).toContain("hashAgentActionPayload(");
    expect(apiApprovalRoute).toContain("payloadHash: hash, sessionId");
    expect(apiApprovalRoute).toContain("stored.sessionId !== sessionId");
    expect(apiApprovalRoute).toContain("stored.payloadHash !== hash");
    expect(apiApprovalRoute).toContain(
      "stored.expectedVersion !== expectedVersion",
    );
    expect(apiApprovalRoute).toContain(
      "Date.parse(stored.expiresAt) <= Date.now()",
    );
    expect(apiApprovalRoute).toContain("completeTeamMutationIdempotency(");
  });

  it("consumes proof once and rejects forged, expired, wrong-session, and wrong-payload proof", () => {
    expect(apiExecutionRoute).toContain("storedApproval.approvalToken !==");
    expect(apiExecutionRoute).toContain(
      "storedApproval.sessionId !== sessionId",
    );
    expect(apiExecutionRoute).toContain("storedApproval.payloadHash !== hash");
    expect(apiExecutionRoute).toContain(
      "storedApproval.expectedVersion !== expectedVersion",
    );
    expect(apiExecutionRoute).toContain(
      "Date.parse(storedApproval.expiresAt) <= Date.now()",
    );
    expect(apiExecutionRoute).toContain("consumedByReservationId");
    expect(apiExecutionRoute).toContain("This approval was already consumed");
  });

  it("scopes every reservation and finalized replay to actor/session/action/token", () => {
    expect(apiExecutionRoute).toContain("assertReservationScope(reservation");
    expect(apiExecutionRoute).toContain(
      "reservation.actorId !== expected.actorId",
    );
    expect(apiExecutionRoute).toContain(
      "reservation.sessionId !== expected.sessionId",
    );
    expect(apiExecutionRoute).toContain(
      "reservation.actionType !== expected.actionType",
    );
    expect(apiExecutionRoute).toContain("reservation.reservationToken !==");
    expect(apiExecutionRoute).toContain(
      "reservation.correlationId !== expected.correlationId",
    );
    expect(apiExecutionRoute).toContain("reservationTokenHash:");
    expect(apiExecutionRoute).toContain("sessionId,");
    expect(apiExecutionRoute).toContain("upstreamHash,");
    expect(apiExecutionRoute).toContain('finalClaim.kind === "replay"');
    expect(apiExecutionRoute).toContain("finalizationId:");
    expect(apiExecutionRoute).toContain("canBindAgentReservationFinalization(");
    expect(apiExecutionRoute).toContain('.for("update")');
    expect(apiExecutionRoute).toContain(
      "already bound to a different finalization",
    );
  });

  it("allows one reservation finalization and rejects an alternate finalize key", () => {
    const empty = {
      finalizationId: null,
      upstreamOperationId: null,
      upstreamHash: null,
    };
    const first = {
      finalizationId: ACTION_ID,
      upstreamOperationId: ENTITY_ID,
      upstreamHash: "a".repeat(64),
    };
    expect(canBindAgentReservationFinalization(empty, first)).toBe(true);
    expect(canBindAgentReservationFinalization(first, first)).toBe(true);
    expect(
      canBindAgentReservationFinalization(first, {
        ...first,
        finalizationId: THREAD_ID,
      }),
    ).toBe(false);
    expect(
      canBindAgentReservationFinalization(first, {
        ...first,
        upstreamOperationId: THREAD_ID,
      }),
    ).toBe(false);
  });

  it("validates the exact authoritative operation row and audit before final audit success", () => {
    expect(apiExecutionRoute).toContain(
      "verifyAgentAuthoritativeOperationEvidence({",
    );
    expect(apiExecutionRoute).toContain("teamMutationIdempotency.operationId");
    expect(apiExecutionRoute).toContain("upstream.receipt.operationId");
    expect(apiExecutionRoute).toContain(
      "eq(auditLogs.id, upstream.receipt.auditEventId)",
    );
    const authorityIndex = apiExecutionRoute.indexOf("const authority =");
    const finalAuditIndex = apiExecutionRoute.indexOf(
      "mutation.audit.insertSuccess(tx",
      authorityIndex,
    );
    expect(authorityIndex).toBeGreaterThan(-1);
    expect(finalAuditIndex).toBeGreaterThan(authorityIndex);
  });

  it("recovers a lost finalize response by replaying reservation, sub-operation, and finalize key", () => {
    expect(siteActionRoute).not.toContain(
      "already reserved and its result is not yet confirmed",
    );
    expect(siteActionRoute).toContain("activeReservation = reservation");
    expect(siteActionRoute).toContain(
      "`${reservation.reservation.reservationToken}:${step}`",
    );
    expect(siteActionRoute).toContain(
      '"X-Correlation-Id": activeReservation.correlationId',
    );
    expect(siteActionRoute).toContain("reservation.reservation.correlationId");
    expect(siteActionRoute).toContain("`${idempotencyKey}:finalize`");
    expect(agentClient).toContain("previousKey?.fingerprint === fingerprint");
    expect(agentClient).toContain(
      "previousApproval?.fingerprint === fingerprint",
    );
    expect(agentClient).toContain("approval: approvalProof");
  });

  it("authenticates before bounded strict parsing and reserves before operational dispatch", () => {
    const principal = siteActionRoute.indexOf(
      "requireTeamRequestPrincipal(request",
    );
    const boundedRead = siteActionRoute.indexOf("readBoundedRequestBytes(");
    const reserve = siteActionRoute.indexOf('phase: "reserve"');
    const operational = siteActionRoute.indexOf(
      "const response = await callAdminApiAs(auth.principal, path",
    );
    expect(principal).toBeGreaterThan(-1);
    expect(principal).toBeLessThan(boundedRead);
    expect(siteActionRoute).toContain(
      "Object.keys(typedCandidate).length !== 4",
    );
    expect(siteActionRoute).toContain("parseAgentActionPayload(");
    expect(siteActionRoute).toContain("parseAgentActionApprovalProof(");
    expect(siteActionRoute).toContain("parseAgentOperationalMutationResult(");
    expect(siteActionRoute).toContain("bare or malformed 2xx");
    expect(reserve).toBeGreaterThan(boundedRead);
    expect(reserve).toBeLessThan(operational);
  });

  it("makes proof issuance an explicit click-time server round trip", () => {
    expect(agentClient).toContain('fetch("/api/chat/action-approvals"');
    expect(agentClient).toContain(
      "readApprovalProof(approvalCandidate, actorId)",
    );
    expect(agentClient).toContain(
      '"X-Agent-Approval-Id": approvalProof.approvalId',
    );
    expect(agentClient).toContain("actionId: action.id");
    expect(agentClient).not.toContain("approved: true");
    expect(siteApprovalRoute).toContain("parseAgentActionApprovalProof(");
    expect(siteApprovalRoute).toContain(
      'data["sessionId"] !== auth.principal.sessionId',
    );
  });

  it("keeps unsafe legacy operational endpoints explicitly unavailable", () => {
    for (const action of [
      "create_contact",
      "create_quote",
      "create_task",
      "add_contact_note",
      "book_appointment",
      "cancel_appointment",
      "reschedule_appointment",
      "send_text",
    ]) {
      expect(availability).toContain(`${action}:`);
    }
    expect(availability).not.toContain("create_reminder:");
    expect(agentClient).toContain("Temporarily unavailable");
    expect(siteActionRoute).toContain(
      "agentActionTemporaryBlocker(payload.type)",
    );
    expect(
      siteActionRoute.indexOf("agentActionTemporaryBlocker(payload.type)"),
    ).toBeLessThan(siteActionRoute.indexOf('phase: "reserve"'));
  });

  it("blocks cancellation's hidden customer send without external-send permission", () => {
    expect(AGENT_ACTION_PERMISSIONS.cancel_appointment).toEqual([
      "appointments.update",
      "messages.send",
    ]);
    const granted = new Set(["appointments.update"]);
    expect(
      AGENT_ACTION_PERMISSIONS.cancel_appointment.filter(
        (permission) => !granted.has(permission),
      ),
    ).toEqual(["messages.send"]);
    expect(availability).toContain("cancel_appointment:");
    expect(availability).toContain("optional customer notice");
    expect(availability).toContain("permission-checked effects");
    expect(agentClient).toContain(
      "Appointment update and external-send access",
    );
  });

  it("proposes versioned, explicitly confirmed Google Ads operations", () => {
    expect(agentProposalRoute).toContain("expectedVersion: string;");
    expect(agentProposalRoute).toContain(
      'confirmation: "apply_google_ads_changes"',
    );
    expect(agentProposalRoute).toContain("if (needsApprove.length)");
    expect(agentProposalRoute).toContain("return actions;");
    expect(siteActionRoute).toContain("body: JSON.stringify(body)");
  });

  it("carries current appointment versions into approval and undo", () => {
    expect(agentProposalRoute).toContain("updatedAt: string;");
    expect(agentProposalRoute).toContain("expectedVersion: only.updatedAt");
    expect(agentProposalRoute).toContain(
      "expectedVersion: appts[0]!.updatedAt",
    );
    expect(agentClient).toContain(
      'payload["expectedVersion"] = pickedAppointment.updatedAt',
    );
    expect(agentClient).toContain("expectedVersion: lastBooked.version");
    expect(apiBookingRoute).toContain("version: result.version");
  });

  it("keeps the old booking endpoint behind the checked compatibility boundary", () => {
    const auth = siteBookingAlias.indexOf(
      "requireTeamRequestPrincipal(request",
    );
    const execution = siteBookingAlias.indexOf(
      "executeApprovedAgentAction(request)",
    );
    expect(auth).toBeGreaterThan(-1);
    expect(execution).toBeGreaterThan(auth);
    expect(siteBookingAlias).not.toContain("callAdminApiAs");
  });
});
