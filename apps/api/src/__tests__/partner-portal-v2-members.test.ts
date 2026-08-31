import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PartnerCapability } from "@/lib/partner-account-authorization";
import {
  createPartnerMemberTargetCondition,
  evaluatePartnerMemberAdministration,
  PartnerMemberMutationSchema,
} from "@/lib/partner-portal-v2-members";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

const ADMIN_CAPABILITIES = [
  "portal.session.read",
  "portal.session.switch_account",
  "account.read",
  "account.members.read",
  "account.members.manage",
] as const satisfies readonly PartnerCapability[];
const OWNER_CAPABILITIES = [
  ...ADMIN_CAPABILITIES,
  "account.security.manage",
  "payments.manage",
  "jobs.read",
] as const satisfies readonly PartnerCapability[];
const VIEWER_CAPABILITIES = [
  "portal.session.read",
  "portal.session.switch_account",
  "account.read",
  "jobs.read",
] as const satisfies readonly PartnerCapability[];

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("partner V2 member administration policy", () => {
  it("rejects self-suspension even when another administrator exists", () => {
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: ADMIN_CAPABILITIES,
        targetPartnerUserId: ACTOR_ID,
        targetStatus: "active",
        targetCapabilities: ADMIN_CAPABILITIES,
        activeAdministratorCount: 2,
        mutation: { action: "suspend" },
        currentRoleKey: "admin",
      }),
    ).toEqual({ allowed: false, reason: "self_suspension" });
  });

  it("protects the last administrator from suspension and demotion", () => {
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: OWNER_CAPABILITIES,
        targetPartnerUserId: TARGET_ID,
        targetStatus: "active",
        targetCapabilities: ADMIN_CAPABILITIES,
        activeAdministratorCount: 1,
        mutation: { action: "suspend" },
        currentRoleKey: "admin",
      }),
    ).toEqual({ allowed: false, reason: "last_administrator" });
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: OWNER_CAPABILITIES,
        targetPartnerUserId: TARGET_ID,
        targetStatus: "active",
        targetCapabilities: ADMIN_CAPABILITIES,
        activeAdministratorCount: 1,
        mutation: { action: "role_update", roleKey: "viewer" },
        proposedCapabilities: VIEWER_CAPABILITIES,
        currentRoleKey: "admin",
      }),
    ).toEqual({ allowed: false, reason: "last_administrator" });
  });

  it("allows the final administrator to switch to another managing role", () => {
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: OWNER_CAPABILITIES,
        targetPartnerUserId: ACTOR_ID,
        targetStatus: "active",
        targetCapabilities: OWNER_CAPABILITIES,
        activeAdministratorCount: 1,
        mutation: { action: "role_update", roleKey: "admin" },
        proposedCapabilities: ADMIN_CAPABILITIES,
        currentRoleKey: "owner",
      }),
    ).toEqual({ allowed: true });
  });

  it("prevents an administrator from assigning or controlling higher authority", () => {
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: ADMIN_CAPABILITIES,
        targetPartnerUserId: TARGET_ID,
        targetStatus: "active",
        targetCapabilities: VIEWER_CAPABILITIES,
        activeAdministratorCount: 2,
        mutation: { action: "role_update", roleKey: "owner" },
        proposedCapabilities: OWNER_CAPABILITIES,
        currentRoleKey: "viewer",
      }),
    ).toEqual({ allowed: false, reason: "privilege_escalation" });
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: ADMIN_CAPABILITIES,
        targetPartnerUserId: TARGET_ID,
        targetStatus: "active",
        targetCapabilities: OWNER_CAPABILITIES,
        activeAdministratorCount: 2,
        mutation: { action: "suspend" },
        currentRoleKey: "owner",
      }),
    ).toEqual({ allowed: false, reason: "privilege_escalation" });
  });

  it("rejects invalid and no-op transitions", () => {
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: OWNER_CAPABILITIES,
        targetPartnerUserId: TARGET_ID,
        targetStatus: "suspended",
        targetCapabilities: VIEWER_CAPABILITIES,
        activeAdministratorCount: 1,
        mutation: { action: "suspend" },
        currentRoleKey: "viewer",
      }),
    ).toEqual({ allowed: false, reason: "invalid_transition" });
    expect(
      evaluatePartnerMemberAdministration({
        actorPartnerUserId: ACTOR_ID,
        actorCapabilities: OWNER_CAPABILITIES,
        targetPartnerUserId: TARGET_ID,
        targetStatus: "active",
        targetCapabilities: VIEWER_CAPABILITIES,
        activeAdministratorCount: 1,
        mutation: { action: "role_update", roleKey: "viewer" },
        proposedCapabilities: VIEWER_CAPABILITIES,
        currentRoleKey: "viewer",
      }),
    ).toEqual({ allowed: false, reason: "no_change" });
  });

  it("accepts only bounded, exact mutation payloads", () => {
    expect(
      PartnerMemberMutationSchema.safeParse({
        action: "role_update",
        roleKey: "scheduler",
      }).success,
    ).toBe(true);
    expect(
      PartnerMemberMutationSchema.safeParse({
        action: "suspend",
        roleKey: "owner",
      }).success,
    ).toBe(false);
    expect(
      PartnerMemberMutationSchema.safeParse({
        action: "role_update",
        roleKey: "../../owner",
      }).success,
    ).toBe(false);
  });

  it("binds every target lookup to both account and opaque membership ID", () => {
    const dialect = new PgDialect();
    const condition = dialect.sqlToQuery(
      createPartnerMemberTargetCondition(ACTOR_ID, TARGET_ID),
    );
    expect(condition.sql).toContain(
      '"partner_account_memberships"."partner_account_id"',
    );
    expect(condition.sql).toContain('"partner_account_memberships"."id"');
    expect(condition.params).toEqual([TARGET_ID, ACTOR_ID]);
  });
});

describe("partner V2 member route security contract", () => {
  const listRoute = source("apps/api/app/api/portal/v2/members/route.ts");
  const mutationRoute = source(
    "apps/api/app/api/portal/v2/members/[membershipId]/route.ts",
  );
  const service = source("apps/api/src/lib/partner-portal-v2-members.ts");

  it("requires account capabilities, MFA-backed management, and write controls", () => {
    expect(listRoute).toContain('"account.members.read"');
    expect(mutationRoute).toContain('"account.members.manage"');
    expect(mutationRoute).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(mutationRoute).toContain("readPortalV2IdempotencyKey");
    expect(mutationRoute).toContain('request.headers.get("if-match")');
    expect(mutationRoute).toContain('action: "partner_member_management"');
    expect(mutationRoute).toContain("arePartnerPortalV2WritesEnabled");
    expect(mutationRoute).toContain("hasPartnerAccountMember");
    expect(mutationRoute.indexOf("await hasPartnerAccountMember")).toBeLessThan(
      mutationRoute.lastIndexOf("readPortalV2IdempotencyKey"),
    );
  });

  it("scopes target reads and writes to the selected account and returns opaque misses", () => {
    expect(service).toContain(
      "createPartnerMemberTargetCondition(accountId, input.membershipId)",
    );
    expect(service).toContain(
      "createPartnerMemberTargetCondition(accountId, target.id)",
    );
    expect(service).toContain(
      '{ status: 404, body: { ok: false, error: "not_found" } }',
    );
    expect(service).toContain('.for("update")');
  });

  it("advertises invitations only through the separate capability-derived lifecycle", () => {
    expect(listRoute).toContain('principal.capabilities.includes("account.members.manage")');
    expect(listRoute).not.toContain("sendEmail");
    expect(listRoute).not.toContain("sendSms");
    expect(mutationRoute).not.toContain("invite");
  });

  it("records account, actor, permission, target, and idempotency evidence", () => {
    expect(service).toContain(
      'requiredPermissions: ["account.members.manage"]',
    );
    expect(service).toContain('entityType: "partner_account_membership"');
    expect(service).toContain("idempotencyKeyHash: input.idempotencyKeyHash");
    expect(service).toContain("partnerAccountId: accountId");
  });
});
