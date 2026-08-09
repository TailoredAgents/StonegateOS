import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyManualCallProviderResult,
  isCallCapableTaskNotes,
  planManualCallOperation,
} from "@/lib/manual-call-operations";
import {
  classifyManualCallCallbackApplication,
  classifyManualCallDialAction,
  isManualCallCallbackStatus,
  manualCallNeedsReconciliation,
} from "@/lib/manual-call-callbacks";
import { isManualCallMutationSuccess } from "../../../site/src/app/team/lib/manual-call-result";

const REPO_ROOT = resolve(process.cwd(), "../..");
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_ID = "44444444-4444-4444-8444-444444444444";
const CALL_SID = `CA${"a".repeat(32)}`;

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function filesBelow(relativeDirectory: string): string[] {
  const absoluteDirectory = resolve(REPO_ROOT, relativeDirectory);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(absolute);
    }
  };
  visit(absoluteDirectory);
  return files;
}

function successEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      callOperationId: OPERATION_ID,
      state: "succeeded",
      provider: "twilio",
      providerIdempotencySupported: false,
      agentMemberId: ACTOR_ID,
      taskId: null,
      taskEffects: "completed",
      completedExplicitTaskId: null,
      completedFollowupTaskId: null,
      completedSpeedToLeadCount: 0,
    },
    receipt: {
      operationId: "55555555-5555-4555-8555-555555555555",
      correlationId: "call-correlation-123",
      actorId: ACTOR_ID,
      committedAt: "2026-08-08T12:00:00.000Z",
      auditEventId: AUDIT_ID,
      entityType: "contact",
      entityId: CONTACT_ID,
      version: 3,
      providerOperationId: CALL_SID,
    },
    ...overrides,
  };
}

describe("manual call state and provider certainty", () => {
  it("never redispatches a persisted dispatched attempt", () => {
    expect(planManualCallOperation("requested")).toEqual({ kind: "prepare" });
    expect(planManualCallOperation("dispatched")).toEqual({
      kind: "reconcile_without_redispatch",
    });
    expect(planManualCallOperation("succeeded")).toEqual({ kind: "terminal" });
    expect(planManualCallOperation("reconciliation_required")).toEqual({
      kind: "terminal",
    });
    expect(planManualCallOperation("mystery")).toEqual({ kind: "corrupt" });
  });

  it("treats an accepted Twilio SID as active rather than connected", () => {
    expect(
      classifyManualCallProviderResult({
        ok: true,
        callSid: CALL_SID,
        provider: "twilio",
        deliveryCertainty: "accepted",
        providerIdempotencySupported: false,
      }),
    ).toMatchObject({
      state: "active",
      providerOperationId: CALL_SID,
      providerStatus: 201,
      responseStatus: 202,
    });
  });

  it.each([
    [408, "reconciliation_required", false],
    [503, "reconciliation_required", false],
    [429, "failed", true],
    [400, "failed", false],
  ] as const)(
    "maps status %s to %s without inventing success",
    (status, state, retryable) => {
      const outcome = classifyManualCallProviderResult({
        ok: false,
        callSid: null,
        provider: "twilio",
        deliveryCertainty:
          status === 408 || status === 503 ? "uncertain" : "not_sent",
        providerIdempotencySupported: false,
        detail: `twilio_call_failed:${status}`,
        status,
      });
      expect(outcome).toMatchObject({ state, retryable });
      expect(outcome.providerOperationId).toBeNull();
      expect(outcome.message).not.toMatch(/success|started/iu);
    },
  );
});

describe("manual call route and durable evidence contracts", () => {
  const route = source("apps/api/app/api/admin/calls/start/route.ts");
  const operations = source("apps/api/src/lib/manual-call-operations.ts");
  const callbacks = source("apps/api/src/lib/manual-call-callbacks.ts");
  const schema = source("apps/api/src/db/schema.ts");
  const callStatus = source(
    "apps/api/app/api/webhooks/twilio/call-status/route.ts",
  );
  const connectWebhook = source(
    "apps/api/app/api/webhooks/twilio/connect/route.ts",
  );
  const dialActionWebhook = source(
    "apps/api/app/api/webhooks/twilio/dial-action/route.ts",
  );
  const salesScorecard = source("apps/api/src/lib/sales-scorecard.ts");
  const salesQueue = source("apps/api/app/api/admin/sales/queue/route.ts");
  const salesActivity = source(
    "apps/api/app/api/admin/sales/activity/route.ts",
  );
  const outboxProcessor = source("apps/api/src/lib/outbox-processor.ts");
  const migration = source(
    "apps/api/src/db/migrations/0078_team_call_operations.sql",
  );
  const outcomeMigration = source(
    "apps/api/src/db/migrations/0081_team_call_outcomes.sql",
  );

  it("establishes explicit human call authorization before parsing or I/O", () => {
    const boundary = route.indexOf("beginTeamMutation(request");
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(route).toContain('principalTypes: ["human"]');
    expect(route).toContain('requiredPermissions: ["calls.place"]');
    expect(route).toContain('risk: "external"');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain('auditAction: "call.started"');
    expect(boundary).toBeLessThan(route.indexOf("request.json()"));
    expect(boundary).toBeLessThan(route.indexOf("getDb()"));
  });

  it("durably claims, replays, and atomically completes caller idempotency", () => {
    expect(route).toContain("claimTeamMutationIdempotency(db, mutation");
    expect(route).toContain("extendTeamMutationIdempotencyLease(");
    expect(route).toContain("2 * 60 * 1_000");
    expect(route).toContain("teamMutationIdempotencyReplayResponse(");
    expect(operations).toContain("completeTeamMutationIdempotency(");
    expect(operations).toContain("mutationClaimId: input.claim.id");
    expect(operations).toContain("requestHash: evidence.requestHash");
    expect(route).toContain("reconcileManualCallAfterTerminalStorageFailure");
    expect(route).toContain("Do not retry");
    expect(route).toContain("invalidCallRequest(mutation");
    expect(route).toContain('boundary: "input_validation"');
  });

  it("holds the canonical contact lock through the final DNC check and dispatched write", () => {
    const lock = operations.indexOf(
      "pg_advisory_xact_lock(hashtextextended(${input.contactId}, 0))",
    );
    const firstDnc = operations.indexOf("if (contact.doNotContact)", lock);
    const requested = operations.indexOf(
      ".insert(teamCallOperations)",
      firstDnc,
    );
    const dispatchRead = operations.indexOf(
      "const [dispatchContact]",
      requested,
    );
    const finalDnc = operations.indexOf(
      "if (dispatchContact.doNotContact)",
      dispatchRead,
    );
    const dispatched = operations.indexOf('state: "dispatched"', finalDnc);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(firstDnc).toBeGreaterThan(lock);
    expect(requested).toBeGreaterThan(firstDnc);
    expect(dispatchRead).toBeGreaterThan(requested);
    expect(finalDnc).toBeGreaterThan(dispatchRead);
    expect(dispatched).toBeGreaterThan(finalDnc);
    expect(route.indexOf("createTwilioOutboundCall({")).toBeGreaterThan(
      route.indexOf("prepareManualCallOperation({"),
    );
  });

  it("verifies contact, agent, and task identities without accepting phone input", () => {
    expect(route).not.toContain("json.toPhone");
    expect(route).not.toContain("json.agentPhone");
    expect(operations).toContain("teamMembers.phoneE164");
    expect(operations).toContain("eq(teamMembers.id, agentMemberId)");
    expect(operations).toContain("!agent.active");
    expect(operations).toContain("task.contactId !== contact.id");
    expect(operations).toContain("contact.deletedAt");
    expect(operations).toContain("contact.doNotContact");
  });

  it("records provider acceptance without completing CRM tasks", () => {
    const finalizer = operations.slice(
      operations.indexOf("export async function finalizeManualCallOperation"),
      operations.indexOf(
        "export async function reconcileManualCallAfterTerminalStorageFailure",
      ),
    );
    expect(finalizer).toContain("input.db.transaction(async (tx)");
    expect(finalizer).toContain("completeAcceptedMutation(tx");
    expect(finalizer).not.toContain("completeSnapshottedTasks(");
    expect(operations).not.toContain("completeSuccessfulCallTasks(");
    const connectedReducer = callbacks.slice(
      callbacks.indexOf("async function settleConnected"),
      callbacks.indexOf(
        "export async function handleManualCallConnectCallback",
      ),
    );
    expect(connectedReducer).toContain("completeSnapshottedTasks(tx");
    expect(connectedReducer).toContain("insertSystemAudit(tx");
    expect(connectedReducer).toContain(".update(teamCallOperations)");
    expect(callbacks).toContain(
      "const customerDialAllowed = !suppressed && inserted",
    );
  });

  it("stores no phone number in the ledger, audit metadata, logs, or success data", () => {
    const table = migration.slice(
      migration.indexOf("CREATE TABLE"),
      migration.indexOf(");", migration.indexOf("CREATE TABLE")) + 2,
    );
    expect(table).not.toMatch(/phone/iu);
    expect(route).not.toContain("console.");
    expect(operations).not.toMatch(/metadata:\s*\{[^}]*Phone/su);
    const publicData = operations.slice(
      operations.indexOf("const data: ManualCallSuccessData"),
      operations.indexOf("const result =", operations.indexOf("const data:")),
    );
    expect(publicData).not.toMatch(/phone/iu);
    expect(route).not.toContain('searchParams.set("to"');
    expect(route).toContain(
      'searchParams.set("requestKey", operation.providerRequestKey)',
    );
    expect(connectWebhook).not.toContain("url: request.nextUrl.toString()");
    expect(callStatus).not.toContain(
      'console.info("[twilio.call_status]", payload)',
    );
    expect(dialActionWebhook).not.toContain(
      'console.info("[twilio.dial_action]", payload)',
    );
  });

  it("links status callbacks through the dedicated provider ID and verified agent", () => {
    expect(callStatus).toContain("teamCallOperations.providerRequestKey");
    expect(callStatus).toContain("operation.agentMemberId");
    expect(callStatus).toContain("auditLogs.providerOperationId");
    expect(callStatus).toContain('meta?.["agentMemberId"]');
    expect(callStatus).toContain("agentMemberId || audit.actorId || null");
    expect(callStatus).toContain("auditLogs.meta} ->> 'callSid'");
  });

  it("does not turn failed call audit evidence into a successful sales touch", () => {
    for (const consumer of [salesScorecard, salesQueue, outboxProcessor]) {
      const callStarted = consumer.indexOf(
        'eq(auditLogs.action, "call.started")',
      );
      expect(callStarted).toBeGreaterThanOrEqual(0);
      expect(
        consumer.indexOf('eq(auditLogs.outcome, "succeeded")', callStarted),
      ).toBeGreaterThan(callStarted);
    }
    expect(salesActivity).toContain(
      "${auditLogs.action} <> 'call.started' OR ${auditLogs.outcome} = 'succeeded'",
    );
  });

  it("registers immutable lifecycle, terminal audit, and active-contact guards", () => {
    expect(schema).toContain("export const teamCallOperations = pgTable(");
    expect(migration).toContain(
      "\"state\" IN (\n        'requested',\n        'dispatched',",
    );
    expect(migration).toContain('"team_call_operations_active_contact_key"');
    expect(migration).toContain(
      "WHERE \"state\" IN ('requested', 'dispatched')",
    );
    expect(migration).toContain('FOREIGN KEY ("terminal_audit_event_id")');
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION enforce_team_call_operation_transition()",
    );
    expect(migration).toContain("team_call_operation_identity_immutable");
    expect(migration).toContain("team_call_operation_terminal_immutable");
    expect(migration).toContain(
      "team_call_operation_invalid_dispatched_transition",
    );
    expect(migration).toContain(
      "\"provider_operation_id\" ~ '^CA[0-9A-Fa-f]{32}$'",
    );
  });

  it("adds migration 0078 to the journal without replacing earlier work", () => {
    const journal = JSON.parse(
      source("apps/api/src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    expect(journal.entries).toContainEqual({
      idx: 75,
      version: "7",
      when: 1787616000000,
      tag: "0078_team_call_operations",
      breakpoints: true,
    });
  });

  it("adds outcome migration 0081 after reconciliation", () => {
    const journal = JSON.parse(
      source("apps/api/src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<Record<string, unknown>> };
    expect(journal.entries).toContainEqual({
      idx: 78,
      version: "7",
      when: 1787875200000,
      tag: "0081_team_call_outcomes",
      breakpoints: true,
    });
    expect(outcomeMigration).toContain("'dispatched', 'active'");
    expect(outcomeMigration).toContain(
      'NEW."terminal_outcome" IS DISTINCT FROM (CASE resolution_outcome',
    );
    expect(outcomeMigration).toContain(
      'NEW."outcome_reason" IS DISTINCT FROM (CASE resolution_outcome',
    );
  });
});

describe("manual call outcome reducer", () => {
  const operations = source("apps/api/src/lib/manual-call-operations.ts");
  const callbacks = source("apps/api/src/lib/manual-call-callbacks.ts");
  const connectRoute = source(
    "apps/api/app/api/webhooks/twilio/connect/route.ts",
  );
  const statusRoute = source(
    "apps/api/app/api/webhooks/twilio/call-status/route.ts",
  );
  const dialActionRoute = source(
    "apps/api/app/api/webhooks/twilio/dial-action/route.ts",
  );
  const reconciliationRoute = source(
    "apps/api/app/api/admin/calls/reconciliation/route.ts",
  );
  const migration = source(
    "apps/api/src/db/migrations/0081_team_call_outcomes.sql",
  );

  it.each([
    ["completed", 42, true, "connected"],
    ["busy", 0, false, "not_connected"],
    ["no-answer", 0, false, "not_connected"],
    ["failed", 0, false, "not_connected"],
    ["canceled", 0, false, "not_connected"],
    ["completed", 0, false, "reconciliation_required"],
    ["completed", null, true, "reconciliation_required"],
    ["busy", 2, false, "reconciliation_required"],
  ] as const)(
    "classifies signed dial facts %s/%s/%s as %s",
    (dialCallStatus, dialCallDuration, dialBridged, expected) => {
      expect(
        classifyManualCallDialAction({
          dialCallStatus,
          dialCallDuration,
          dialBridged,
        }).kind,
      ).toBe(expected);
    },
  );

  it("accepts only the bounded Twilio callback status vocabulary", () => {
    for (const status of [
      "queued",
      "initiated",
      "ringing",
      "answered",
      "in-progress",
      "completed",
      "busy",
      "no-answer",
      "failed",
      "canceled",
    ]) {
      expect(isManualCallCallbackStatus(status)).toBe(true);
    }
    for (const status of [null, "", "unknown", "completed<script>"]) {
      expect(isManualCallCallbackStatus(status)).toBe(false);
    }
    expect(callbacks).toContain(
      'throw new ManualCallCallbackError("invalid_call_status", 400)',
    );
    expect(migration).toContain(
      'CONSTRAINT "team_call_callback_events_status_check"',
    );
    expect(migration).toContain(
      "'completed', 'busy', 'no-answer', 'failed', 'canceled'",
    );
  });

  it("rejects forged unrelated task IDs with an explicit call-kind marker", () => {
    expect(isCallCapableTaskNotes("kind=speed_to_lead")).toBe(true);
    expect(isCallCapableTaskNotes("[auto] leadId=abc kind=follow_up")).toBe(
      true,
    );
    expect(isCallCapableTaskNotes("kind=partner_checkin due=tomorrow")).toBe(
      true,
    );
    expect(isCallCapableTaskNotes("send brochure reminder")).toBe(false);
    expect(isCallCapableTaskNotes("kind=refund_review")).toBe(false);
    expect(isCallCapableTaskNotes("prefixkind=follow_up")).toBe(false);
    expect(operations).toContain("task.contactId !== contact.id");
    expect(operations).toContain('task.status !== "open"');
    expect(operations).toContain("task.assignedTo !== agent.id");
    expect(operations).toContain("!isCallCapableTaskNotes(task.notes)");
  });

  it("makes the request-key-bound dial action the only automatic connected reducer", () => {
    expect(connectRoute).toContain(
      'statusCallbackUrl.searchParams.set("requestKey", context.requestKey)',
    );
    expect(connectRoute).toContain(
      'dialActionUrl.searchParams.set("requestKey", context.requestKey)',
    );
    expect(connectRoute).toContain('searchParams.set("leg", "customer")');
    expect(dialActionRoute).toContain("handleManualCallDialActionCallback");
    expect(statusRoute).toContain("handleManualCallStatusCallback");
    const connected = callbacks.slice(
      callbacks.indexOf("async function settleConnected"),
      callbacks.indexOf(
        "export async function handleManualCallConnectCallback",
      ),
    );
    expect(connected).toContain("completeSnapshottedTasks(tx");
    expect(connected).toContain('action: "call.started"');
    expect(connected).toContain('actorAttribution: "initiator"');
    expect(connected).toContain('terminalOutcome: "connected"');
    expect(statusRoute).not.toContain("completeSnapshottedTasks");
  });

  it("deduplicates callback facts and supports callback-before-finalizer ordering", () => {
    expect(callbacks).toContain(".onConflictDoNothing()");
    expect(migration).toContain('"team_call_callback_events_semantic_key"');
    expect(operations).toContain('operation.state === "succeeded"');
    expect(operations).toContain(
      'operation.terminalOutcome === "not_connected"',
    );
    expect(operations).toContain('callSuccessData(operation, "failed")');
    expect(operations).toContain('existingForClaim.state === "active"');
    expect(operations).toContain("operation.providerAcceptedAuditEventId");
    expect(migration).toContain(
      "team_call_operation_provider_accepted_audit_immutable",
    );
  });

  it("co-commits provider acceptance evidence before active or terminal callback state", () => {
    expect(callbacks).toContain("async function ensureProviderAcceptedAudit(");
    expect(callbacks).toContain('action: "call.provider_accepted"');
    expect(callbacks).toContain('evidenceSource: "signed_callback"');
    expect(callbacks).toContain('actorAttribution: "initiator"');
    expect(callbacks).toContain("providerAcceptedAuditEventId,");
    expect(migration).toMatch(
      /"state" = 'active'[\s\S]*?"provider_accepted_audit_event_id" IS NOT NULL/u,
    );
    expect(migration).toMatch(
      /"state" = 'succeeded'[\s\S]*?"provider_accepted_audit_event_id" IS NOT NULL/u,
    );
    expect(migration).toContain('AND "outcome_reason" IS NOT NULL');
  });

  it("does not settle an out-of-order agent completed status as no connection", () => {
    const statusReducer = callbacks.slice(
      callbacks.indexOf("export async function handleManualCallStatusCallback"),
      callbacks.indexOf(
        "export async function handleManualCallDialActionCallback",
      ),
    );
    expect(statusReducer).toContain(
      'input.leg === "agent" &&\n      NEGATIVE_TERMINAL_STATUSES.has(status)',
    );
    expect(statusReducer).not.toContain(
      '(NEGATIVE_TERMINAL_STATUSES.has(status) || status === "completed") &&',
    );
  });

  it("records callbacks received during reconciliation as unapplied evidence", () => {
    expect(
      classifyManualCallCallbackApplication({
        state: "reconciliation_required",
        terminalOutcome: null,
      }),
    ).toBe("late");
    expect(
      classifyManualCallCallbackApplication({
        state: "reconciliation_required",
        terminalOutcome: null,
        dialOutcome: {
          kind: "connected",
          reason: "customer_bridge_completed",
        },
      }),
    ).toBe("late");
    expect(
      classifyManualCallCallbackApplication({
        state: "reconciliation_required",
        terminalOutcome: null,
        dialOutcome: {
          kind: "reconciliation_required",
          reason: "contradictory_facts",
        },
      }),
    ).toBe("anomaly");
  });

  it("quarantines expired callback deadlines without releasing guards or tasks", () => {
    const past = new Date("2026-08-08T11:59:59.000Z");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const future = new Date("2026-08-08T12:00:01.000Z");
    expect(manualCallNeedsReconciliation("active", past, now)).toBe(true);
    expect(manualCallNeedsReconciliation("dispatched", past, now)).toBe(true);
    expect(manualCallNeedsReconciliation("active", future, now)).toBe(false);
    expect(manualCallNeedsReconciliation("succeeded", past, now)).toBe(false);
    const scanner = callbacks.slice(
      callbacks.indexOf("export async function quarantineStaleManualCalls"),
    );
    expect(scanner).toContain("signed_terminal_callback_missing");
    expect(scanner).toContain("pg_advisory_xact_lock");
    expect(scanner).not.toContain("createTwilioOutboundCall");
    expect(scanner).not.toContain("completeSnapshottedTasks");
    expect(scanner).not.toContain("guardReleasedAt:");
    expect(reconciliationRoute).toContain(
      "await quarantineStaleManualCalls({ db, limit: 25 })",
    );
  });

  it("preserves legacy task-effect evidence before clearing false completion", () => {
    const legacy = migration.indexOf(
      '"legacy_completed_explicit_task_id" = "completed_explicit_task_id"',
    );
    const clear = migration.indexOf(
      '"completed_explicit_task_id" = NULL',
      legacy,
    );
    expect(legacy).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(legacy);
    expect(migration).toContain(
      '"legacy_completed_followup_task_id" = "completed_followup_task_id"',
    );
    expect(migration).toContain(
      '"legacy_completed_speed_to_lead_count" = "completed_speed_to_lead_count"',
    );
    expect(migration).toContain(
      'NEW."legacy_completed_explicit_task_id" IS DISTINCT FROM OLD."legacy_completed_explicit_task_id"',
    );
    expect(migration).toContain("team_call_operation_contact_guard_conflict");
    expect(migration).toContain(
      'PERFORM pg_advisory_xact_lock(hashtextextended(NEW."contact_id"::text, 0))',
    );
    expect(migration).toContain(
      'CREATE INDEX "team_call_operations_active_contact_key"',
    );
    expect(migration).not.toContain(
      'CREATE UNIQUE INDEX "team_call_operations_active_contact_key"',
    );
  });

  it("enforces exact reconciliation-to-terminal mappings in the database", () => {
    expect(migration).toContain("WHEN 'confirmed_connected' THEN 'connected'");
    expect(migration).toContain(
      "WHEN 'confirmed_not_connected' THEN 'not_connected'",
    );
    expect(migration).toContain(
      "WHEN 'confirmed_not_dispatched' THEN 'not_dispatched'",
    );
    expect(migration).toContain(
      "WHEN 'confirmed_connected' THEN 'operator_confirmed_connected'",
    );
    expect(migration).toContain(
      "team_call_operation_resolution_outcome_mismatch",
    );
    expect(reconciliationRoute).toContain(
      "taskEffects = await completeSnapshottedTasks(tx, operation, reviewedAt)",
    );
    expect(reconciliationRoute).toContain(
      '.set({ effect: "not_connected", effectAt: reviewedAt })',
    );
    expect(reconciliationRoute).toContain(
      '.set({ effect: "not_dispatched", effectAt: reviewedAt })',
    );
    expect(reconciliationRoute).toContain(
      "suppliedProviderOperationId !== operation.providerOperationId",
    );
    expect(reconciliationRoute).toContain(
      'parsed.data.outcome === "confirmed_not_dispatched" &&',
    );
    expect(reconciliationRoute).toContain(
      "hashtextextended(${candidate.contactId}, 0)",
    );
  });

  it("stores privacy-safe append-only callback evidence", () => {
    const callbackTable = migration.slice(
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS "team_call_operation_callback_events"',
      ),
      migration.indexOf(
        'CREATE TABLE IF NOT EXISTS "team_call_operation_task_intents"',
      ),
    );
    expect(callbackTable).not.toMatch(/phone|signature|auth_token|raw_body/iu);
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION enforce_team_call_callback_event_append_only()",
    );
    expect(callbacks).not.toContain("request.formData");
    expect(migration).toContain("'not_connected', 'not_dispatched'");
  });

  it("prevents deleting or truncating every durable call evidence ledger", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION enforce_team_call_operation_no_delete()",
    );
    expect(migration).toContain('BEFORE DELETE ON "team_call_operations"');
    for (const table of [
      "team_call_operations",
      "team_call_operation_callback_events",
      "team_call_operation_task_intents",
      "team_call_operation_reconciliations",
    ]) {
      expect(migration).toContain(`BEFORE TRUNCATE ON "${table}"`);
    }
    expect(migration).toContain("team_call_evidence_truncate_forbidden");
  });
});

describe("Site call receipt boundary", () => {
  const proxy = source("apps/site/src/app/api/team/calls/start/route.ts");
  const salesHq = source("apps/site/src/app/team/components/SalesHqClient.tsx");
  const actions = source("apps/site/src/app/team/actions.ts");
  const legacyContactsList = source(
    "apps/site/src/app/team/components/ContactsListClient.tsx",
  );

  it("rejects malformed 2xx bodies and receipts", () => {
    expect(isManualCallMutationSuccess({ ok: true }, CONTACT_ID)).toBe(false);
    expect(
      isManualCallMutationSuccess(
        successEnvelope({
          receipt: {
            ...successEnvelope().receipt,
            providerOperationId: "not-a-call-sid",
          },
        }),
        CONTACT_ID,
      ),
    ).toBe(false);
    expect(isManualCallMutationSuccess(successEnvelope(), CONTACT_ID)).toBe(
      true,
    );
    expect(
      isManualCallMutationSuccess(
        successEnvelope(),
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).toBe(false);
  });

  it("forwards caller idempotency and validates the full API receipt", () => {
    expect(proxy).toContain('request.headers.get("idempotency-key")');
    expect(proxy).toContain('headers: { "Idempotency-Key": idempotencyKey }');
    expect(proxy).toContain(
      "isManualCallMutationSuccess(upstreamPayload, contactId)",
    );
    expect(proxy).toContain("unreadable success receipt");
  });

  it("keeps a stable browser key across ambiguous failures", () => {
    expect(salesHq).toContain("callAttemptKeysRef");
    expect(salesHq).toContain("readBrowserCallAttempt(scope)");
    expect(salesHq).toContain('state: "ambiguous"');
    expect(salesHq).toContain('metadata?.state === "confirmed_not_sent"');
    expect(salesHq).toContain('? "confirmed_not_sent"');
    expect(salesHq).toContain("writeBrowserCallAttempt(scope, failedAttempt)");
    expect(salesHq).toContain('"Idempotency-Key": idempotencyKey');
    expect(salesHq).toContain(
      "isManualCallMutationSuccess(payload, contactId)",
    );
    expect(salesHq).toContain("the same request key will be reused");
  });

  it("gives server actions a key and refuses shallow success", () => {
    const callAction = actions.slice(
      actions.indexOf("export async function startContactCallAction"),
      actions.indexOf("export async function openContactThreadAction"),
    );
    expect(callAction).not.toContain("`team-call:${randomUUID()}`");
    expect(callAction).toContain("isValidTeamIdempotencyKey(submittedKey)");
    expect(callAction).toContain("MANUAL_CALL_ATTEMPT_COOKIE");
    expect(callAction).toContain('state: "ambiguous"');
    expect(callAction).toContain(
      'headers: { "Idempotency-Key": idempotencyKey }',
    );
    expect(callAction).toContain("readManualCallMutationSuccess(");
    expect(callAction).toContain("No success is being claimed");
  });

  it("keeps the retained legacy contact list fail-closed for call controls", () => {
    expect(legacyContactsList).toContain("canPlaceCalls: boolean");
    expect(legacyContactsList).toContain(
      "const canCall = canPlaceCalls && Boolean(phoneLink)",
    );
    expect(legacyContactsList).toContain("{canPlaceCalls ? (");
  });

  it("requires every Team and mobile server-action call form to carry a page-stable key and explicit intent", () => {
    const files = [
      ...filesBelow("apps/site/src/app/team"),
      ...filesBelow("apps/site/src/app/mobile"),
    ];
    let formCount = 0;
    const missing: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, "utf8");
      for (const actionName of [
        "startContactCallAction",
        "startMobileContactCallAction",
      ]) {
        const pattern = new RegExp(
          `<form\\b[^>]*action=\\{${actionName}\\}[^>]*>([\\s\\S]*?)<\\/form>`,
          "gu",
        );
        for (const match of body.matchAll(pattern)) {
          formCount += 1;
          const form = match[0];
          const location = `${file}:${body.slice(0, match.index).split("\n").length} ${actionName}`;
          if (!form.includes('name="idempotencyKey"')) {
            missing.push(`${location}: idempotencyKey`);
          }
          if (!form.includes('name="explicitNewAttempt"')) {
            missing.push(`${location}: explicitNewAttempt`);
          }
          if (!form.includes("START NEW CALL")) {
            missing.push(`${location}: explicit call intent`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
    expect(formCount).toBeGreaterThanOrEqual(17);
  });
});

describe("manual call reconciliation quarantine", () => {
  const route = source("apps/api/app/api/admin/calls/reconciliation/route.ts");
  const migration = source(
    "apps/api/src/db/migrations/0080_team_call_reconciliation.sql",
  );
  const operations = source("apps/api/src/lib/manual-call-operations.ts");
  const action = source("apps/site/src/app/team/actions.ts");
  const panel = source(
    "apps/site/src/app/team/components/CallReconciliationPanel.tsx",
  );

  it("requires a verified human reconciler before parsing or database access", () => {
    const post = route.slice(route.indexOf("export async function POST"));
    const boundary = post.indexOf("beginTeamMutation(request");
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(post).toContain('principalTypes: ["human"]');
    expect(post).toContain('requiredPermissions: ["calls.reconcile"]');
    expect(post).toContain('risk: "normal"');
    expect(post).toContain("requiresIdempotency: true");
    expect(post).toContain('auditAction: "call.reconciled"');
    expect(boundary).toBeLessThan(post.indexOf("request.json()"));
    expect(boundary).toBeLessThan(post.indexOf("getDb()"));
  });

  it("requires typed confirmation, current version, and outcome-specific provider evidence", () => {
    expect(route).toContain('confirmation: z.literal("RECONCILE CALL")');
    expect(route).toContain("requiredIntegerVersion(mutation.expectedVersion)");
    expect(route).toContain("provider_no_matching_call");
    expect(route).toContain(
      "A provider-confirmed call requires a Twilio call SID",
    );
    expect(route).toContain(
      "A confirmed-not-dispatched result requires provider evidence",
    );
    expect(panel).toContain("Do not paste phone numbers");
    expect(route).not.toContain("createTwilioOutboundCall");
  });

  it("commits audit, append-only evidence, resolution link, and idempotency receipt together", () => {
    const transaction = route.slice(route.indexOf("db.transaction(async (tx)"));
    const audit = transaction.indexOf("mutation.audit.insertSuccess(tx");
    const evidence = transaction.indexOf(
      "tx.insert(teamCallOperationReconciliations)",
    );
    const resolution = transaction.indexOf(".update(teamCallOperations)");
    const receipt = transaction.indexOf("completeTeamMutationIdempotency(");
    expect(audit).toBeGreaterThanOrEqual(0);
    expect(evidence).toBeGreaterThan(audit);
    expect(resolution).toBeGreaterThan(evidence);
    expect(receipt).toBeGreaterThan(resolution);
    const safeAudit = transaction.slice(audit, evidence);
    expect(safeAudit).toContain("reasonRecorded: true");
    expect(safeAudit).toContain("reasonLength:");
    expect(safeAudit).not.toContain("reason: parsed.data.reason");
    expect(route).toContain('providerEvidenceSource: "operator_supplied"');
    expect(route).toContain("originalProviderOutcomePreserved: true");
  });

  it("keeps unresolved attempts blocking and preserves original terminal provider evidence", () => {
    expect(operations).toContain("isNull(teamCallOperations.guardReleasedAt)");
    expect(migration).toContain(
      '"state" = \'reconciliation_required\'\n       AND "reconciliation_resolution_id" IS NULL',
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION enforce_team_call_reconciliation_append_only()",
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "team_call_operation_reconciliations"',
    );
    expect(migration).toContain(
      'NEW."provider_operation_id" IS DISTINCT FROM OLD."provider_operation_id"',
    );
    expect(migration).toContain(
      'NEW."provider_status" IS DISTINCT FROM OLD."provider_status"',
    );
    expect(migration).toContain(
      'NEW."failure_detail" IS DISTINCT FROM OLD."failure_detail"',
    );
  });

  it("keeps reconciliation permissioned and validates the committed response", () => {
    const reconciliationAction = action.slice(
      action.indexOf("export async function reconcileManualCallAction"),
      action.indexOf("export async function openContactThreadAction"),
    );
    expect(reconciliationAction).toContain(
      'hasTeamPermission(principal, "calls.reconcile")',
    );
    expect(reconciliationAction).toContain(
      "isManualCallReconciliationSuccess(payload",
    );
    expect(reconciliationAction).toContain('"If-Match": expectedVersion');
    expect(reconciliationAction).toContain(
      '"Idempotency-Key": resolvedIdempotencyKey',
    );
    expect(reconciliationAction).toContain(
      'buildCallReconciliationScope(\n        "manual"',
    );
    expect(reconciliationAction).toContain("callAdminMutationWithSafeReplay");
  });

  it("records additive migration 0080 after the call ledger", () => {
    const journal = JSON.parse(
      source("apps/api/src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<Record<string, unknown>> };
    expect(journal.entries).toContainEqual({
      idx: 77,
      version: "7",
      when: 1787788800000,
      tag: "0080_team_call_reconciliation",
      breakpoints: true,
    });
  });
});
