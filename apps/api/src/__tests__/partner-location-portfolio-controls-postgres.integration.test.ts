import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  contacts,
  getDb,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerLocationFavorites,
  partnerLocationImports,
  partnerQuotes,
  partnerUsers,
  properties,
  quoteVersions,
  quotes,
  salesOpportunities,
} from "@/db";
import {
  getPartnerLocationArchiveImpact,
  incrementPartnerLocationDirectory,
  lockPartnerLocationDirectory,
} from "@/lib/partner-location-portfolio";
import { lockPartnerQuoteLocationForCommercialAction } from "@/lib/partner-quote-location-safety";
import { getCanonicalPartnerQuote } from "@/lib/partner-portal-v2-quotes";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type Fixture = Readonly<{
  accountId: string;
  otherAccountId: string;
  membershipId: string;
  otherMembershipId: string;
  userId: string;
  otherUserId: string;
  rootId: string;
  childId: string;
  otherLocationId: string;
}>;

type DatabaseError = Readonly<{ code?: unknown; constraint_name?: unknown }>;

function deepestDatabaseError(error: unknown): DatabaseError {
  let current: unknown = error;
  const visited = new Set<unknown>();
  let matched: DatabaseError = {};
  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (record["code"] || record["constraint_name"]) matched = record;
    if (!record["cause"]) return matched;
    current = record["cause"];
  }
  return matched;
}

async function createFixture(): Promise<Fixture> {
  const accountId = randomUUID();
  const otherAccountId = randomUUID();
  const membershipId = randomUUID();
  const otherMembershipId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const rootId = randomUUID();
  const childId = randomUUID();
  const otherLocationId = randomUUID();
  const suffix = accountId.replaceAll("-", "").slice(0, 12);
  const acceptedAt = new Date("2026-09-01T12:00:00.000Z");
  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values([
      {
        id: accountId,
        name: `Location portfolio ${suffix}`,
        normalizedName: `location portfolio ${suffix}`,
      },
      {
        id: otherAccountId,
        name: `Other location portfolio ${suffix}`,
        normalizedName: `other location portfolio ${suffix}`,
      },
    ]);
    await tx.insert(partnerUsers).values([
      {
        id: userId,
        email: `location-${suffix}@example.test`,
        normalizedEmail: `location-${suffix}@example.test`,
        name: "Location operator",
      },
      {
        id: otherUserId,
        email: `location-other-${suffix}@example.test`,
        normalizedEmail: `location-other-${suffix}@example.test`,
        name: "Other location operator",
      },
    ]);
    await tx.insert(partnerAccountMemberships).values([
      {
        id: membershipId,
        partnerAccountId: accountId,
        partnerUserId: userId,
        roleKey: "operations",
        status: "active",
        acceptedAt,
      },
      {
        id: otherMembershipId,
        partnerAccountId: otherAccountId,
        partnerUserId: otherUserId,
        roleKey: "operations",
        status: "active",
        acceptedAt,
      },
    ]);
    await tx.insert(partnerAccountLocations).values([
      {
        id: rootId,
        partnerAccountId: accountId,
        siteName: "Portfolio root",
        externalPropertyId: `ROOT-${suffix}`,
        addressLine1: "10 Portfolio Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
        createdByMembershipId: membershipId,
      },
      {
        id: childId,
        partnerAccountId: accountId,
        siteName: "Portfolio child",
        externalPropertyId: `CHILD-${suffix}`,
        addressLine1: "12 Portfolio Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
        parentLocationId: rootId,
        createdByMembershipId: membershipId,
      },
      {
        id: otherLocationId,
        partnerAccountId: otherAccountId,
        siteName: "Other tenant site",
        externalPropertyId: `OTHER-${suffix}`,
        addressLine1: "20 Portfolio Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
        createdByMembershipId: otherMembershipId,
      },
    ]);
  });
  return {
    accountId,
    otherAccountId,
    membershipId,
    otherMembershipId,
    userId,
    otherUserId,
    rootId,
    childId,
    otherLocationId,
  };
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  await getDb().transaction(async (tx) => {
    // Quote V2 bindings are immutable in application traffic. This opt-in
    // integration fixture must remove only its exact test-owned evidence.
    await tx.execute(sql.raw("SET LOCAL session_replication_role = 'replica'"));
    await tx
      .delete(partnerQuotes)
      .where(
        sql`${partnerQuotes.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .update(quotes)
      .set({ currentVersionId: null, publishedVersionId: null })
      .where(
        sql`${quotes.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx.delete(quoteVersions).where(
      sql`${quoteVersions.quoteId} IN (
        SELECT quote_row.id FROM quotes quote_row
        WHERE quote_row.partner_account_id IN (${fixture.accountId}, ${fixture.otherAccountId})
      )`,
    );
    await tx
      .delete(quotes)
      .where(
        sql`${quotes.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx.delete(salesOpportunities).where(
      sql`${salesOpportunities.contactId} IN (
        SELECT contact_row.id FROM contacts contact_row
        WHERE contact_row.partner_account_id IN (${fixture.accountId}, ${fixture.otherAccountId})
      )`,
    );
    await tx.delete(properties).where(
      sql`${properties.contactId} IN (
        SELECT contact_row.id FROM contacts contact_row
        WHERE contact_row.partner_account_id IN (${fixture.accountId}, ${fixture.otherAccountId})
      )`,
    );
    await tx
      .delete(contacts)
      .where(
        sql`${contacts.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx.execute(sql.raw("SET LOCAL session_replication_role = 'origin'"));
    await tx
      .delete(partnerLocationImports)
      .where(
        sql`${partnerLocationImports.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .delete(partnerLocationFavorites)
      .where(
        sql`${partnerLocationFavorites.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .update(partnerAccountLocations)
      .set({ parentLocationId: null })
      .where(
        sql`${partnerAccountLocations.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: null })
      .where(
        sql`${partnerAccounts.id} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .delete(partnerAccountLocations)
      .where(
        sql`${partnerAccountLocations.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .delete(partnerAccountMemberships)
      .where(
        sql`${partnerAccountMemberships.partnerAccountId} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .delete(partnerAccounts)
      .where(
        sql`${partnerAccounts.id} IN (${fixture.accountId}, ${fixture.otherAccountId})`,
      );
    await tx
      .delete(partnerUsers)
      .where(
        sql`${partnerUsers.id} IN (${fixture.userId}, ${fixture.otherUserId})`,
      );
  });
}

function importEvidence(fixture: Fixture, keyHash: string) {
  const now = new Date();
  return {
    partnerAccountId: fixture.accountId,
    requestedByMembershipId: fixture.membershipId,
    dryRunIdempotencyKeyHash: keyHash,
    requestHash: "b".repeat(64),
    state: "validated" as const,
    directoryVersion: 1,
    rowCount: 1,
    validRowCount: 1,
    invalidRowCount: 0,
    normalizedRows: [
      {
        rowNumber: 2,
        siteName: "Snapshot site",
        externalPropertyId: "SNAP-1",
        addressLine1: "30 Portfolio Way",
        addressLine2: null,
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
        timezone: "America/New_York",
        parentExternalPropertyId: null,
        makeDefault: false,
        addressKey: "30 portfolio way||atlanta|GA|30303",
      },
    ],
    rowResults: [
      {
        rowNumber: 2,
        status: "valid",
        values: { site_name: "Snapshot site" },
        errors: [],
      },
    ],
    expiresAt: new Date(now.getTime() + 60_000),
    purgeAfter: new Date(now.getTime() + 120_000),
    createdAt: now,
    updatedAt: now,
  };
}

describeWithDatabase("Partner location portfolio PostgreSQL integrity", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await deleteFixture(fixture);
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("enforces tenant-safe defaults and membership-private favorites", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const [account] = await getDb()
      .select({ defaultLocationId: partnerAccounts.defaultPartnerLocationId })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.accountId));
    expect(account?.defaultLocationId).toBe(fixture.rootId);

    let defaultError: DatabaseError = {};
    try {
      await getDb().transaction(async (tx) => {
        const [updated] = await tx
          .update(partnerAccounts)
          .set({ defaultPartnerLocationId: fixture.otherLocationId })
          .where(eq(partnerAccounts.id, fixture.accountId))
          .returning({ id: partnerAccounts.id });
        expect(updated?.id).toBe(fixture.accountId);
        await tx.execute(
          sql`SET CONSTRAINTS partner_accounts_default_location_account_fk IMMEDIATE`,
        );
      });
    } catch (error) {
      defaultError = deepestDatabaseError(error);
    }
    expect(defaultError.code).toBe("23503");
    expect(defaultError.constraint_name).toBe(
      "partner_accounts_default_location_account_fk",
    );

    let favoriteError: DatabaseError = {};
    try {
      await getDb().insert(partnerLocationFavorites).values({
        partnerAccountId: fixture.accountId,
        membershipId: fixture.membershipId,
        locationId: fixture.otherLocationId,
      });
    } catch (error) {
      favoriteError = deepestDatabaseError(error);
    }
    expect(favoriteError.code).toBe("23503");
    expect(favoriteError.constraint_name).toBe(
      "partner_location_favorites_location_account_fk",
    );
  });

  it("rejects hierarchy cycles and supports default reassignment before archive", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    let cycleError: DatabaseError = {};
    try {
      await getDb()
        .update(partnerAccountLocations)
        .set({ parentLocationId: fixture.childId })
        .where(eq(partnerAccountLocations.id, fixture.rootId));
    } catch (error) {
      cycleError = deepestDatabaseError(error);
    }
    expect(cycleError.code).toBe("23514");

    await getDb().transaction(async (tx) => {
      await tx
        .update(partnerAccounts)
        .set({ defaultPartnerLocationId: fixture.childId })
        .where(eq(partnerAccounts.id, fixture.accountId));
      await tx
        .update(partnerAccountLocations)
        .set({ parentLocationId: null })
        .where(eq(partnerAccountLocations.id, fixture.childId));
      await tx
        .update(partnerAccountLocations)
        .set({ active: false })
        .where(eq(partnerAccountLocations.id, fixture.rootId));
    });
    const [archived] = await getDb()
      .select({ active: partnerAccountLocations.active })
      .from(partnerAccountLocations)
      .where(eq(partnerAccountLocations.id, fixture.rootId));
    expect(archived?.active).toBe(false);
  });

  it("serializes same-revision directory writers with the account lock", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const expectedVersion = 1;
    const write = (locationId: string) =>
      getDb().transaction(async (tx) => {
        const account = await lockPartnerLocationDirectory(
          tx,
          fixture.accountId,
        );
        if (!account || account.version !== expectedVersion) {
          throw new Error("revision_mismatch");
        }
        await tx
          .update(partnerAccounts)
          .set({ defaultPartnerLocationId: locationId })
          .where(eq(partnerAccounts.id, fixture.accountId));
        return incrementPartnerLocationDirectory(
          tx,
          fixture.accountId,
          expectedVersion,
        );
      });
    const outcomes = await Promise.allSettled([
      write(fixture.rootId),
      write(fixture.childId),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
  });

  it("counts actionable Quote V2 bindings and preserves archived financial evidence safely", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const contactId = randomUUID();
    const opportunityId = randomUUID();
    const propertyId = randomUUID();
    const quoteId = randomUUID();
    const versionId = randomUUID();
    const projectionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    const hash = "e".repeat(64);
    await getDb().transaction(async (tx) => {
      await tx.insert(contacts).values({
        id: contactId,
        firstName: "Portfolio",
        lastName: "Quote",
        source: "partner_location_portfolio_pg",
        partnerAccountId: fixture.accountId,
      });
      await tx.insert(properties).values({
        id: propertyId,
        contactId,
        addressLine1: "12 Portfolio Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
      });
      // Canonical Quote V2 location evidence must bind the same account-owned
      // property as the quote; a location-only projection is not authoritative.
      await tx
        .update(partnerAccountLocations)
        .set({ propertyId })
        .where(
          and(
            eq(partnerAccountLocations.partnerAccountId, fixture.accountId),
            eq(partnerAccountLocations.id, fixture.childId),
          ),
        );
      await tx.insert(salesOpportunities).values({
        id: opportunityId,
        contactId,
        propertyId,
        name: "Portfolio quote binding",
        status: "open",
        pipelineStage: "quoted",
        currency: "USD",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(quotes).values({
        id: quoteId,
        salesOpportunityId: opportunityId,
        partnerAccountId: fixture.accountId,
        engineVersion: "v2",
        aggregateState: "open",
        aggregateRevision: 1,
        contactId,
        propertyId,
        status: "sent",
        services: ["custom"],
        addOns: [],
        zoneId: "portfolio-quote-pg",
        travelFee: "0",
        discounts: "0",
        addOnsTotal: "0",
        subtotal: "100",
        total: "100",
        depositDue: "0",
        depositRate: "0",
        balanceDue: "100",
        lineItems: [],
        quoteNumber: `Q-PORTFOLIO-${randomUUID()}`,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(quoteVersions).values({
        id: versionId,
        quoteId,
        versionNumber: 1,
        draftRevision: 1,
        state: "issued",
        provenance: "native",
        schemaVersion: 1,
        documentType: "fixed_quote",
        audience: "commercial",
        schedulingMode: "approval_only",
        currency: "USD",
        documentSnapshot: {},
        partySnapshot: {},
        issuerSnapshot: {},
        termsSnapshot: {},
        canonicalRenderJson: "{}",
        documentSchemaHash: hash,
        pricingHash: hash,
        templateHash: hash,
        contentHash: hash,
        subtotalMinCents: 10_000,
        subtotalMaxCents: 10_000,
        discountMinCents: 0,
        discountMaxCents: 0,
        feeMinCents: 0,
        feeMaxCents: 0,
        totalMinCents: 10_000,
        totalMaxCents: 10_000,
        depositCents: 0,
        balanceMinCents: 10_000,
        balanceMaxCents: 10_000,
        validFrom: now,
        readyAt: now,
        issuedAt: now,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(quotes)
        .set({ currentVersionId: versionId, publishedVersionId: versionId })
        .where(eq(quotes.id, quoteId));
      await tx.insert(partnerQuotes).values({
        id: projectionId,
        authority: "quote_v2",
        partnerAccountId: fixture.accountId,
        quoteId,
        partnerBookingId: null,
        bookingDraftId: null,
        partnerAccountLocationId: fixture.childId,
        quoteNumber: null,
        version: null,
        status: null,
        currency: null,
        subtotalCents: null,
        taxCents: null,
        discountCents: null,
        totalCents: null,
        lines: null,
        terms: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    const impact = await getDb().transaction(async (tx) => {
      const [location] = await tx
        .select()
        .from(partnerAccountLocations)
        .where(eq(partnerAccountLocations.id, fixture.childId));
      return getPartnerLocationArchiveImpact(tx, {
        accountId: fixture.accountId,
        location: location!,
        defaultLocationId: fixture.rootId,
      });
    });
    expect(impact.canonicalQuoteV2Count).toBe(1);
    expect(impact.issuedActionableQuoteV2Count).toBe(1);

    await getDb()
      .update(partnerAccountLocations)
      .set({ active: false })
      .where(eq(partnerAccountLocations.id, fixture.childId));
    const scopedAccess = {
      accountId: fixture.accountId,
      membershipId: fixture.membershipId,
      accessLevel: "scoped" as const,
      accessScope: { locationIds: [fixture.childId] },
    };
    const detail = await getCanonicalPartnerQuote({
      principal: scopedAccess,
      partnerQuoteId: projectionId,
      now,
    });
    expect(detail?.quote).toMatchObject({
      id: projectionId,
      actionable: false,
      locationId: fixture.childId,
      allowedActions: [],
    });
    expect(String(detail?.quote["notice"])).toContain("financial evidence");
    await expect(
      getDb().transaction((tx) =>
        lockPartnerQuoteLocationForCommercialAction(tx, {
          quoteId,
          accountId: fixture.accountId,
        }),
      ),
    ).resolves.toBe(false);
  });

  it("keeps import provenance/snapshots tenant-bound, unique, secret-free and prunable", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const keyHash = "a".repeat(64);
    const concurrent = await Promise.allSettled([
      getDb()
        .insert(partnerLocationImports)
        .values(importEvidence(fixture, keyHash)),
      getDb()
        .insert(partnerLocationImports)
        .values(importEvidence(fixture, keyHash)),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const [snapshot] = await getDb()
      .select()
      .from(partnerLocationImports)
      .where(
        and(
          eq(partnerLocationImports.partnerAccountId, fixture.accountId),
          eq(partnerLocationImports.dryRunIdempotencyKeyHash, keyHash),
        ),
      );
    expect(snapshot?.requestedByMembershipId).toBe(fixture.membershipId);
    const originalRows = snapshot?.normalizedRows;
    await getDb()
      .update(partnerAccountLocations)
      .set({ siteName: "Changed after dry-run" })
      .where(eq(partnerAccountLocations.id, fixture.rootId));
    const [unchanged] = await getDb()
      .select({ rows: partnerLocationImports.normalizedRows })
      .from(partnerLocationImports)
      .where(eq(partnerLocationImports.id, snapshot!.id));
    expect(unchanged?.rows).toEqual(originalRows);

    let provenanceError: DatabaseError = {};
    try {
      await getDb()
        .insert(partnerLocationImports)
        .values({
          ...importEvidence(fixture, "c".repeat(64)),
          requestedByMembershipId: fixture.otherMembershipId,
        });
    } catch (error) {
      provenanceError = deepestDatabaseError(error);
    }
    expect(provenanceError.code).toBe("23503");

    let secretError: DatabaseError = {};
    try {
      const secretEvidence = importEvidence(fixture, "d".repeat(64));
      await getDb()
        .insert(partnerLocationImports)
        .values({
          ...secretEvidence,
          normalizedRows: [
            {
              ...secretEvidence.normalizedRows[0]!,
              accessSecret: "never-store",
            },
          ],
        });
    } catch (error) {
      secretError = deepestDatabaseError(error);
    }
    expect(secretError.code).toBe("23514");
    expect(secretError.constraint_name).toBe(
      "partner_location_imports_no_secret_keys_check",
    );

    await getDb().execute(
      sql`SELECT prune_partner_location_imports(${new Date(Date.now() + 180_000).toISOString()}::timestamptz, 50)`,
    );
    const [purged] = await getDb()
      .select({ id: partnerLocationImports.id })
      .from(partnerLocationImports)
      .where(eq(partnerLocationImports.id, snapshot!.id));
    expect(purged).toBeUndefined();
  });
});
