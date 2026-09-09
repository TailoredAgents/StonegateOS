import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, closeDbForTests, partnerAccounts, partnerUsers, partnerAccountMemberships, partnerRoleTemplates, partnerAccountLocations } from "../src/db";
import { hashPartnerPassword } from "../src/lib/partner-password-crypto";

// This fixture is deliberately unusable against production or a non-test database.
async function main() {
const url = new URL(process.env["DATABASE_URL"] ?? "http://invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/portal_rehearsal") throw new Error("Requires the disposable local portal_rehearsal database");
if (process.env["NODE_ENV"] !== "test") throw new Error("Run this fixture with NODE_ENV=test");
const password = "Local browser service test passphrase 2026!";
const passwordHash = await hashPartnerPassword(password);
const db = getDb();
const roles = ["administrator", "operations", "billing_approver", "viewer"];
try {
  const fixture = await db.transaction(async (tx) => {
    const accountId = randomUUID();
    await tx.insert(partnerAccounts).values({ id: accountId, name: "Stonegate local test partner", normalizedName: accountId, status: "portal_partner", portalAccessEnabled: true, source: "local_browser_test" });
    const people = [];
    for (const roleKey of roles) {
      const [role] = await tx.select().from(partnerRoleTemplates).where(and(eq(partnerRoleTemplates.key, roleKey), isNull(partnerRoleTemplates.partnerAccountId), eq(partnerRoleTemplates.active, true))).limit(1);
      if (!role) throw new Error(`Missing canonical role ${roleKey}`);
      const id = randomUUID(), email = `${roleKey}-${accountId}@example.test`;
      await tx.insert(partnerUsers).values({ id, email, normalizedEmail: email, name: `Local ${role.name}`, active: true, identityStatus: "active", emailVerifiedAt: new Date(), passwordHash, passwordSetAt: new Date() });
      await tx.insert(partnerAccountMemberships).values({ partnerAccountId: accountId, partnerUserId: id, roleKey, roleTemplateId: role.id, status: "active", accessLevel: "account", acceptedAt: new Date(), isDefault: true });
      people.push({ role: roleKey, email });
    }
    const locations = await tx.insert(partnerAccountLocations).values(Array.from({ length: 105 }, (_, index) => ({ partnerAccountId: accountId,
      siteName: `Local site ${String(index + 1).padStart(3, "0")}`, addressLine1: `${index + 1} Local Test Way`, city: "Atlanta", state: "GA", postalCode: "30301",
      timezone: "America/New_York", onSiteContact: { name: "Local site contact", phone: "+14045550100", email: "site@example.test" },
    }))).returning({ id: partnerAccountLocations.id, name: partnerAccountLocations.siteName });
    return { accountId, people, lastLocation: locations.at(-1), password };
  });
  process.stdout.write(JSON.stringify(fixture));
} finally { await closeDbForTests(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
