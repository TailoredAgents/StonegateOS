import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isActiveStaffAccessApplicationStatus,
  parseStaffAccessApplicationDecision,
  parseStaffAccessApplicationListQuery,
} from "@/lib/partner-access-application-administration";

const REPO_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const source = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("staff Partner Portal access-application inputs", () => {
  it("bounds exact list filters", () => {
    expect(
      parseStaffAccessApplicationListQuery(
        new URLSearchParams("status=active&limit=25&q=Property"),
      ),
    ).toEqual({ status: "active", limit: 25, q: "Property" });
    expect(() =>
      parseStaffAccessApplicationListQuery(
        new URLSearchParams("status=active&limit=101"),
      ),
    ).toThrow("valid page size");
    expect(() =>
      parseStaffAccessApplicationListQuery(
        new URLSearchParams("status=active&status=declined"),
      ),
    ).toThrow("filters are invalid");
    expect(() =>
      parseStaffAccessApplicationListQuery(
        new URLSearchParams("accountId=override"),
      ),
    ).toThrow("filters are invalid");
  });

  it("requires exact, bounded decisions with one explicit launch role and scope", () => {
    expect(
      parseStaffAccessApplicationDecision({
        action: "approve",
        note: null,
        confirmation: "APPROVE",
        roleKey: "administrator",
        accessLevel: "account",
        locationIds: [],
        costCenterIds: [],
      }),
    ).toEqual({
      action: "approve",
      note: null,
      confirmation: "APPROVE",
      roleKey: "administrator",
      accessLevel: "account",
      locationIds: [],
      costCenterIds: [],
    });
    expect(
      parseStaffAccessApplicationDecision({
        action: "approve",
        note: "Limit to the assigned property.",
        confirmation: "APPROVE",
        roleKey: "operations",
        accessLevel: "scoped",
        locationIds: ["11111111-1111-4111-8111-111111111111"],
        costCenterIds: [],
      }).roleKey,
    ).toBe("operations");
    expect(
      parseStaffAccessApplicationDecision({
        action: "needs_information",
        note: "Confirm the legal company name.",
        confirmation: "REQUEST INFORMATION",
      }).action,
    ).toBe("needs_information");
    expect(() =>
      parseStaffAccessApplicationDecision({
        action: "decline",
        note: "Unable to verify the business.",
        confirmation: "DECLINE",
        roleKey: "owner",
      }),
    ).toThrow("unsupported fields");
    expect(() =>
      parseStaffAccessApplicationDecision({
        action: "approve",
        note: null,
        confirmation: "approve",
        roleKey: "administrator",
        accessLevel: "account",
        locationIds: [],
        costCenterIds: [],
      }),
    ).toThrow("Confirm this approval");
    expect(() =>
      parseStaffAccessApplicationDecision({
        action: "approve",
        note: null,
        confirmation: "APPROVE",
        roleKey: "administrator",
        accessLevel: "scoped",
        locationIds: ["11111111-1111-4111-8111-111111111111"],
        costCenterIds: [],
      }),
    ).toThrow("Confirm this approval");
  });

  it("treats only non-final review states as actionable", () => {
    expect(isActiveStaffAccessApplicationStatus("submitted")).toBe(true);
    expect(isActiveStaffAccessApplicationStatus("under_review")).toBe(true);
    expect(isActiveStaffAccessApplicationStatus("needs_information")).toBe(
      true,
    );
    expect(isActiveStaffAccessApplicationStatus("approved")).toBe(false);
    expect(isActiveStaffAccessApplicationStatus("declined")).toBe(false);
    expect(isActiveStaffAccessApplicationStatus("withdrawn")).toBe(false);
  });
});

describe("staff access-application persistence and route contract", () => {
  const migration = source(
    "apps/api/src/db/migrations/0123_partner_access_application_tenant_binding.sql",
  );
  const onboarding = source("apps/api/src/lib/partner-portal-onboarding.ts");
  const listRoute = source(
    "apps/api/app/api/admin/partners/access-applications/route.ts",
  );
  const itemRoute = source(
    "apps/api/app/api/admin/partners/access-applications/[applicationId]/route.ts",
  );
  const portalListRoute = source(
    "apps/api/app/api/portal/v2/access-applications/route.ts",
  );
  const portalItemRoute = source(
    "apps/api/app/api/portal/v2/access-applications/[applicationId]/route.ts",
  );
  const queue = source(
    "apps/site/src/app/team/components/PartnerAccessApplicationsQueue.tsx",
  );

  it("adds an expand-only tenant binding and backfills only an unambiguous generated signature", () => {
    expect(migration).toContain(
      'ADD COLUMN "bootstrap_partner_account_id" uuid',
    );
    expect(migration).toContain('"candidate_count" = 1');
    expect(migration).toContain(
      '"account"."created_at" = "application"."created_at"',
    );
    expect(migration).toContain('"role"."partner_account_id" = "account"."id"');
    expect(migration).toContain(
      "partner_access_applications_approval_tenant_check",
    );
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(onboarding).toContain(
      "bootstrapPartnerAccountId: bootstrapAccountId",
    );
  });

  it("uses staff permission, origin, exact version, durable idempotency, and co-committed audit controls", () => {
    expect(listRoute).toContain('"partners.applications.read"');
    expect(itemRoute).toContain(
      'requiredPermissions: ["partners.applications.read"]',
    );
    expect(itemRoute).toContain('"partners.applications.approve"');
    expect(itemRoute).toContain('"partners.applications.decline"');
    expect(itemRoute).toContain('"partners.applications.review"');
    expect(itemRoute).toContain('risk: "destructive"');
    expect(itemRoute).toContain("beginTeamMutation(");
    expect(itemRoute).toContain("mutation.expectedVersion === null");
    expect(itemRoute).toContain("claimTeamMutationIdempotency");
    expect(itemRoute).toContain("completeTeamMutationIdempotency");
    expect(itemRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(itemRoute).toContain("db.transaction(");
  });

  it("revalidates the exact account, user, contact, generated role, and composite membership before a final decision", () => {
    expect(itemRoute).toContain("application.bootstrapPartnerAccountId");
    expect(itemRoute).toContain(
      'account.source !== "partner_portal_access_application"',
    );
    expect(itemRoute).toContain('account.portalFit !== "application_pending"');
    expect(itemRoute).toContain(
      "portalContact.partnerAccountId !== account.id",
    );
    expect(itemRoute).toContain(
      'user.email.normalize("NFKC").trim().toLowerCase()',
    );
    expect(itemRoute).toContain("user.orgContactId !== portalContact.id");
    expect(itemRoute).toContain(
      "eq(partnerAccountMemberships.partnerAccountId, account.id)",
    );
    expect(itemRoute).toContain(
      "eq(partnerAccountMemberships.partnerUserId, user.id)",
    );
    expect(itemRoute).toContain('membership.roleKey !== "applicant"');
    expect(itemRoute).toContain(
      "applicantRole.partnerAccountId !== account.id",
    );
  });

  it("requires an explicit launch role for joins and a fixed Administrator for new companies", () => {
    const verificationOnboarding = source(
      "apps/api/src/lib/partner-verification-onboarding.ts",
    );
    expect(itemRoute).toContain("decision.roleKey");
    expect(itemRoute).toContain("decision.accessLevel");
    expect(itemRoute).toContain(
      'application.companyResolutionChoice !== "join_existing"',
    );
    expect(verificationOnboarding).toContain("partnerMembershipLocationScopes");
    expect(verificationOnboarding).toContain(
      "partnerMembershipCostCenterScopes",
    );
    expect(verificationOnboarding).not.toContain(".insert(contacts)");
    expect(itemRoute).toContain('eq(partnerRoleTemplates.key, "admin")');
    expect(itemRoute).toContain(
      "isNull(partnerRoleTemplates.partnerAccountId)",
    );
    expect(itemRoute).toContain('roleKey: "admin"');
    expect(itemRoute).not.toContain("mfaRequired");
    expect(itemRoute).not.toContain("mfaEnrolledAt");
    expect(itemRoute).toContain('status: "portal_partner"');
    expect(itemRoute).toContain("commercialConfigurationChanged: false");
    expect(itemRoute).toContain("instantConfirmationGrantedDirectly: false");
    expect(itemRoute).not.toContain("partnerRateCards");
    expect(itemRoute).not.toContain("partnerRateItems");
  });

  it("delivers safe decision status without exposing the staff note outside needs-information", () => {
    expect(onboarding).toContain(
      "informationRequest: partnerAccessApplications.reviewNote",
    );
    expect(portalListRoute).toContain(
      'row.status === "needs_information" ? row.informationRequest : null',
    );
    expect(portalItemRoute).toContain(
      'application.status === "needs_information"',
    );
    expect(itemRoute).toContain("queueAccessDecisionNotifications({");
    expect(itemRoute).toContain("Requested: ${informationRequest}");
    expect(itemRoute).toContain('eventKey: "account_access"');
    expect(itemRoute).toContain(
      "arePartnerPortalOutboundNotificationsEnabled(target.accountId)",
    );
    expect(itemRoute).toContain("queueSystemOutboundMessage({");
  });

  it("makes the bounded queue discoverable and uses deliberate final-decision confirmations", () => {
    expect(queue).toContain("Partner Portal access applications");
    expect(queue).toContain("Type APPROVE");
    expect(queue).toContain("Type DECLINE");
    expect(queue).toContain("Pricing and instant confirmation remain separate");
    expect(queue).toContain("Choose one role");
    expect(queue).toContain('name="accessLevel"');
    expect(queue).toContain("partnerAccessApplicationDecisionAction");
  });
});
