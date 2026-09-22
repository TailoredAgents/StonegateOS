import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  getDb,
  partnerAccounts,
  partnerBookings,
} from "../src/db";

async function main() {
  const url = new URL(process.env["DATABASE_URL"] ?? "http://invalid");
  const accountId = process.env["PARTNER_BROWSER_ACCOUNT_ID"] ?? "";
  if (
    process.env["NODE_ENV"] !== "test" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname !== "/portal_rehearsal" ||
    !/^[0-9a-f-]{36}$/u.test(accountId)
  ) {
    throw new Error(
      "Requires an explicitly selected disposable local browser fixture",
    );
  }
  const db = getDb();
  try {
    const result = await db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(partnerAccounts)
        .where(eq(partnerAccounts.id, accountId));
      if (account?.source !== "local_browser_test")
        throw new Error("Not a local browser fixture");
      const [existing] = await tx
        .select({ id: partnerBookings.id })
        .from(partnerBookings)
        .where(
          and(
            eq(partnerBookings.partnerAccountId, accountId),
            eq(partnerBookings.poNumber, "LOCAL-HISTORY-105"),
          ),
        );
      if (existing) return { accountId, oldestJobId: existing.id };
      const [template] = await tx
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.partnerAccountId, accountId))
        .orderBy(asc(partnerBookings.createdAt))
        .limit(1);
      if (!template?.appointmentId)
        throw new Error("Run the real request journey before seeding history");
      const [operational] = await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, template.appointmentId));
      if (!operational || operational.partnerAccountId !== accountId)
        throw new Error("Fixture job account mismatch");
      let oldestJobId = "";
      for (let index = 1; index <= 105; index++) {
        const appointmentId = randomUUID(),
          jobId = randomUUID();
        const createdAt = new Date(Date.now() - (index + 1) * 86_400_000);
        await tx.insert(appointments).values({
          id: appointmentId,
          contactId: operational.contactId,
          propertyId: operational.propertyId,
          partnerAccountId: accountId,
          type: "job",
          status: "requested",
          startAt: null,
          rescheduleToken: randomUUID().replaceAll("-", ""),
          createdAt,
        });
        await tx.insert(partnerBookings).values({
          id: jobId,
          appointmentId,
          orgContactId: template.orgContactId,
          propertyId: template.propertyId,
          partnerAccountId: accountId,
          partnerUserId: template.partnerUserId,
          requestedByMembershipId: template.requestedByMembershipId,
          serviceKey: "service_request",
          publicStatus: "under_review",
          confirmationMode: "review",
          scopeSnapshot: template.scopeSnapshot,
          proofRequirementsSnapshot: template.proofRequirementsSnapshot,
          poNumber: `LOCAL-HISTORY-${String(index).padStart(3, "0")}`,
          createdAt,
        });
        oldestJobId = jobId;
      }
      return { accountId, oldestJobId };
    });
    process.stdout.write(JSON.stringify(result));
  } finally {
    await closeDbForTests();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
