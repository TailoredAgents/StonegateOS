import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerBookings,
  payments,
  properties,
} from "@/db";
import {
  listPartnerAdditionalServiceLinks,
  loadPartnerAdditionalServiceSource,
} from "@/lib/partner-additional-service";
import type { PartnerJobAuthorizationPrincipal } from "@/lib/partner-portal-v2-resource-authorization";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const databaseUrl = process.env["DATABASE_URL"];
const suite =
  databaseUrl &&
  ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)
    ? describe
    : describe.skip;
async function rollbackTest(
  run: (tx: TeamMutationTransaction) => Promise<void>,
) {
  const rollback = new Error("additional_service_test_rollback");
  try {
    await getDb().transaction(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
async function account(tx: TeamMutationTransaction) {
  const id = randomUUID();
  await tx
    .insert(partnerAccounts)
    .values({
      id,
      name: "Local linked service " + id,
      normalizedName: id,
      portalAccessEnabled: true,
    });
  const contactId = randomUUID();
  await tx
    .insert(contacts)
    .values({
      id: contactId,
      firstName: "Local",
      lastName: "Service",
      email: contactId + "@example.test",
    });
  return { id, contactId };
}
async function location(
  tx: TeamMutationTransaction,
  company: Awaited<ReturnType<typeof account>>,
) {
  const propertyId = randomUUID(),
    locationId = randomUUID();
  await tx
    .insert(properties)
    .values({
      id: propertyId,
      contactId: company.contactId,
      addressLine1: "1 Local Test Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
  await tx
    .insert(partnerAccountLocations)
    .values({
      id: locationId,
      partnerAccountId: company.id,
      propertyId,
      siteName: "Local site",
      addressLine1: "1 Local Test Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
  return { propertyId, locationId };
}
async function job(
  tx: TeamMutationTransaction,
  company: Awaited<ReturnType<typeof account>>,
  site: Awaited<ReturnType<typeof location>>,
  originalJobId: string | null = null,
  createdAt = new Date(),
) {
  const id = randomUUID(),
    appointmentId = randomUUID();
  await tx
    .insert(appointments)
    .values({
      id: appointmentId,
      partnerAccountId: company.id,
      contactId: company.contactId,
      propertyId: site.propertyId,
      type: "job",
      status: "requested",
      rescheduleToken: randomUUID(),
    });
  await tx
    .insert(partnerBookings)
    .values({
      id,
      partnerAccountId: company.id,
      orgContactId: company.contactId,
      appointmentId,
      propertyId: site.propertyId,
      publicStatus: "under_review",
      additionalServiceFromPartnerBookingId: originalJobId,
      createdAt,
    });
  return { id, appointmentId };
}
function principal(
  accountId: string,
  locationIds?: string[],
): PartnerJobAuthorizationPrincipal {
  return {
    accountId,
    accessLevel: locationIds ? "scoped" : "account",
    accessScope: locationIds ? { locationIds } : {},
  };
}

suite("additional-service read authorization / real PostgreSQL", () => {
  afterAll(async () => closeDbForTests());
  it("qualifies completed, finalized and canonically settled jobs without exposing payment fields", async () =>
    rollbackTest(async (tx) => {
      const company = await account(tx),
        site = await location(tx, company),
        source = await job(tx, company, site);
      const actor = principal(company.id);
      const read = () =>
        loadPartnerAdditionalServiceSource(tx, actor, source.id);
      expect((await read())?.eligible).toBe(false);
      await tx
        .insert(payments)
        .values({
          appointmentId: source.appointmentId,
          provider: "square",
          amount: 100,
          currency: "USD",
          status: "COMPLETED",
          canonicalStatus: "pending",
        });
      expect((await read())?.eligible).toBe(false);
      await tx
        .update(payments)
        .set({ canonicalStatus: "completed" })
        .where(eq(payments.appointmentId, source.appointmentId));
      const settled = await read();
      expect(settled?.eligible).toBe(true);
      expect(Object.keys(settled!).sort()).toEqual([
        "eligible",
        "id",
        "locationId",
        "propertyId",
        "status",
      ]);
      await tx
        .update(payments)
        .set({ canonicalStatus: "refunded" })
        .where(eq(payments.appointmentId, source.appointmentId));
      expect((await read())?.eligible).toBe(false);
      await tx
        .update(appointments)
        .set({ finalTotalCents: 0 })
        .where(eq(appointments.id, source.appointmentId));
      expect((await read())?.eligible).toBe(true);
      await tx
        .update(appointments)
        .set({ finalTotalCents: null, status: "completed" })
        .where(eq(appointments.id, source.appointmentId));
      expect((await read())?.eligible).toBe(true);
      await tx
        .update(appointments)
        .set({ status: "confirmed" })
        .where(eq(appointments.id, source.appointmentId));
      await tx
        .update(partnerBookings)
        .set({ publicStatus: "completed" })
        .where(eq(partnerBookings.id, source.id));
      expect((await read())?.eligible).toBe(true);
    }));
  it("does not authorize foreign, missing or out-of-scope source jobs", async () =>
    rollbackTest(async (tx) => {
      const company = await account(tx),
        site = await location(tx, company),
        otherSite = await location(tx, company),
        source = await job(tx, company, site);
      expect(
        await loadPartnerAdditionalServiceSource(
          tx,
          principal(randomUUID()),
          source.id,
        ),
      ).toBeNull();
      expect(
        await loadPartnerAdditionalServiceSource(
          tx,
          principal(company.id, [otherSite.locationId]),
          source.id,
        ),
      ).toBeNull();
      expect(
        await loadPartnerAdditionalServiceSource(
          tx,
          principal(company.id),
          randomUUID(),
        ),
      ).toBeNull();
      expect(
        await loadPartnerAdditionalServiceSource(
          tx,
          principal(company.id),
          "not-a-job",
        ),
      ).toBeNull();
      expect(
        (
          await loadPartnerAdditionalServiceSource(
            tx,
            principal(company.id, [site.locationId]),
            source.id,
          )
        )?.id,
      ).toBe(source.id);
    }));
  it("independently filters parent and child links by location permissions", async () =>
    rollbackTest(async (tx) => {
      const company = await account(tx),
        firstSite = await location(tx, company),
        secondSite = await location(tx, company);
      const parent = await job(tx, company, firstSite);
      const visibleChild = await job(tx, company, firstSite, parent.id);
      const hiddenChild = await job(tx, company, secondSite, parent.id);
      const parentScope = principal(company.id, [firstSite.locationId]);
      const result = await listPartnerAdditionalServiceLinks(
        tx,
        parentScope,
        parent.id,
        new URLSearchParams(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.originalJob).toBeNull();
      expect(result.jobs.map((row) => row.id)).toEqual([visibleChild.id]);
      expect(JSON.stringify(result)).not.toContain(hiddenChild.id);
      const childResult = await listPartnerAdditionalServiceLinks(
        tx,
        principal(company.id, [secondSite.locationId]),
        hiddenChild.id,
        new URLSearchParams(),
      );
      expect(childResult.ok).toBe(true);
      if (!childResult.ok) throw new Error(childResult.error);
      expect(childResult.originalJob).toBeNull();
      expect(JSON.stringify(childResult)).not.toContain(parent.id);
      const allowed = await listPartnerAdditionalServiceLinks(
        tx,
        principal(company.id),
        hiddenChild.id,
        new URLSearchParams(),
      );
      expect(allowed.ok && allowed.originalJob?.id).toBe(parent.id);
      expect(
        await listPartnerAdditionalServiceLinks(
          tx,
          principal(randomUUID()),
          parent.id,
          new URLSearchParams(),
        ),
      ).toMatchObject({ ok: false, status: 404 });
      expect(
        await listPartnerAdditionalServiceLinks(
          tx,
          parentScope,
          hiddenChild.id,
          new URLSearchParams(),
        ),
      ).toMatchObject({ ok: false, status: 404 });
    }));
  it("paginates direct child jobs and binds cursors to account, scope and requested job", async () =>
    rollbackTest(async (tx) => {
      const company = await account(tx),
        site = await location(tx, company),
        parent = await job(tx, company, site),
        actor = principal(company.id);
      const oldest = await job(
        tx,
        company,
        site,
        parent.id,
        new Date("2026-09-01T00:00:00Z"),
      );
      const newest = await job(
        tx,
        company,
        site,
        parent.id,
        new Date("2026-09-02T00:00:00Z"),
      );
      const first = await listPartnerAdditionalServiceLinks(
        tx,
        actor,
        parent.id,
        new URLSearchParams({ limit: "1" }),
      );
      if (!first.ok) throw new Error(first.error);
      expect(first.jobs.map((row) => row.id)).toEqual([newest.id]);
      expect(first.page).toMatchObject({ limit: 1, hasMore: true });
      const cursor = first.page.nextCursor!;
      const second = await listPartnerAdditionalServiceLinks(
        tx,
        actor,
        parent.id,
        new URLSearchParams({ cursor }),
      );
      if (!second.ok) throw new Error(second.error);
      expect(second.jobs.map((row) => row.id)).toEqual([oldest.id]);
      expect(second.page).toMatchObject({
        nextCursor: null,
        hasMore: false,
        limit: 1,
      });
      expect(Object.keys(second.jobs[0]!).sort()).toEqual([
        "createdAt",
        "id",
        "serviceKey",
        "status",
      ]);
      for (const [scope, id] of [
        [principal(company.id, [site.locationId]), parent.id],
        [actor, newest.id],
        [principal(randomUUID()), parent.id],
      ] as const) {
        expect(
          await listPartnerAdditionalServiceLinks(
            tx,
            scope,
            id,
            new URLSearchParams({ cursor }),
          ),
        ).toMatchObject({ ok: false, status: 400 });
      }
      for (const limit of ["0", "101", "not-a-number"]) {
        expect(
          await listPartnerAdditionalServiceLinks(
            tx,
            actor,
            parent.id,
            new URLSearchParams({ limit }),
          ),
        ).toMatchObject({ ok: false, status: 400 });
      }
    }));
});
