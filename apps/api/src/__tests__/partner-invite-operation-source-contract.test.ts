import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("partner invite durable operation source contract", () => {
  const migration = source(
    "apps/api/src/db/migrations/0084_partner_invite_operations.sql",
  );
  const reconciliationMigration = source(
    "apps/api/src/db/migrations/0086_partner_invite_reconciliation.sql",
  );
  const journal = JSON.parse(
    source("apps/api/src/db/migrations/meta/_journal.json"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const schema = source("apps/api/src/db/schema.ts");
  const inviteRoute = source("apps/api/app/api/admin/partners/users/route.ts");
  const publicLoginRoute = source(
    "apps/api/app/api/public/partners/request-link/route.ts",
  );
  const deleteRoute = source(
    "apps/api/app/api/admin/contacts/[contactId]/route.ts",
  );
  const helper = source("apps/api/src/lib/partner-invite-operations.ts");
  const recovery = source("apps/api/src/lib/partner-invite-recovery.ts");
  const worker = source("scripts/outbox-worker.ts");
  const reconciliationRoute = source(
    "apps/api/app/api/admin/partners/invite-operations/route.ts",
  );

  it("registers migration 0084 and the typed durable ledger", () => {
    expect(journal.entries).toContainEqual({
      idx: 81,
      version: "7",
      when: 1788134400000,
      tag: "0084_partner_invite_operations",
      breakpoints: true,
    });
    expect(schema).toContain("export const partnerInviteOperations = pgTable(");
    expect(migration).toContain('CREATE TABLE "partner_invite_operations"');
    expect(migration).toContain("ON DELETE RESTRICT");
  });

  it("guards unresolved targets independently of actor and caller key", () => {
    expect(migration).toContain(
      '"partner_invite_operations_unresolved_target_key"',
    );
    expect(migration).toContain(
      "WHERE \"state\" IN ('requested', 'dispatched', 'reconciliation_required')",
    );
    expect(inviteRoute).toContain(
      "new PartnerInviteUnresolvedFailure(unresolved.state)",
    );
    expect(inviteRoute).toContain("partnerInviteSemanticHash({");
  });

  it("registers the append-only operator resolution and releases only a reviewed guard", () => {
    expect(journal.entries).toContainEqual({
      idx: 83,
      version: "7",
      when: 1788307200000,
      tag: "0086_partner_invite_reconciliation",
      breakpoints: true,
    });
    expect(reconciliationMigration).toContain(
      'ADD COLUMN "resolution_audit_event_id"',
    );
    expect(reconciliationMigration).toContain('AND "resolved_at" IS NULL');
    expect(reconciliationMigration).toContain(
      "partner_invite_operation_terminal_immutable",
    );
    expect(reconciliationRoute).toContain(
      'confirmation: z.enum(["CONFIRM SENT",',
    );
    expect(reconciliationRoute).toContain("reviewedChannels");
    expect(reconciliationRoute).toContain("providerCalled: false");
    expect(reconciliationRoute).toContain(
      'ignoredPermissionKillSwitches: ["external_sends"]',
    );
    expect(reconciliationRoute).not.toContain("sendEmailMessage");
    expect(reconciliationRoute).not.toContain("sendSmsMessage");
  });

  it("commits dispatched evidence before executing either provider", () => {
    const requestedInsert = inviteRoute.indexOf(
      "await tx.insert(partnerInviteOperations).values({",
    );
    const dispatchCommit = inviteRoute.indexOf(
      "await markPartnerInviteDispatched(db, mutation",
    );
    const emailDispatch = inviteRoute.indexOf("sendEmailMessage(email");
    const smsDispatch = inviteRoute.indexOf("sendSmsMessage(phoneE164");

    expect(requestedInsert).toBeGreaterThan(-1);
    expect(dispatchCommit).toBeGreaterThan(requestedInsert);
    expect(emailDispatch).toBeGreaterThan(dispatchCommit);
    expect(smsDispatch).toBeGreaterThan(dispatchCommit);
    expect(inviteRoute).toContain('action: "partner_user.invite.dispatched"');
  });

  it("extends the caller lease before durable preparation and provider work", () => {
    const extension = inviteRoute.indexOf(
      "await extendTeamMutationIdempotencyLease(",
    );
    const requestedInsert = inviteRoute.indexOf(
      "await tx.insert(partnerInviteOperations).values({",
    );
    const emailDispatch = inviteRoute.indexOf("sendEmailMessage(email");
    expect(extension).toBeGreaterThan(-1);
    expect(extension).toBeLessThan(requestedInsert);
    expect(extension).toBeLessThan(emailDispatch);
    expect(
      inviteRoute.match(/extendTeamMutationIdempotencyLease\(/gu),
    ).toHaveLength(2);
    expect(inviteRoute).toContain("INVITE_IDEMPOTENCY_LEASE_MS");
  });

  it("bounds and audits the high-risk request before parsing business input", () => {
    const postStart = inviteRoute.indexOf("export async function POST(");
    const bodyRead = inviteRoute.indexOf(
      "await readBoundedJsonRequest(request",
      postStart,
    );
    const databaseOpen = inviteRoute.indexOf("db = getDb()", postStart);
    expect(postStart).toBeGreaterThan(-1);
    expect(bodyRead).toBeGreaterThan(-1);
    expect(bodyRead).toBeLessThan(databaseOpen);
    expect(inviteRoute).toContain("INVITE_BODY_MAXIMUM_BYTES");
    expect(inviteRoute).toContain("INVITE_BODY_DEADLINE_MS");
    expect(inviteRoute).toContain("hasExactInviteKeys(candidate)");
    expect(inviteRoute).toContain("recordTeamMutationFailure(mutation");
  });

  it("enforces append-only lifecycle transitions and terminal evidence", () => {
    expect(migration).toContain("enforce_partner_invite_operation_transition");
    expect(migration).toContain(
      "partner_invite_operation_invalid_requested_transition",
    );
    expect(migration).toContain(
      "partner_invite_operation_invalid_dispatched_transition",
    );
    expect(migration).toContain("partner_invite_operation_terminal_immutable");
    expect(migration).toContain('BEFORE DELETE ON "partner_invite_operations"');
    expect(migration).toContain(
      'BEFORE TRUNCATE ON "partner_invite_operations"',
    );
    expect(inviteRoute).toContain("planPartnerInviteTerminal(");
    expect(inviteRoute).toContain("providerOperationIds:");
  });

  it("makes contact recovery block ambiguity and quarantine only pre-dispatch work", () => {
    expect(deleteRoute).toContain('operation.state === "dispatched" ||');
    expect(deleteRoute).toContain(
      'operation.state === "reconciliation_required"',
    );
    expect(deleteRoute).toContain('action: "partner_user.invite.quarantined"');
    expect(deleteRoute).toContain(
      '"contact_soft_deleted_before_provider_dispatch"',
    );
    expect(deleteRoute).toContain("requestedPartnerInvitesQuarantinedCount");
  });

  it("exposes primitives for the public known-user login-link route", () => {
    expect(helper).toContain('| "public_login_link"');
    expect(helper).toContain("partnerInviteProviderRequestKey");
    expect(helper).toContain("planPartnerInviteTerminal");
    expect(schema).toContain(
      "sql`${table.operationKind} IN ('team_invite', 'public_login_link')`",
    );
    expect(schema).toContain("partner_invite_operations_public_request_key");
    expect(publicLoginRoute).toContain('operationKind: "public_login_link"');
    expect(publicLoginRoute).toContain('initiatorType: "public_request"');
    expect(publicLoginRoute).toContain(
      "isPartnerInviteUnresolvedState(unresolved.state)",
    );
  });

  it("shares lifecycle transitions across team and public callers", () => {
    for (const route of [inviteRoute, publicLoginRoute]) {
      expect(route).toContain("transitionPartnerInviteOperationToDispatched");
      expect(route).toContain("transitionPartnerInviteOperationToTerminal");
      expect(route).toContain("capturePartnerInviteProviderResult");
      expect(route).toContain("planPartnerInviteTerminal");
    }
    expect(publicLoginRoute).toContain(
      "replacePartnerLoginTokenInTransaction(tx",
    );
    expect(
      publicLoginRoute.indexOf("markPublicPartnerLoginLinkDispatched("),
    ).toBeLessThan(
      publicLoginRoute.indexOf("sendEmailMessage(prepared!.user.email"),
    );
  });

  it("recovers crashes for both callers without automatically replaying providers", () => {
    expect(recovery).toContain('operation.state === "requested"');
    expect(recovery).toContain('operation.state === "dispatched"');
    expect(recovery).toContain(
      "transitionPartnerInviteOperationToQuarantinedFailure",
    );
    expect(recovery).toContain("transitionPartnerInviteOperationToTerminal");
    expect(recovery).toContain("automaticProviderRetryAttempted: false");
    expect(recovery).not.toContain("sendEmailMessage");
    expect(recovery).not.toContain("sendSmsMessage");
    expect(worker).toContain("runPartnerInviteRecoveryOnce");
    expect(worker).toContain("PARTNER_INVITE_RECOVERY_INTERVAL_MS");
    for (const route of [inviteRoute, publicLoginRoute, deleteRoute]) {
      expect(route).toContain("isNull(partnerInviteOperations.resolvedAt)");
    }
  });
});
