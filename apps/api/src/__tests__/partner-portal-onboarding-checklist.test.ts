import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("durable partner onboarding checklist", () => {
  const route = source("app/api/portal/v2/onboarding-checklist/route.ts");
  const schema = source("src/db/schema.ts");
  const overview = source(
    "../site/src/app/partners/(portal)/overview/page.tsx",
  );
  const component = source(
    "../site/src/app/partners/components/PartnerOnboardingChecklist.tsx",
  );
  const legacyAuthBridge = source("../site/src/app/partners/auth/route.ts");

  it("persists bounded versioned membership progress instead of query state", () => {
    expect(schema).toContain("onboardingChecklist?: {");
    expect(schema).toContain("version: 1;");
    expect(schema).toContain('      | "first_location"');
    expect(schema).toContain('      | "billing_details"');
    expect(overview).not.toContain(
      "searchParams?: Promise<{ setup?: string }>",
    );
    expect(overview).not.toContain("params.setup");
    expect(legacyAuthBridge).not.toContain('searchParams.set("setup"');
  });

  it("account-binds reads and revision-safe self-progress mutations", () => {
    expect(route).toContain(
      'requirePartnerCapability(request, "account.read")',
    );
    expect(route).toContain('principal.roleKey !== "administrator"');
    expect(route).toContain("{ ok: true, checklist: null, applicable: false }");
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin(request)");
    expect(route).toContain("arePartnerPortalV2ReadsEnabled");
    expect(route).toContain("arePartnerPortalV2WritesEnabled");
    expect(route).toContain("partnerAccountMemberships.partnerAccountId");
    expect(route).toContain("partnerAccountMemberships.partnerUserId");
    expect(route).toContain('.for("update")');
    expect(route).toContain("evaluatePortalV2RevisionPrecondition");
    expect(route).toContain("createPortalV2StrongEtag");
    expect(route).toContain('action: "partner.onboarding_checklist.updated"');
  });

  it("derives resource-backed steps and refuses false completion", () => {
    expect(route).toContain("partnerAccountLocations.active");
    expect(route).toContain(
      'inArray(partnerAccountMemberships.status, ["active", "invited"])',
    );
    expect(route).toContain("partnerEvidenceRequirements.partnerBookingId");
    expect(route).toContain(
      'parsed.data.step === "first_location" && !facts.hasLocation',
    );
    expect(route).toContain(
      'parsed.data.step === "teammates" && !facts.hasTeammate',
    );
    expect(route).toContain('"checklist_step_incomplete"');
  });

  it("renders accessible durable progress and refreshes after linked setup work", () => {
    expect(overview).toContain("<PartnerOnboardingChecklist");
    expect(component).toContain('role="progressbar"');
    expect(component).toContain("aria-valuenow={checklist.completedCount}");
    expect(component).toContain('headers: { "If-Match": etag }');
    expect(component).toContain('document.addEventListener("visibilitychange"');
    expect(component).toContain("Mark reviewed");
  });
});
