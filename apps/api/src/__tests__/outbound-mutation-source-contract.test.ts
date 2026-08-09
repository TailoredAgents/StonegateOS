import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = process.cwd();
const SITE_ROOT = join(API_ROOT, "../site");

function apiSource(path: string): string {
  return readFileSync(join(API_ROOT, path), "utf8");
}

function siteSource(path: string): string {
  return readFileSync(join(SITE_ROOT, path), "utf8");
}

describe("Outbound mutation production contract", () => {
  const start = apiSource("app/api/admin/outbound/start/route.ts");
  const bulk = apiSource("app/api/admin/outbound/bulk/route.ts");
  const disposition = apiSource("app/api/admin/outbound/disposition/route.ts");
  const contract = apiSource("src/lib/outbound-mutation-contract.ts");
  const transaction = apiSource("src/lib/outbound-mutation-transaction.ts");
  const queue = apiSource("app/api/admin/outbound/queue/route.ts");
  const queueQuery = apiSource("src/lib/outbound-queue-query.ts");
  const actions = siteSource("src/app/team/actions.ts");
  const transport = siteSource("src/app/team/lib/team-mutation-transport.ts");
  const section = siteSource("src/app/team/components/OutboundSection.tsx");
  const parser = siteSource("src/app/team/lib/outbound-mutation-result.ts");

  it.each([
    ["start", start],
    ["bulk", bulk],
    ["disposition", disposition],
  ])(
    "puts verified human authorization before %s body parsing",
    (_name, source) => {
      expect(source).toContain("beginTeamMutation(request");
      expect(source).toContain('principalTypes: ["human"]');
      expect(source).toContain('requiredPermissions: ["outbound.write"]');
      expect(source).toContain("requiresIdempotency: true");
      expect(source.indexOf("beginTeamMutation(request")).toBeLessThan(
        source.indexOf("readOutboundMutationRequest(request"),
      );
      expect(source).not.toContain("isAdminRequest(");
      expect(source).not.toContain("recordAuditEvent(");
      expect(source).not.toContain("request.json()");
    },
  );

  it("uses exact bounded schemas and task versions", () => {
    expect(contract).toContain("OUTBOUND_BULK_MAX_TASKS = 500");
    expect(contract).toContain("OUTBOUND_RECAP_MAX_LENGTH = 4_000");
    expect(contract).toContain("assertExactObject(");
    expect(contract).toContain("unsupported fields");
    expect(contract).toContain("parseOutboundTaskVersion");
    expect(contract).toContain("outboundBulkVersion");
    expect(contract).not.toContain("slice(0, OUTBOUND_BULK_MAX_TASKS)");
    expect(queue).toContain("primaryTaskVersion: item.primaryTaskVersion");
    expect(queueQuery).toContain(
      "primaryTaskVersion: primary.taskVersion.toISOString()",
    );
    expect(queueQuery).toContain("version: row.taskVersion.toISOString()");
  });

  it.each([
    ["start", start],
    ["bulk", bulk],
    ["disposition", disposition],
  ])(
    "claims, replays, audits, receipts, and settles %s atomically",
    (_name, source) => {
      expect(source).toContain("claimTeamMutationIdempotency(");
      expect(source).toContain("teamMutationIdempotencyReplayResponse(");
      expect(source).toContain("runOutboundMutationAtomic(");
      expect(source).toContain("mutation.audit.insertSuccess(tx");
      expect(source).toContain("completeTeamMutationIdempotency(");
      expect(source).toContain("settleTeamMutationIdempotencyFailure(");
      expect(source).toContain('.for("update")');
      expect(source).toContain("eq(crmTasks.updatedAt");
    },
  );

  it("keeps the explicit transaction seam free of hidden fallback success", () => {
    expect(transaction).toContain("return runTransaction(work)");
    expect(transaction).not.toContain("catch");
  });

  it("updates DNC, automation, partner, reminder, and cadence records in disposition", () => {
    expect(disposition).toContain("doNotContact: true");
    expect(disposition).toContain("leadAutomationStates");
    expect(disposition).toContain("resolveOrCreatePartnerAccount(tx");
    expect(disposition).toContain("updatePartnerAccountAfterOutboundTouch(tx");
    expect(disposition).toContain("upsertPartnerCheckinTask(tx");
    expect(disposition).toContain("quarantineTaskReminders(tx");
    expect(disposition).toContain("ensureReminderOutbox(tx");
  });

  it("co-commits a dedicated, attributed partner-conversion audit event", () => {
    expect(disposition).toContain("insertPartnerConversionAudit(");
    expect(disposition).toContain('action: "partner.converted"');
    expect(disposition).toContain('surface: "/team/sales/outbound"');
    expect(disposition).toContain('entityType: "contact"');
    expect(disposition).toContain("correlationId: mutation.correlationId");
    expect(disposition).toContain(
      "idempotencyKeyHash: mutation.idempotencyKeyHash",
    );
    expect(disposition).toContain(
      "previousPartnerStatus: contact.partnerStatus",
    );
    expect(disposition.indexOf("insertPartnerConversionAudit(tx")).toBeLessThan(
      disposition.indexOf(
        "completeTeamMutationIdempotency(",
        disposition.indexOf("insertPartnerConversionAudit(tx"),
      ),
    );
  });

  it("matches structured campaign keys exactly before closing or reusing sibling tasks", () => {
    expect(contract).toContain("export function outboundTaskCampaign(");
    expect(disposition.match(/outboundTaskCampaign\(notes\)/gu)).toHaveLength(
      2,
    );
    expect(disposition).toContain(
      "const campaign = outboundTaskCampaign(originalNotes)",
    );
    expect(disposition).not.toContain("`%campaign=${");
  });

  it("serializes sibling dispositions by contact before any task row lock", () => {
    expect(disposition).toContain("lockDispositionContactScope(");
    expect(disposition).toContain(
      "outbound-disposition:contact:${candidate.contactId}",
    );
    expect(disposition).toContain("pg_advisory_xact_lock(hashtextextended(");

    const transactionBody = disposition.slice(
      disposition.indexOf("async (tx) => {"),
    );
    expect(
      transactionBody.indexOf("lockDispositionContactScope("),
    ).toBeLessThan(transactionBody.indexOf("const [task] = await tx"));
    expect(transactionBody).toContain("task.contactId !== lockedContactId");
  });

  it("makes bulk selection all-or-nothing instead of silently skipping stale rows", () => {
    expect(bulk).toContain("rows.length !== taskIds.length");
    expect(bulk).toContain("requireOutboundExpectedVersion(");
    expect(bulk).toContain("Nothing was changed");
    expect(bulk).toContain("resolveOutboundImportAssignee(tx");
    expect(bulk).not.toContain("snoozeSkippedNotStarted");
  });

  it("sends caller keys and versions and rejects malformed success receipts", () => {
    for (const marker of [
      '"Idempotency-Key": idempotencyKey',
      '"If-Match": expectedVersion',
      '"If-Match": submittedVersion',
      "parseOutboundTaskMutationSuccess(",
      "parseOutboundBulkMutationSuccess(",
    ]) {
      expect(actions).toContain(marker);
    }
    expect(section).toContain('name="expectedVersion"');
    expect(section).toContain('name="idempotencyKey"');
    expect(section).toContain('name="taskRefs"');
    expect(parser).toContain("receipt.entityType === expected.entityType");
    expect(parser).toContain("receipt.entityId === expected.entityId");
    expect(parser).toContain("envelope.receipt.actorId === expected.actorId");
    expect(parser).toContain('expected.disposition === "callback_requested"');
    expect(parser).toContain("nextDueAt !== expected.callbackAt");
    expect(actions).toContain(
      'disposition === "callback_requested" && callbackAt',
    );
    expect(actions).toContain("no success is being claimed");
  });

  it("recovers transport failures with one replay of the same outbound request", () => {
    expect(actions).toContain("callOutboundMutationWithSafeReplay(");
    expect(transport).toContain(
      "createAdminMutationRequest(principal, path, init)",
    );
    expect(
      actions.match(/response = await callOutboundMutationWithSafeReplay\(/gu),
    ).toHaveLength(3);
    expect(
      actions.match(/value: readTeamMutationException\(/gu),
    ).not.toBeNull();
  });
});
