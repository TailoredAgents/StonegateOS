import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FIXED_PARTNER_APPROVER_CAPABILITIES,
  MAX_ACTIVE_PARTNER_APPROVAL_RULES,
  normalizeStaffPartnerApprovalRuleValues,
} from "@/lib/partner-approval-rule-administration";
import { parsePartnerApprovalRuleConditions } from "@/lib/partner-portal-v2-approvals";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("Partner approval-rule administration", () => {
  it("normalizes only canonical launch conditions and fixes decision authority", () => {
    const values = normalizeStaffPartnerApprovalRuleValues({
      name: "  Large project approval  ",
      conditions: {
        serviceKeys: ["junk-removal"],
        locationIds: ["11111111-1111-4111-8111-111111111111"],
        minimumAmountMinor: 50_000,
        maximumAmountMinor: 500_000,
        requesterRoleKeys: ["operations"],
        poNumberState: "present",
        costCenterState: "missing",
      },
      requiredDecisionCount: 2,
      active: true,
    });

    expect(values).toEqual({
      name: "Large project approval",
      conditions: {
        serviceKeys: ["junk-removal"],
        locationIds: ["11111111-1111-4111-8111-111111111111"],
        minimumAmountMinor: 50_000,
        maximumAmountMinor: 500_000,
        requesterRoleKeys: ["operations"],
        poNumberState: "present",
        costCenterState: "missing",
      },
      requiredDecisionCount: 2,
      active: true,
    });
    expect(FIXED_PARTNER_APPROVER_CAPABILITIES).toEqual(["approvals.decide"]);
    expect(MAX_ACTIVE_PARTNER_APPROVAL_RULES).toBe(50);
  });

  it("exports the fail-closed condition parser while rejecting staff aliases", () => {
    expect(
      parsePartnerApprovalRuleConditions({
        serviceKey: "junk-removal",
        minimumAmountCents: 5_000,
      }),
    ).toEqual({
      serviceKeys: ["junk-removal"],
      minimumAmountMinor: 5_000,
    });

    expect(() =>
      normalizeStaffPartnerApprovalRuleValues({
        name: "Legacy alias",
        conditions: { serviceKey: "junk-removal" },
        requiredDecisionCount: 1,
        active: true,
      }),
    ).toThrow("conditions are invalid");
    expect(() =>
      normalizeStaffPartnerApprovalRuleValues({
        name: "Invalid range",
        conditions: {
          minimumAmountMinor: 10_000,
          maximumAmountMinor: 9_999,
        },
        requiredDecisionCount: 1,
        active: true,
      }),
    ).toThrow("conditions are invalid");
    expect(() =>
      normalizeStaffPartnerApprovalRuleValues({
        name: "Unsupported role",
        conditions: { requesterRoleKeys: ["owner"] },
        requiredDecisionCount: 1,
        active: true,
      }),
    ).toThrow("conditions are invalid");
  });

  it("implements one account-locked create/update/deactivate service with CAS and no delete", () => {
    const service = source("src/lib/partner-approval-rule-administration.ts");
    expect(service).toContain('.for("update")');
    expect(service).toContain("MAX_ACTIVE_PARTNER_APPROVAL_RULES = 50");
    expect(service).toContain("assertTeamMutationExpectedVersion");
    expect(service).toContain("updatedByTeamMemberId: input.teamMemberId");
    expect(service).toContain("createdByTeamMemberId: input.teamMemberId");
    expect(service).toContain(
      "requiredApproverCapabilities: [...FIXED_PARTNER_APPROVER_CAPABILITIES]",
    );
    expect(service).not.toContain("deletePartnerApprovalRule");
    expect(service).not.toMatch(/\.delete\(partnerApprovalRules\)/u);
  });

  it("secures account-scoped administration routes and exposes no hard delete", () => {
    const collectionRoute = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/approval-rules/route.ts",
    );
    const itemRoute = source(
      "app/api/admin/partner-management/v1/accounts/[accountId]/approval-rules/[ruleId]/route.ts",
    );

    expect(collectionRoute).toContain('"partners.commercial.read"');
    expect(collectionRoute).toContain(
      'requiredPermissions: ["partners.commercial.manage"]',
    );
    expect(itemRoute).toContain('"partners.commercial.read"');
    expect(itemRoute).toContain(
      'requiredPermissions: ["partners.commercial.manage"]',
    );
    for (const route of [collectionRoute, itemRoute]) {
      expect(route).toContain('risk: "financial"');
      expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
      expect(route).toContain("claimTeamMutationIdempotency");
      expect(route).toContain("rejectDuplicateObjectKeys: true");
      expect(route).toContain("mutation.audit.insertSuccess");
      expect(route).not.toMatch(/export async function DELETE/u);
    }
    expect(itemRoute).toContain("mutation.expectedVersion");
    expect(itemRoute).toContain("updatePartnerApprovalRuleAsStaff");
    expect(collectionRoute).toContain("createPartnerApprovalRuleAsStaff");
    expect(collectionRoute).toContain("status: 404");
    expect(itemRoute).toContain("status: 404");
  });

  it("adds provenance, fixed authority, and immutable captured evidence in migration 0150", () => {
    const migration = source(
      "src/db/migrations/0150_partner_approval_rule_administration.sql",
    );
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    expect(migration).toContain('ADD COLUMN "created_by_team_member_id"');
    expect(migration).toContain(
      'ALTER COLUMN "created_by_membership_id" DROP NOT NULL',
    );
    expect(migration).toContain("num_nonnulls(");
    expect(migration).toContain("ARRAY['approvals.decide']::text[]");
    expect(migration).toContain(
      'CREATE TRIGGER "partner_approval_requests_evidence_immutable"',
    );
    expect(migration).toContain(
      'NEW."rule_snapshot" IS DISTINCT FROM OLD."rule_snapshot"',
    );
    expect(migration).toContain(
      'NEW."request_snapshot" IS DISTINCT FROM OLD."request_snapshot"',
    );
    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        tag: "0150_partner_approval_rule_administration",
      }),
    );
  });
});
