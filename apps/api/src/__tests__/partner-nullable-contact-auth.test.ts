import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("nullable CRM projection for canonical partner identities", () => {
  it("keeps contact linkage nullable across canonical authentication results", () => {
    const auth = source("src/lib/partner-portal-auth.ts");
    expect(
      auth.match(/orgContactId: string \| null;/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
    expect(auth).not.toContain("orgContactId: userRow.orgContactId!");
    expect(auth).not.toContain("orgContactId: candidate.orgContactId!");
  });

  it("fails contact-scoped compatibility delivery closed without inventing a contact", () => {
    const publicLink = source(
      "app/api/public/partners/request-link/route.ts",
    );
    const accessDecision = source(
      "app/api/admin/partners/access-applications/[applicationId]/route.ts",
    );
    const legacyUsers = source("app/api/admin/partners/users/route.ts");

    expect(publicLink).toContain(
      "if (!user?.id || !user.orgContactId) return null;",
    );
    expect(accessDecision).toContain("userContactId: string | null;");
    expect(accessDecision).toContain("!target.userContactId");
    expect(accessDecision).not.toContain(
      "account.portalContactId !== user.orgContactId",
    );
    expect(legacyUsers).toContain("if (!updated?.orgContactId)");
    expect(legacyUsers).toContain("if (!created?.orgContactId)");
    expect(legacyUsers).not.toContain("as PartnerInviteUser");
  });

  it("allows account-native join decisions while suppressing only contact-scoped email", () => {
    const joinAdministration = source(
      "src/lib/partner-company-join-administration.ts",
    );
    expect(joinAdministration).toContain("userContactId: string | null;");
    expect(joinAdministration).toContain("if (!input.userContactId)");
    expect(joinAdministration.indexOf("if (!input.userContactId)")).toBeLessThan(
      joinAdministration.indexOf("contactId: input.userContactId"),
    );
  });
});
