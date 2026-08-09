import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("partner portal authorization and token containment", () => {
  it("binds every login and session path to an active partner organization", () => {
    const source = read("apps/api/src/lib/partner-portal-auth.ts");
    expect(
      source.match(/innerJoin\(contacts/gu)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      source.match(/eq\(contacts\.partnerStatus, "partner"\)/gu)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      source.match(/isNull\(contacts\.deletedAt\)/gu)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(source).toContain('userRow.partnerStatus !== "partner"');
    expect(source).toContain("userRow.orgDeletedAt");
    expect(source).toContain(".set({ revokedAt: now })");
  });

  it("consumes magic links atomically and invalidates earlier unused links", () => {
    const source = read("apps/api/src/lib/partner-portal-auth.ts");
    expect(source).toContain("return db.transaction(async (tx) =>");
    expect(source).toContain('.for("update")');
    expect(
      source.match(/isNull\(partnerLoginTokens\.usedAt\)/gu)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(source).toContain(".returning({ id: partnerLoginTokens.id })");
    expect(source).toContain("if (!consumed?.id) return null");
  });

  it("does not let an invite promote an organization or rewrite pricing", () => {
    const route = read("apps/api/app/api/admin/partners/users/route.ts");
    expect(route).toContain('org.partnerStatus !== "partner"');
    expect(route).not.toContain("ensureBaselineRateCard");
    expect(route).not.toContain("DEFAULT_RATE_ITEMS");
    expect(route).not.toContain('partnerStatus: "partner"');
    expect(route).toContain("replacePartnerLoginTokenInTransaction(tx");
    const tokenHelper = read("apps/api/src/lib/partner-portal-auth.ts");
    expect(tokenHelper).toContain(
      "eq(partnerLoginTokens.partnerUserId, input.partnerUserId)",
    );
    expect(tokenHelper).toContain("isNull(partnerLoginTokens.usedAt)");
  });
});
