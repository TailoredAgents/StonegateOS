import fs from "node:fs";
import path from "node:path";
import { TEAM_PERMISSION_CATALOG } from "@myst-os/sdk";
import {
  contactPurgeEligibleAt,
  evaluateContactPurgeEligibility,
  planContactRestore,
  planContactSoftDelete,
} from "@/lib/contact-retention";
import {
  planContactScopedOutboxReconciliation,
  planOutboxOutcomeFinalization,
} from "@/lib/outbox-finalization";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("contact soft-delete lifecycle", () => {
  const deletedAt = new Date("2026-08-15T12:00:00.000Z");
  const recoveryUntil = new Date("2026-09-14T12:00:00.000Z");

  it("creates a 30-day recovery window for a first delete", () => {
    const plan = planContactSoftDelete(
      { deletedAt: null, purgeEligibleAt: null },
      deletedAt,
    );

    expect(plan).toEqual({
      kind: "delete",
      deletedAt,
      purgeEligibleAt: recoveryUntil,
    });
    expect(contactPurgeEligibleAt(deletedAt)).toEqual(recoveryUntil);
  });

  it("makes repeated deletion idempotent without changing retention dates", () => {
    const contact = { deletedAt, purgeEligibleAt: recoveryUntil };

    expect(
      planContactSoftDelete(
        contact,
        new Date("2026-08-16T12:00:00.000Z"),
      ),
    ).toEqual({
      kind: "already_deleted",
      deletedAt,
      purgeEligibleAt: recoveryUntil,
    });
    expect(
      planContactSoftDelete(
        contact,
        new Date("2026-08-20T12:00:00.000Z"),
      ),
    ).toEqual({
      kind: "already_deleted",
      deletedAt,
      purgeEligibleAt: recoveryUntil,
    });
  });

  it("makes restore idempotent while retaining the original deletion evidence", () => {
    const restoredAt = new Date("2026-08-16T10:00:00.000Z");
    expect(planContactRestore({ deletedAt }, restoredAt)).toEqual({
      kind: "restore",
      restoredAt,
      previousDeletedAt: deletedAt,
    });
    expect(planContactRestore({ deletedAt: null }, restoredAt)).toEqual({
      kind: "already_active",
    });
  });

  it("only advances to dependency review after the recovery window", () => {
    expect(
      evaluateContactPurgeEligibility(
        { deletedAt: null, purgeEligibleAt: null },
        deletedAt,
      ),
    ).toEqual({ eligible: false, reason: "not_deleted", reviewAt: null });
    expect(
      evaluateContactPurgeEligibility(
        { deletedAt, purgeEligibleAt: recoveryUntil },
        new Date("2026-08-20T12:00:00.000Z"),
      ),
    ).toEqual({
      eligible: false,
      reason: "recovery_window_active",
      reviewAt: recoveryUntil.toISOString(),
    });
    expect(
      evaluateContactPurgeEligibility(
        { deletedAt, purgeEligibleAt: recoveryUntil },
        recoveryUntil,
      ),
    ).toEqual({
      eligible: true,
      reason: "recovery_window_elapsed",
      reviewAt: recoveryUntil.toISOString(),
    });
  });
});

describe("contact-scoped outbox finalization", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");

  it("keeps retry outcomes pending with the expected backoff", () => {
    expect(
      planOutboxOutcomeFinalization(
        { attempts: 0 },
        { status: "retry", error: "provider_timeout" },
        now,
      ),
    ).toEqual({
      attempts: 1,
      nextAttemptAt: new Date("2026-08-15T12:01:00.000Z"),
      lastError: "provider_timeout",
    });
  });

  it("records a terminal outcome before releasing the contact lock", () => {
    expect(
      planOutboxOutcomeFinalization(
        { attempts: 1 },
        { status: "processed" },
        now,
      ),
    ).toEqual({
      attempts: 2,
      processedAt: now,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it("quarantines uncertain provider effects instead of retrying them", () => {
    expect(
      planContactScopedOutboxReconciliation(
        { attempts: 2 },
        "037cfdb8-e3af-40a1-bf96-d487cab3eb91",
        now,
      ),
    ).toEqual({
      attempts: 3,
      nextAttemptAt: null,
      lastError: "outbox_finalization_failed:reconciliation_required",
      quarantinedAt: now,
      quarantinedBy: null,
      quarantineReason: "provider_effect_finalization_uncertain",
      quarantinedContactId: "037cfdb8-e3af-40a1-bf96-d487cab3eb91",
    });
  });
});

describe("contact retention source contracts", () => {
  const deleteRoute = source("app/api/admin/contacts/[contactId]/route.ts");
  const restoreRoute = source(
    "app/api/admin/contacts/[contactId]/restore/route.ts",
  );
  const contactsRoute = source("app/api/admin/contacts/route.ts");
  const pipelineRoute = source("app/api/admin/crm/pipeline/route.ts");
  const omniRoute = source(
    "app/api/admin/contacts/[contactId]/omni/route.ts",
  );
  const omniContext = source("src/lib/omni-lead-context.ts");
  const photoRoute = source(
    "app/api/admin/contacts/[contactId]/instant-quote-photos/route.ts",
  );
  const webPersistence = source("app/api/web/persistence.ts");
  const outboxProcessor = source("src/lib/outbox-processor.ts");
  const outboundSafety = source("src/lib/contact-outbound-safety.ts");
  const directMessageRoute = source(
    "app/api/admin/inbox/threads/[threadId]/messages/route.ts",
  );
  const directThreadRoute = source(
    "app/api/admin/inbox/threads/route.ts",
  );
  const retryMessageRoute = source(
    "app/api/admin/inbox/messages/[messageId]/retry/route.ts",
  );
  const etaAgent = source("src/lib/eta-agent.ts");
  const etaSendRoute = source(
    "app/api/admin/eta/drafts/[draftId]/send/route.ts",
  );
  const quoteSendRoute = source("app/api/quotes/[id]/send/route.ts");
  const systemOutbound = source("src/lib/system-outbound.ts");
  const inbox = source("src/lib/inbox.ts");
  const autoReplies = source("src/lib/auto-replies.ts");

  it("soft-deletes under a row lock and commits its audit in the same transaction", () => {
    expect(deleteRoute).toContain('requiredPermissions: ["contacts.delete"]');
    expect(deleteRoute).toContain('risk: "destructive"');
    expect(deleteRoute).toContain("requiresIdempotency: true");
    expect(deleteRoute).toContain("claimTeamMutationIdempotency(");
    expect(deleteRoute).toContain("teamMutationIdempotencyReplayResponse(");
    expect(deleteRoute).toContain("assertTeamMutationExpectedVersion(");
    expect(deleteRoute).toContain('.for("update")');
    expect(deleteRoute).toContain("planContactSoftDelete(");
    expect(deleteRoute).toContain("existing.updatedAt.getTime() + 1");
    expect(deleteRoute).toContain('deletionPlan.kind === "already_deleted"');
    expect(deleteRoute).toContain(".update(contacts)");
    expect(deleteRoute).toContain("isNull(contacts.deletedAt)");
    expect(deleteRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(deleteRoute).toContain("completeTeamMutationIdempotency(");
    expect(deleteRoute).toContain("settleTeamMutationIdempotencyFailure(");
    expect(deleteRoute).toContain('deletionMode: "soft"');
    expect(deleteRoute).toContain("linkedRecordsPreserved: true");
    expect(deleteRoute).toContain(
      ".from(salesEscalationCallOperations)",
    );
    expect(deleteRoute).toContain(
      "isNull(salesEscalationCallOperations.guardReleasedAt)",
    );
    expect(deleteRoute).toContain(
      "A sales escalation call is still in flight or awaiting reconciliation",
    );
    expect(
      deleteRoute.indexOf("const [unresolvedEscalation]"),
    ).toBeLessThan(deleteRoute.indexOf("const deletionPlan"));
    expect(deleteRoute).toContain(".update(leadAutomationStates)");
    expect(deleteRoute).toContain('followupState: "contact_deleted"');
    expect(deleteRoute).toContain(
      "sql.param(\n            deletedAt,\n            leadAutomationStates.pausedAt,\n          )",
    );
    expect(deleteRoute).toContain("nextFollowupAt: null");
    expect(deleteRoute).toContain(".update(outboxEvents)");
    expect(deleteRoute).toContain('quarantineReason: "contact_soft_deleted"');
    expect(deleteRoute).toContain("outboxQuarantinedCount:");
    expect(deleteRoute).not.toContain(".delete(contacts)");
    expect(deleteRoute).not.toContain(".delete(outboxEvents)");
  });

  it("restores only through the dedicated permission and transactional audit", () => {
    expect(TEAM_PERMISSION_CATALOG).toContain("contacts.restore");
    expect(restoreRoute).toContain('requiredPermissions: ["contacts.restore"]');
    expect(restoreRoute).toContain('risk: "destructive"');
    expect(restoreRoute).toContain("requiresIdempotency: true");
    expect(restoreRoute).toContain("claimTeamMutationIdempotency(");
    expect(restoreRoute).toContain("teamMutationIdempotencyReplayResponse(");
    expect(restoreRoute).toContain("assertTeamMutationExpectedVersion(");
    expect(restoreRoute).toContain('.for("update")');
    expect(restoreRoute).toContain("planContactRestore(");
    expect(restoreRoute).toContain("existing.updatedAt.getTime() + 1");
    expect(restoreRoute).toContain('restorePlan.kind === "already_active"');
    expect(restoreRoute).toContain("deletedAt: null");
    expect(restoreRoute).toContain("deletedBy: null");
    expect(restoreRoute).toContain("purgeEligibleAt: null");
    expect(restoreRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(restoreRoute).toContain("completeTeamMutationIdempotency(");
    expect(restoreRoute).toContain("settleTeamMutationIdempotencyFailure(");
    expect(restoreRoute).toContain("automationRemainsPaused: true");
    expect(restoreRoute).toContain("outboxRemainsQuarantined: true");
    expect(restoreRoute).toContain("requiresManualAutomationReview: true");
    expect(restoreRoute).not.toContain(".delete(contacts)");
    expect(restoreRoute).not.toContain(".update(leadAutomationStates)");
    expect(restoreRoute).not.toContain(".update(outboxEvents)");
  });

  it("hides deleted contacts from default list, search, detail, Omni, and selectors", () => {
    expect(contactsRoute).toContain(
      "deletedOnly ? isNotNull(contacts.deletedAt) : isNull(contacts.deletedAt)",
    );
    expect(contactsRoute).toContain('searchParams.get("deleted") === "only"');
    expect(contactsRoute).toContain('requirePermission(\n      request,\n      "contacts.restore"');
    expect(deleteRoute.match(/isNull\(contacts\.deletedAt\)/gu)?.length).toBe(
      3,
    );
    expect(pipelineRoute).toContain("const visibilityWhere = and(");
    expect(pipelineRoute).toContain("isNull(contacts.deletedAt)");
    expect(pipelineRoute).toContain(".where(pageWhere)");
    expect(omniRoute).toContain("isNull(contacts.deletedAt)");
    expect(omniContext).toContain(
      "and(eq(contacts.id, contactId), isNull(contacts.deletedAt))",
    );
    expect(photoRoute).toContain("isNull(contacts.deletedAt)");
    expect(webPersistence.match(/isNull\(contacts\.deletedAt\)/gu)?.length).toBe(
      5,
    );
  });

  it("registers migration 0068 after property associations and grants stored owner restore", () => {
    const migration = source("src/db/migrations/0068_contact_soft_delete.sql");
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const associationIndex = entries.findIndex(
      (entry) => entry.tag === "0067_contact_property_associations",
    );

    expect(entries.slice(associationIndex, associationIndex + 2)).toEqual([
      expect.objectContaining({
        idx: 64,
        tag: "0067_contact_property_associations",
      }),
      expect.objectContaining({ idx: 65, tag: "0068_contact_soft_delete" }),
    ]);
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone',
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "deleted_by" uuid',
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "purge_eligible_at" timestamp with time zone',
    );
    expect(migration).toContain("contacts_deleted_by_team_member_fk");
    expect(migration).toContain("interval '30 days'");
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "quarantined_at" timestamp with time zone',
    );
    expect(migration).toContain("outbox_quarantine_state_check");
    expect(migration).toContain("outbox_quarantined_contact_fk");
    expect(migration).toMatch(
      /outbox_quarantined_contact_fk[\s\S]*ON DELETE RESTRICT/iu,
    );
    expect(migration).toContain(
      "enforce_deleted_contact_automation_pause",
    );
    expect(migration).toContain("lead_automation_deleted_contact_pause");
    expect(migration).toContain("ARRAY['contacts.restore']::text[]");
    expect(migration).toContain("lower(trim(\"slug\")) = 'owner'");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"?contacts"?/iu);
  });

  it("excludes quarantined work and fails closed before any outbox handler", () => {
    const batchStart = outboxProcessor.indexOf(
      "export async function processOutboxBatch",
    );
    const batchSource = outboxProcessor.slice(batchStart);
    expect(batchSource).toContain("isNull(outboxEvents.quarantinedAt)");
    expect(batchSource).toContain(
      "await resolveContactForOutboxEvent(event)",
    );
    expect(batchSource).toContain(
      "await quarantineOutboxEventForDeletedContact(",
    );
    expect(batchSource).toContain("contactScope.contactId");
    expect(batchSource).toContain("contact_dispatch_guard_failed");
    expect(batchSource).toContain(
      'event.type !== "sales.escalation.call"',
    );
    expect(batchSource.indexOf("resolveContactForOutboxEvent")).toBeLessThan(
      batchSource.indexOf("handleOutboxEvent(event)"),
    );
  });

  it("atomically quarantines worker-discovered operations with an audit event", () => {
    const helperStart = outboxProcessor.indexOf(
      "async function quarantineOutboxEventForDeletedContact",
    );
    const helperEnd = outboxProcessor.indexOf(
      "function readMetadataString",
      helperStart,
    );
    const helperSource = outboxProcessor.slice(helperStart, helperEnd);
    expect(helperSource).toContain("db.transaction(async (tx)");
    expect(helperSource).toMatch(/tx\s*\.update\(outboxEvents\)/u);
    expect(helperSource).toContain("tx.insert(auditLogs)");
    expect(helperSource).toContain('action: "contact.outbox_quarantined"');
  });

  it("never removes quarantined evidence through routine follow-up cleanup", () => {
    const deleteWithQuarantineFilter =
      /\.delete\(outboxEvents\)[\s\S]{0,320}?isNull\(outboxEvents\.quarantinedAt\)/gu;
    const clearFollowups = outboxProcessor.slice(
      outboxProcessor.indexOf("async function clearLeadFollowups"),
      outboxProcessor.indexOf("async function getAutomationMode"),
    );
    const clearReminders = outboxProcessor.slice(
      outboxProcessor.indexOf("async function clearPendingReminders"),
      outboxProcessor.indexOf("async function scheduleAppointmentReminders"),
    );
    for (const cleanup of [clearFollowups, clearReminders]) {
      expect(cleanup).toContain(".delete(outboxEvents)");
      expect(cleanup).toContain("isNull(outboxEvents.quarantinedAt)");
    }
    expect(inbox.match(deleteWithQuarantineFilter)).toHaveLength(1);
    expect(autoReplies.match(deleteWithQuarantineFilter)).toHaveLength(3);
  });

  it("blocks message sends for deleted contacts before typing or provider effects", () => {
    const messageStart = outboxProcessor.indexOf('case "message.send"');
    const messageEnd = outboxProcessor.indexOf("default:", messageStart);
    const messageSource = outboxProcessor.slice(messageStart, messageEnd);
    const deletedGuard = messageSource.indexOf(
      "message.contactId && message.contactDeletedAt",
    );

    expect(messageSource).toContain("contactDeletedAt: contacts.deletedAt");
    expect(deletedGuard).toBeGreaterThan(-1);
    expect(deletedGuard).toBeLessThan(messageSource.indexOf("sendDmTyping("));
    expect(deletedGuard).toBeLessThan(messageSource.indexOf("sendSmsMessage("));
    expect(deletedGuard).toBeLessThan(messageSource.indexOf("sendEmailMessage("));
    expect(deletedGuard).toBeLessThan(messageSource.indexOf("sendDmMessage("));
  });

  it("serializes provider dispatch with contact deletion across the final race window", () => {
    const advisoryLock = "pg_advisory_xact_lock(hashtextextended";
    const handlerLock = outboxProcessor.indexOf(advisoryLock);
    const handlerCall = outboxProcessor.indexOf(
      "await handleOutboxEvent(event)",
      handlerLock,
    );
    const deleteLock = deleteRoute.indexOf(advisoryLock);
    const deleteUpdate = deleteRoute.indexOf(".update(contacts)", deleteLock);
    const restoreLock = restoreRoute.indexOf(advisoryLock);
    const restoreUpdate = restoreRoute.indexOf(
      ".update(contacts)",
      restoreLock,
    );

    expect(handlerLock).toBeGreaterThan(-1);
    expect(handlerLock).toBeLessThan(handlerCall);
    expect(deleteLock).toBeGreaterThan(-1);
    expect(deleteLock).toBeLessThan(deleteUpdate);
    expect(restoreLock).toBeGreaterThan(-1);
    expect(restoreLock).toBeLessThan(restoreUpdate);

    const guardedHandlerStart = outboxProcessor.indexOf(
      "async function handleContactScopedOutboxEvent",
    );
    const guardedHandlerEnd = outboxProcessor.indexOf(
      "function readMetadataString",
      guardedHandlerStart,
    );
    const guardedHandler = outboxProcessor.slice(
      guardedHandlerStart,
      guardedHandlerEnd,
    );
    const providerOutcome = guardedHandler.indexOf(
      "await handleOutboxEvent(event)",
    );
    const finalEventUpdate = guardedHandler.indexOf(
      "await finalizeOutboxEvent(tx, event, outcome)",
    );
    expect(guardedHandler).toContain("isNull(outboxEvents.processedAt)");
    expect(guardedHandler).toContain("isNull(outboxEvents.quarantinedAt)");
    expect(providerOutcome).toBeGreaterThan(-1);
    expect(providerOutcome).toBeLessThan(finalEventUpdate);
    expect(outboxProcessor).toContain(
      "if (finalizedWithinContactLock) continue;",
    );
  });

  it("makes contact-scoped finalization uncertainty terminal with no redispatch", () => {
    const catchStart = outboxProcessor.indexOf(
      "if (error instanceof OutboxFinalizationFailure)",
      outboxProcessor.indexOf("export async function processOutboxBatch"),
    );
    const catchEnd = outboxProcessor.indexOf(
      "outcome = outcomeForOutboxHandlerError",
      catchStart,
    );
    const reconciliationCatch = outboxProcessor.slice(catchStart, catchEnd);
    const helperStart = outboxProcessor.indexOf(
      "async function quarantineOutboxEventForFinalizationReconciliation",
    );
    const helperEnd = outboxProcessor.indexOf(
      "async function handleContactScopedOutboxEvent",
      helperStart,
    );
    const reconciliationHelper = outboxProcessor.slice(helperStart, helperEnd);

    expect(reconciliationCatch).toContain(
      "quarantineOutboxEventForFinalizationReconciliation(",
    );
    expect(reconciliationCatch).not.toContain(
      "Date.now() + 15 * 60_000",
    );
    expect(reconciliationHelper).toContain("db.transaction(async (tx)");
    expect(reconciliationHelper).toContain(
      "planContactScopedOutboxReconciliation(",
    );
    expect(reconciliationHelper).toContain("tx.insert(auditLogs)");
    expect(reconciliationHelper).toContain(
      'action: "contact.outbox_reconciliation_required"',
    );
    expect(reconciliationHelper).toContain("isNull(outboxEvents.quarantinedAt)");
  });

  it("rejects authoritative direct sends under the shared deletion lock", () => {
    const lock = "pg_advisory_xact_lock(hashtextextended";
    expect(outboundSafety).toContain(lock);
    expect(outboundSafety).toContain("deletedAt: contacts.deletedAt");
    expect(outboundSafety).toContain('TeamMutationFailure(\n      "conflict"');

    for (const route of [directMessageRoute, directThreadRoute]) {
      const guard = route.indexOf("requireActiveContactForDirectOutbound(");
      const outbox = route.indexOf(".insert(outboxEvents)", guard);
      expect(guard).toBeGreaterThan(-1);
      expect(outbox).toBeGreaterThan(guard);
      expect(route).toContain("teamMutationExceptionResponse(error)");
    }

    const retryGuard = retryMessageRoute.indexOf(
      "requireActiveContactForDirectOutbound(",
    );
    const retryWrite = retryMessageRoute.indexOf(
      ".update(outboxEvents)",
      retryGuard,
    );
    expect(retryGuard).toBeGreaterThan(-1);
    expect(retryWrite).toBeGreaterThan(retryGuard);
    expect(retryMessageRoute).toContain(
      "quarantinedAt: outboxEvents.quarantinedAt",
    );
    expect(retryMessageRoute).toContain(
      "This message is quarantined for review",
    );

    expect(etaAgent.indexOf("requireActiveContactForDirectOutbound(")).toBeLessThan(
      etaAgent.indexOf(".insert(conversationMessages)", etaAgent.indexOf("export async function sendEtaDraft")),
    );
    expect(etaSendRoute).toContain('{ status: 409 }');
    expect(quoteSendRoute.indexOf("requireActiveContactForDirectOutbound(")).toBeLessThan(
      quoteSendRoute.indexOf(".update(quotes)"),
    );
    expect(systemOutbound.indexOf("requireActiveContactForDirectOutbound(")).toBeLessThan(
      systemOutbound.indexOf(".insert(conversationMessages)"),
    );
  });

  it("resolves all current CRM outbox entity reference keys", () => {
    for (const key of [
      "contactId",
      "leadId",
      "appointmentId",
      "quoteId",
      "taskId",
      "threadId",
      "messageId",
      "draftMessageId",
      "inboundMessageId",
      "callRecordId",
      "callSid",
    ]) {
      expect(outboxProcessor).toContain(`payload["${key}"]`);
    }
    expect(outboxProcessor).toContain(
      ".select({ id: contacts.id, deletedAt: contacts.deletedAt })",
    );
    expect(outboxProcessor).toContain(
      "and(eq(contacts.id, contactId), isNull(contacts.deletedAt))",
    );
    expect(outboxProcessor).toContain(
      "and(eq(contacts.id, leadRow.contactId), isNull(contacts.deletedAt))",
    );
  });
});
