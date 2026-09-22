import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccounts,
  partnerAccountInvitations,
  partnerRateCardVersions,
  partnerRateCardVersionItems,
  teamMembers,
  teamRoles,
} from "@/db";
import {
  createPartnerRelationship,
  enablePartnerRelationshipAsStaff,
  invitePartnerAsStaff,
} from "@/lib/partner-relationship-management";
import {
  loadPartnerPublishedServiceRateCard,
  savePartnerServiceRates,
} from "@/lib/partner-structured-rates";
import type { TeamMutationContext } from "@/lib/team-mutation";
import { completeTestPartnerRateCard } from "./fixtures/partner-service-rates";

const local =
  process.env["DATABASE_URL"] &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
async function fixture() {
  const db = getDb(),
    roleId = randomUUID(),
    memberId = randomUUID();
  await db.insert(teamRoles).values({
    id: roleId,
    slug: "rate-test-" + roleId,
    name: "Local rate manager",
    permissions: [
      "partners.accounts.manage",
      "partners.invitations.send",
      "partners.rates",
    ],
  });
  await db.insert(teamMembers).values({
    id: memberId,
    roleId,
    name: "Local rate manager",
    email: memberId + "@example.test",
    active: true,
  });
  const mutation = {
    actor: {
      type: "human",
      id: memberId,
      authMethod: "team_session",
      sessionId: randomUUID(),
      label: memberId + "@example.test",
    },
    correlationId: "rate-test-" + randomUUID(),
    idempotencyKeyHash: "a".repeat(64),
    expectedVersion: "1",
  } as TeamMutationContext;
  const company = await db.transaction((tx) =>
    createPartnerRelationship(tx, mutation, {
      companyName: "Local rate setup " + randomUUID(),
      contactName: "Test partner",
      contactEmail: randomUUID() + "@example.test",
      persona: "commercial_client",
      reason: "Local isolated service rate setup verification.",
    }),
  );
  return { db, mutation, accountId: company.accountId, memberId };
}

suite("structured partner rate setup / real PostgreSQL", () => {
  beforeAll(() => {
    process.env["PUBLIC_SITE_URL"] = "https://stonegate.example";
  });
  afterAll(async () => closeDbForTests());
  it("keeps new companies inactive until all variants are published, then activates and invites atomically", async () => {
    const f = await fixture();
    const [created] = await f.db
      .select()
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, f.accountId));
    expect(created).toMatchObject({
      portalSetupStatus: "rates_required",
      portalAccessEnabled: false,
    });
    expect(
      await f.db
        .select()
        .from(partnerAccountInvitations)
        .where(eq(partnerAccountInvitations.partnerAccountId, f.accountId)),
    ).toHaveLength(0);
    await expect(
      f.db.transaction((tx) =>
        enablePartnerRelationshipAsStaff(tx, f.mutation, f.accountId),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.db.transaction((tx) =>
        invitePartnerAsStaff(tx, f.mutation, {
          accountId: f.accountId,
          invitation: {
            email: randomUUID() + "@example.test",
            name: "Another person",
            persona: "other",
            roleKey: "administrator",
            accessLevel: "account",
            locationIds: [],
            costCenterIds: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const incomplete = completeTestPartnerRateCard();
    incomplete.rates = incomplete.rates.filter(
      (rate) => rate.variantKey !== "full_surface",
    );
    await f.db.transaction((tx) =>
      savePartnerServiceRates(tx, f.mutation, f.accountId, {
        action: "publish",
        portalVisible: true,
        card: incomplete,
      }),
    );
    await expect(
      f.db.transaction((tx) =>
        enablePartnerRelationshipAsStaff(tx, f.mutation, f.accountId),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.db.transaction((tx) =>
      savePartnerServiceRates(
        tx,
        { ...f.mutation, expectedVersion: "2" },
        f.accountId,
        {
          action: "publish",
          portalVisible: true,
          card: completeTestPartnerRateCard(),
        },
      ),
    );
    const enabled = await f.db.transaction((tx) =>
      enablePartnerRelationshipAsStaff(tx, f.mutation, f.accountId),
    );
    expect(enabled.deliveryStatus).toBe("queued");
    expect(
      await f.db
        .select()
        .from(partnerAccountInvitations)
        .where(eq(partnerAccountInvitations.partnerAccountId, f.accountId)),
    ).toHaveLength(1);
    const [active] = await f.db
      .select()
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, f.accountId));
    expect(active).toMatchObject({
      portalSetupStatus: "complete",
      portalAccessEnabled: true,
    });
  });
  it("saves blank drafts without inventing prices and keeps published snapshots immutable", async () => {
    const f = await fixture();
    const draft = completeTestPartnerRateCard();
    draft.rates[0]!.unitAmount = "";
    await f.db.transaction((tx) =>
      savePartnerServiceRates(tx, f.mutation, f.accountId, {
        action: "draft",
        portalVisible: false,
        card: draft,
      }),
    );
    expect(
      await loadPartnerPublishedServiceRateCard(f.db, {
        accountId: f.accountId,
      }),
    ).toBeNull();
    const card = completeTestPartnerRateCard();
    card.rates[1]!.unitAmount = "0.1234";
    card.rates[1]!.unit = "sq_ft";
    const first = await f.db.transaction((tx) =>
      savePartnerServiceRates(
        tx,
        { ...f.mutation, expectedVersion: "2" },
        f.accountId,
        { action: "publish", portalVisible: true, card },
      ),
    );
    const originalVersion = await f.db
      .select()
      .from(partnerRateCardVersions)
      .where(eq(partnerRateCardVersions.id, first.publishedVersionId!));
    const originalRows = await f.db
      .select()
      .from(partnerRateCardVersionItems)
      .where(
        eq(
          partnerRateCardVersionItems.partnerRateCardVersionId,
          first.publishedVersionId!,
        ),
      );
    card.rates[1]!.unitAmount = "0.2345";
    await f.db.transaction((tx) =>
      savePartnerServiceRates(
        tx,
        { ...f.mutation, expectedVersion: "3" },
        f.accountId,
        { action: "publish", portalVisible: false, card },
      ),
    );
    expect(
      await f.db
        .select()
        .from(partnerRateCardVersions)
        .where(eq(partnerRateCardVersions.id, first.publishedVersionId!)),
    ).toEqual(originalVersion);
    expect(
      await f.db
        .select()
        .from(partnerRateCardVersionItems)
        .where(
          eq(
            partnerRateCardVersionItems.partnerRateCardVersionId,
            first.publishedVersionId!,
          ),
        ),
    ).toEqual(originalRows);
    const current = await loadPartnerPublishedServiceRateCard(f.db, {
      accountId: f.accountId,
    });
    expect(current).toMatchObject({
      version: 2,
      portalVisible: false,
      visitMinimum: "75.00",
    });
    expect(
      current?.rates.find((rate) => rate.serviceKey === "pressure-washing")
        ?.unitAmount,
    ).toBe("0.2345");
    expect(
      await loadPartnerPublishedServiceRateCard(f.db, {
        accountId: randomUUID(),
      }),
    ).toBeNull();
  });
  it("publishes an explicitly empty card without inventing prices or activating incomplete setup", async () => {
    const f = await fixture();
    const card = { ...completeTestPartnerRateCard(), rates: [] };
    const result = await f.db.transaction((tx) =>
      savePartnerServiceRates(tx, f.mutation, f.accountId, {
        action: "publish",
        portalVisible: true,
        card,
      }),
    );
    expect(result.publishedVersionId).toEqual(expect.any(String));
    expect(
      await loadPartnerPublishedServiceRateCard(f.db, {
        accountId: f.accountId,
      }),
    ).toMatchObject({
      source: "structured",
      rates: [],
      complete: false,
    });
    await expect(
      f.db.transaction((tx) =>
        enablePartnerRelationshipAsStaff(tx, f.mutation, f.accountId),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("serializes concurrent edits, rejects stale versions and rechecks revoked rate authority", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      [true, false].map((portalVisible) =>
        f.db.transaction((tx) =>
          savePartnerServiceRates(tx, f.mutation, f.accountId, {
            action: "draft",
            portalVisible,
            card: completeTestPartnerRateCard(),
          }),
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await f.db
      .update(teamMembers)
      .set({ permissionsDeny: ["partners.rates"] })
      .where(eq(teamMembers.id, f.memberId));
    await expect(
      f.db.transaction((tx) =>
        savePartnerServiceRates(
          tx,
          { ...f.mutation, expectedVersion: "2" },
          f.accountId,
          {
            action: "publish",
            portalVisible: true,
            card: completeTestPartnerRateCard(),
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("does not activate a new partner using a future rate card", async () => {
    const f = await fixture(),
      card = completeTestPartnerRateCard();
    card.effectiveFrom = "2099-01-01T00:00:00.000Z";
    await f.db.transaction((tx) =>
      savePartnerServiceRates(tx, f.mutation, f.accountId, {
        action: "publish",
        portalVisible: true,
        card,
      }),
    );
    await expect(
      f.db.transaction((tx) =>
        enablePartnerRelationshipAsStaff(tx, f.mutation, f.accountId),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
