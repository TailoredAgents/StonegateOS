import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const OUTBOUND_PERMISSIONS = {
  "accounts/backfill": "outbound.write",
  bulk: "outbound.write",
  disposition: "outbound.write",
  draft: "outbound.write",
  import: "outbound.import",
  queue: "outbound.read",
  start: "outbound.write",
} as const;

const PARTNER_PERMISSIONS = {
  checkin: "partners.write",
  referral: "partners.write",
  touch: "partners.write",
} as const;

describe("Outbound and Partners experience contract", () => {
  it("uses the dedicated Outbound permission family at every route", () => {
    for (const [route, permission] of Object.entries(OUTBOUND_PERMISSIONS)) {
      const source = read(`apps/api/app/api/admin/outbound/${route}/route.ts`);
      if (
        route === "import" ||
        route === "start" ||
        route === "bulk" ||
        route === "disposition"
      ) {
        expect(source).toContain("beginTeamMutation(request");
        expect(source).toContain(`requiredPermissions: ["${permission}"]`);
      } else {
        expect(source).toContain(`requirePermission(request, "${permission}")`);
      }
      expect(source).not.toContain('requirePermission(request, "appointments.');
    }
  });

  it("uses method-specific Partner read, write, invite, and rate permissions", () => {
    const operations = read("apps/api/src/lib/partner-operations.ts");
    for (const [route, permission] of Object.entries(PARTNER_PERMISSIONS)) {
      const source = read(`apps/api/app/api/admin/partners/${route}/route.ts`);
      expect(source).toContain("beginTeamMutation(request");
      expect(source).toContain(`requiredPermissions: ["${permission}"]`);
      expect(source).toContain(`"${route}", boundary.mutation`);
      expect(source).not.toContain('requirePermission(request, "appointments.');
    }
    expect(operations).not.toContain(
      'requiredPermissions: ["appointments.write"]',
    );

    const list = read("apps/api/app/api/admin/partners/route.ts");
    const users = read("apps/api/app/api/admin/partners/users/route.ts");
    const rates = read("apps/api/app/api/admin/partners/rates/route.ts");
    expect(list).toContain('requirePermission(request, "partners.read")');
    expect(users).toContain('requirePermission(request, "partners.read")');
    expect(users).toContain('requiredPermissions: ["partners.invite"]');
    expect(rates).toContain('requirePermission(request, "partners.read")');
    expect(rates).toContain("beginTeamMutation(request");
    expect(rates).toContain('requiredPermissions: ["partners.rates"]');
    expect(rates).toContain('risk: "financial"');
    expect(rates).toContain("requiresIdempotency: true");
    expect(`${list}\n${users}\n${rates}`).not.toContain(
      'requirePermission(request, "policy.write")',
    );
  });

  it("replaces negotiated rates through a strict versioned financial receipt", () => {
    const route = read("apps/api/app/api/admin/partners/rates/route.ts");
    const action = read("apps/site/src/app/team/actions.ts");
    const parser = read("apps/site/src/app/team/lib/partner-rate-input.ts");
    expect(route).toContain("readBoundedPartnerJson(");
    expect(route).toContain("parsePartnerRateMutationPayload(");
    expect(route).toContain("assertTeamMutationExpectedVersion(");
    expect(route).toContain("claimTeamMutationIdempotency(");
    expect(route).toContain("mutation.audit.insertSuccess(tx");
    expect(route).toContain("completeTeamMutationIdempotency(");
    expect(action).toContain("parsePartnerRateCsv(csv)");
    expect(action).toContain('"Idempotency-Key": idempotencyKey');
    expect(action).toContain('"If-Match": expectedVersion');
    expect(action).toContain("requireReceipt: true");
    expect(parser).not.toContain("continue;");
    expect(parser).not.toContain("replace(/[^0-9.]/");
  });

  it("fails closed when mutable contact data changes between partner pages", () => {
    const route = read("apps/api/app/api/admin/partners/route.ts");
    expect(route).toContain(
      "set transaction isolation level repeatable read read only",
    );
    expect(route).toContain("gt(contacts.updatedAt, snapshotAt)");
    expect(route).toContain('return { kind: "stale" as const }');
    expect(route).toContain('error: "partner_page_changed"');
  });

  it("makes partner touch, referral, and check-in writes atomic and replay-safe", () => {
    const operations = read("apps/api/src/lib/partner-operations.ts");
    const actions = read("apps/site/src/app/team/actions.ts");
    const partners = read(
      "apps/site/src/app/team/components/PartnersSection.tsx",
    );

    for (const route of Object.keys(PARTNER_PERMISSIONS)) {
      const source = read(`apps/api/app/api/admin/partners/${route}/route.ts`);
      expect(source).toContain("beginTeamMutation(request");
      expect(source).toContain("requiresIdempotency: true");
    }
    expect(operations).toContain("claimTeamMutationIdempotency(");
    expect(operations).toContain("assertTeamMutationExpectedVersion(");
    expect(operations).toContain("db.transaction(async (tx)");
    expect(operations).toContain("completePartnerCheckinTasks(tx");
    expect(operations).toContain("upsertPartnerCheckinTask(tx");
    expect(operations).toContain("mutation.audit.insertSuccess(tx");
    expect(operations).toContain("completeTeamMutationIdempotency(");
    expect(operations).toContain("settleTeamMutationIdempotencyFailure(");
    expect(operations).toContain("MAX_PARTNER_MUTATION_BODY_BYTES");
    expect(actions).toContain('"If-Match": expectedVersion');
    expect(actions).toContain('"Idempotency-Key": idempotencyKey');
    expect(actions).toContain("requireReceipt: true");
    expect(partners).toContain('name="expectedVersion"');
    expect(partners).toContain('name="idempotencyKey"');
    expect(partners).toContain("canWritePartners");
  });

  it("makes portal invitations idempotent, audited, and truthful about provider outcomes", () => {
    const route = read("apps/api/app/api/admin/partners/users/route.ts");
    const actions = read("apps/site/src/app/team/actions.ts");
    const partners = read(
      "apps/site/src/app/team/components/PartnersSection.tsx",
    );
    const manifest = read("apps/api/src/lib/team-route-security-manifest.ts");

    expect(route).toContain("beginTeamMutation(request");
    expect(route).toContain('risk: "external"');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain('auditAction: "partner_user.invited"');
    expect(route).toContain("claimTeamMutationIdempotency(");
    expect(route).toContain("completeTeamMutationIdempotency(");
    expect(route).toContain('"partner_user.invite.attempted"');
    expect(route).toContain('"partner_user.invite.failed"');
    expect(route).toContain('"partner_user.invite.reconciliation_required"');
    expect(route).toContain("providerExactlyOnceClaimed: false");
    expect(route).not.toContain("Promise.allSettled");
    expect(route).not.toContain("// ignore");
    expect(route).not.toContain("resolveRequestOriginBaseUrl");
    expect(actions).toContain('headers: { "Idempotency-Key": idempotencyKey }');
    expect(actions).toContain("parsePartnerInviteSuccess(");
    expect(actions).toContain(
      'response.headers.get("x-operation-state") !== "succeeded"',
    );
    expect(actions).toContain("no success is being claimed");
    expect(actions).not.toContain(
      "The invite completed, but its provider receipt was incomplete",
    );
    expect(actions).toContain("Invite accepted for delivery by");
    expect(partners).toContain('name="idempotencyKey"');
    expect(partners).toContain("acceptance does not guarantee final delivery");
    expect(manifest).toContain(
      '"app/api/admin/partners/users/route.ts#POST": "external"',
    );
  });

  it("rejects more than 2,000 outbound rows instead of silently truncating", () => {
    const route = read("apps/api/app/api/admin/outbound/import/route.ts");
    const parser = read("apps/api/src/lib/outbound-import.ts");
    const client = read(
      "apps/site/src/app/team/components/OutboundImportClient.tsx",
    );
    expect(route).toContain("parseOutboundImportPayload(payload)");
    expect(parser).toContain("OUTBOUND_IMPORT_MAX_ROWS = 2_000");
    expect(parser).toContain(
      "if (dataRecords.length > OUTBOUND_IMPORT_MAX_ROWS)",
    );
    expect(parser).toContain("nothing was imported");
    expect(parser).not.toContain("slice(0, OUTBOUND_IMPORT_MAX_ROWS)");
    expect(client).toContain("Maximum 2,000 data rows");
  });

  it("distinguishes failed queue, directory, portal-user, and rate loads from emptiness", () => {
    const outbound = read(
      "apps/site/src/app/team/components/OutboundSection.tsx",
    );
    const partners = read(
      "apps/site/src/app/team/components/PartnersSection.tsx",
    );

    expect(outbound).toContain("Outbound is temporarily unavailable");
    expect(outbound).toContain(
      "No queue totals or records are being shown as zero",
    );
    expect(outbound).toContain("directoryUnavailable");
    expect(outbound).toContain('role="alert"');
    expect(partners).toContain(
      "This is a load failure, not an empty partner list",
    );
    expect(partners).toContain("portalUsersError");
    expect(partners).toContain("partnerRatesError");
    expect(partners).toContain("saving is disabled until they reload");
    expect(partners).toContain("disabled={Boolean(partnerRatesError)}");
  });
});
