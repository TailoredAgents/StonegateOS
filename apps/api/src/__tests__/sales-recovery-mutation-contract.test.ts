import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(process.cwd());
const SITE_ROOT = join(process.cwd(), "../site");

function apiSource(path: string): string {
  return readFileSync(join(API_ROOT, path), "utf8");
}

function siteSource(path: string): string {
  return readFileSync(join(SITE_ROOT, path), "utf8");
}

describe("Sales HQ recovery mutation contract", () => {
  const disposition = apiSource("app/api/admin/sales/disposition/route.ts");
  const messageRetry = apiSource(
    "app/api/admin/inbox/messages/[messageId]/retry/route.ts",
  );
  const actions = siteSource("src/app/team/actions.ts");
  const inbox = siteSource("src/app/team/components/InboxSection.tsx");
  const salesHq = siteSource("src/app/team/components/SalesHqClient.tsx");
  const contactDetails = siteSource(
    "src/app/team/components/ContactsDetailsPaneClient.tsx",
  );
  const reminders = siteSource(
    "src/app/team/components/InboxContactRemindersClient.tsx",
  );
  const contactsReminders = siteSource(
    "src/app/team/components/ContactsListClient.tsx",
  );
  const reminderCreate = apiSource("app/api/admin/crm/reminders/route.ts");
  const reminderUpdate = apiSource(
    "app/api/admin/crm/reminders/[taskId]/route.ts",
  );
  const reminderCreateProxy = siteSource(
    "src/app/api/team/contacts/reminders/route.ts",
  );
  const reminderUpdateProxy = siteSource(
    "src/app/api/team/contacts/reminders/[taskId]/route.ts",
  );
  const reminderContract = siteSource("src/app/team/lib/reminder-mutation.ts");
  const agentAvailability = siteSource(
    "src/app/team/lib/agent-action-availability.ts",
  );
  const journey = readFileSync(
    join(process.cwd(), "../../tests/e2e/audit/team-console-audit.spec.ts"),
    "utf8",
  );
  const journeyFixtures = readFileSync(
    join(process.cwd(), "../../tests/e2e/audit/journey-fixtures.ts"),
    "utf8",
  );
  const dispositionProxy = siteSource(
    "src/app/api/team/sales/disposition/route.ts",
  );
  const scheduler = apiSource("src/lib/sales-draft-prep-scheduler.ts");

  it("authorizes dispositions with sales.write at both Site and API boundaries", () => {
    expect(disposition).toContain('requiredPermissions: ["sales.write"]');
    expect(disposition).not.toContain(
      'requirePermission(request, "appointments.update")',
    );
    expect(dispositionProxy).toContain('permissions: "sales.write"');
    expect(disposition.indexOf("beginTeamMutation(request,")).toBeLessThan(
      disposition.indexOf("request.json()"),
    );
  });

  it("makes dispositions durable, replayable, serialized, and audit-atomic", () => {
    expect(disposition).toContain("requiresIdempotency: true");
    expect(disposition).toContain("claimTeamMutationIdempotency(db, mutation");
    expect(disposition).toContain(
      "teamMutationIdempotencyReplayResponse(claimed.replay)",
    );
    expect(disposition).toContain("pg_advisory_xact_lock");
    expect(disposition).toContain('.for("update")');
    expect(disposition).toContain("existingDispositionTask");
    expect(disposition).toContain(": [{ id: existingDispositionTask.id }]");
    expect(disposition).toContain("if (pipelineChanged) {");
    expect(disposition).toContain("mutation.audit.insertSuccess(tx");
    expect(disposition).toContain("completeTeamMutationIdempotency(");
    expect(disposition).not.toContain("recordAuditEvent(");
    expect(disposition.indexOf("mutation.audit.insertSuccess(tx")).toBeLessThan(
      disposition.indexOf("completeTeamMutationIdempotency("),
    );
  });

  it("serializes draft/retry sends before inspecting outbox and provider state", () => {
    const messageLock = messageRetry.indexOf(
      '.for("update", { of: conversationMessages })',
    );
    const pendingLock = messageRetry.indexOf(
      ".orderBy(desc(outboxEvents.createdAt), desc(outboxEvents.id))",
    );
    const providerRead = messageRetry.indexOf(
      ".from(externalMessageDispatches)",
    );

    expect(messageRetry).toContain('requiredPermissions: ["messages.send"]');
    expect(messageRetry).toContain('principalTypes: ["human", "service"]');
    expect(messageRetry).toContain('risk: "external"');
    expect(messageRetry).toContain("requiresIdempotency: true");
    expect(messageRetry.indexOf("beginTeamMutation(request,")).toBeLessThan(
      messageRetry.indexOf("await context.params"),
    );
    expect(messageLock).toBeGreaterThan(0);
    expect(pendingLock).toBeGreaterThan(messageLock);
    expect(providerRead).toBeGreaterThan(pendingLock);
    expect(messageRetry).toContain("claimTeamMutationIdempotency(db, mutation");
    expect(messageRetry).toContain(
      "teamMutationIdempotencyReplayResponse(claimed.replay)",
    );
    expect(messageRetry).toContain(
      "outboxEventId = reactivated.id;\n        changed = true;",
    );
  });

  it("co-commits queued-send evidence, audit attribution, and replay receipt", () => {
    const transaction = messageRetry.indexOf("db.transaction(async (tx)");
    const outboxWrite = messageRetry.indexOf(".insert(outboxEvents)");
    const audit = messageRetry.indexOf("mutation.audit.insertSuccess(tx");
    const receipt = messageRetry.indexOf("completeTeamMutationIdempotency(");

    expect(transaction).toBeGreaterThan(0);
    expect(outboxWrite).toBeGreaterThan(transaction);
    expect(audit).toBeGreaterThan(outboxWrite);
    expect(receipt).toBeGreaterThan(audit);
    expect(messageRetry).not.toContain("recordAuditEvent(");
    expect(messageRetry).toContain('auditAction: "message.retry"');
    expect(messageRetry).toContain("outboxEventId");
  });

  it("requires stable browser keys and validates mutation receipts before success", () => {
    for (const actionName of [
      "retryFailedMessageAction",
      "sendDraftMessageAction",
      "setSalesDispositionAction",
    ]) {
      const start = actions.indexOf(`export async function ${actionName}`);
      const end = actions.indexOf("export async function ", start + 1);
      const source = actions.slice(start, end < 0 ? actions.length : end);
      expect(start).toBeGreaterThan(0);
      expect(source).toContain('formData.get("idempotencyKey")');
      expect(source).toContain("callAdminMutationWithSafeReplay(");
      expect(source).toContain("requireReceipt: true");
    }

    expect(
      inbox.match(/name="idempotencyKey"/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
    expect(inbox).toContain("value={`message-send:${randomUUID()}`}");
    expect(inbox).toContain("value={`message-retry:${randomUUID()}`}");
    expect(dispositionProxy).toContain(
      'request.headers.get("idempotency-key")',
    );
    expect(dispositionProxy).toContain(
      'headers: { "Idempotency-Key": idempotencyKey }',
    );
    expect(salesHq).toContain("dispositionAttemptKeysRef");
    expect(salesHq).toContain('"Idempotency-Key": idempotencyKey');
    expect(salesHq).toContain("isTeamMutationSuccessEnvelope(payload)");
    expect(scheduler).toContain(
      '"Idempotency-Key": `sales-autosend:${messageId}`',
    );
  });

  it("hardens reminder create, edit, and completion as atomic human mutations", () => {
    expect(reminderCreate).toContain('principalTypes: ["human"]');
    expect(reminderCreate).toContain('requiredPermissions: ["contacts.write"]');
    expect(reminderCreate).toContain('auditAction: "crm.reminder.created"');
    expect(reminderUpdate).toContain('auditAction: "crm.reminder.updated"');
    expect(reminderUpdate).toContain('auditAction: "crm.reminder.completed"');
    for (const source of [reminderCreate, reminderUpdate]) {
      expect(source).toContain("requiresIdempotency: true");
      expect(source).toContain("claimTeamMutationIdempotency(db, mutation");
      expect(source).toContain(
        "teamMutationIdempotencyReplayResponse(claimed.replay)",
      );
      expect(source).toContain("pg_advisory_xact_lock");
      expect(source).toContain('.for("update")');
      expect(source).toContain("mutation.audit.insertSuccess(tx");
      expect(source).toContain("completeTeamMutationIdempotency(");
      expect(source).not.toContain("recordAuditEvent(");
    }
    expect(reminderCreate.indexOf("beginTeamMutation(request,")).toBeLessThan(
      reminderCreate.indexOf("readBoundedJsonRequest(request"),
    );
    expect(reminderUpdate).toContain("assertTeamMutationExpectedVersion(");
    expect(reminderUpdate).toContain(
      "eq(crmTasks.updatedAt, existing.updatedAt)",
    );
    expect(reminderUpdate).toContain("nextAttemptAt: input.dueAt");
    expect(reminderUpdate).toContain("canceledOutboxEventIds");
  });

  it("requires same-origin stable Site requests and verifies exact reminder receipts", () => {
    for (const source of [reminderCreateProxy, reminderUpdateProxy]) {
      expect(source).toContain("isSameOriginReminderRequest(request)");
      expect(source).toContain("reminderIdempotencyKey(request)");
      expect(source).toContain("callAdminMutationWithSafeReplay(");
      expect(source).toContain("parseReminderMutationSuccess(body");
    }
    expect(reminderUpdateProxy).toContain("reminderExpectedVersion(request)");
    expect(reminderUpdateProxy).toContain('"If-Match":');
    expect(reminderContract).toContain(
      'receipt["version"] !== reminder.updatedAt',
    );
    expect(reminderContract).toContain('receipt["entityType"] !== "crm_task"');
    expect(reminderContract).toContain(
      '!UUID_PATTERN.test(receipt["auditEventId"])',
    );
    const actionStart = actions.indexOf(
      "export async function createCanvassFollowupAction",
    );
    const actionEnd = actions.indexOf(
      "export async function ",
      actionStart + 1,
    );
    const canvassAction = actions.slice(actionStart, actionEnd);
    expect(canvassAction).toContain(
      'hasTeamPermission(principal, "contacts.write")',
    );
    expect(canvassAction).toContain('formData.get("idempotencyKey")');
    expect(canvassAction).toContain("callAdminMutationWithSafeReplay(");
    expect(canvassAction).toContain("parseReminderMutationSuccess(result");
    expect(agentAvailability).not.toContain("create_reminder:");
  });

  it("preserves reminder input, reuses retry keys, and never trusts a bare 2xx", () => {
    for (const source of [reminders, contactsReminders]) {
      expect(source).toContain("stableReminderMutationAttempt(");
      expect(source).toContain('"Idempotency-Key": attempt.idempotencyKey');
      expect(source).toContain('"If-Match":');
      expect(source).toContain("parseReminderMutationSuccess(data");
      expect(source).toContain("No success is being claimed");
    }
    expect(reminders).toContain("Your reminder was not confirmed");
    expect(reminders).toContain("Completion was not confirmed");
    expect(reminders).toContain("Your changes were not confirmed");
    expect(reminders.match(/role="alert"/gu)).toHaveLength(2);
    expect(inbox).toContain("key={activeContactId}");
    expect(salesHq).toContain("key={contactSummary.id}");
    expect(contactDetails).toContain("key={contact.id}");
  });

  it("makes the Sales HQ recovery journey create and verify a real reminder", () => {
    expect(journey).toContain('name: "Contact reminders"');
    expect(journey).toContain("getContactReminderSnapshot(");
    expect(journey).toContain('"crm.reminder.created"');
    expect(journeyFixtures).toContain(
      "export async function getContactReminderSnapshot(",
    );
    expect(journeyFixtures).toContain(
      "event.payload->>'taskId' = task.id::text",
    );
    expect(inbox).toContain('aria-labelledby="inbox-ai-workspace-title"');
    expect(journey).toContain("name: /^(Send suggestion|Send now)$/");
  });
});
