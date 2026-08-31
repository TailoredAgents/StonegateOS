import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  closeDbForTests,
  contacts,
  crmTasks,
  getDb,
  outboxEvents,
  properties,
  quoteActivityEvents,
  quoteCapabilities,
  quoteChangeRequests,
  quoteResponses,
  quoteVersions,
  quotes,
  salesOpportunities,
  teamMembers,
  type DatabaseClient,
} from "@/db";
import {
  quoteV2PublicRequestHash,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import { recordQuoteV2RefreshRequest } from "@/lib/quote-v2-public-service";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describeWithDatabase("Quote V2 expired proposal update request", () => {
  let db: DatabaseClient;

  beforeAll(() => {
    db = getDb();
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("binds the exact expired signer version and replays with one task, response, activity, and ID-only outbox event", async () => {
    const run = randomUUID();
    const now = new Date("2030-02-03T15:00:00.000Z");
    const issuedAt = new Date("2030-01-01T15:00:00.000Z");
    const expiresAt = new Date("2030-02-01T15:00:00.000Z");
    const readExpiresAt = new Date("2030-05-02T15:00:00.000Z");
    const signerTokenHash = digest(`${run}:signer-token`);
    const otherSignerTokenHash = digest(`${run}:other-signer-token`);
    const viewerTokenHash = digest(`${run}:viewer-token`);
    const keyHash = digest(`${run}:idempotency`);
    const correlationId = `quote-refresh-${run}`;

    const [owner] = await db
      .insert(teamMembers)
      .values({ name: `Quote refresh owner ${run}` })
      .returning({ id: teamMembers.id });
    const [contact] = await db
      .insert(contacts)
      .values({ firstName: "Expired", lastName: `Proposal ${run}` })
      .returning({ id: contacts.id });
    if (!owner || !contact) throw new Error("refresh_fixture_identity_failed");
    const [property] = await db
      .insert(properties)
      .values({
        contactId: contact.id,
        addressLine1: "100 Versioned Proposal Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
      })
      .returning({ id: properties.id });
    if (!property) throw new Error("refresh_fixture_property_failed");
    const [opportunity] = await db
      .insert(salesOpportunities)
      .values({
        contactId: contact.id,
        propertyId: property.id,
        ownerTeamMemberId: owner.id,
        name: `Expired proposal ${run}`,
        status: "open",
        pipelineStage: "quoted",
        revision: 1,
      })
      .returning({ id: salesOpportunities.id });
    if (!opportunity) throw new Error("refresh_fixture_opportunity_failed");
    const [quote] = await db
      .insert(quotes)
      .values({
        salesOpportunityId: opportunity.id,
        engineVersion: "v2",
        aggregateState: "open",
        aggregateRevision: 1,
        contactId: contact.id,
        propertyId: property.id,
        status: "sent",
        services: ["custom"],
        addOns: [],
        zoneId: "zone-refresh-test",
        travelFee: "0",
        discounts: "0",
        addOnsTotal: "0",
        subtotal: "100.00",
        total: "100.00",
        depositDue: "0",
        depositRate: "0",
        balanceDue: "100.00",
        lineItems: [],
        quoteNumber: `Q-REFRESH-${run}`,
        revision: 1,
        sentAt: issuedAt,
        expiresAt,
      })
      .returning({ id: quotes.id });
    if (!quote) throw new Error("refresh_fixture_quote_failed");

    const documentSnapshot = {
      schemaVersion: 1,
      documentType: "fixed_quote",
      audience: "commercial",
      schedulingMode: "staff_followup",
      parties: {
        customerName: "Expired Proposal",
        serviceAddress: "100 Versioned Proposal Way, Atlanta, GA 30303",
        preparerName: "Quote refresh owner",
      },
      issuer: {
        legalName: "Stonegate Services LLC",
        displayName: "Stonegate",
        address: "Atlanta, GA",
        email: "support@example.test",
        phoneE164: "+14045550100",
      },
      scope: "Version-bound expired proposal refresh fixture.",
      inclusions: [],
      exclusions: [],
      assumptions: [],
      pricing: {
        documentType: "fixed_quote",
        currency: "USD",
        lineItems: [
          {
            id: "base",
            name: "Commercial service",
            quantity: 1,
            unit: "project",
            unitPriceMinCents: 10_000,
            selectedByDefault: false,
            displayOrder: 0,
          },
        ],
        optionGroups: [],
        adjustments: [],
        deposit: { mode: "none" },
      },
      terms: {
        templateVersion: "refresh-test-v1",
        terms: "Fixture terms.",
        paymentTerms: "Due after service.",
        changeOrderRules: "Written approval required.",
        validityDays: 31,
        consentVersion: "refresh-test-consent-v1",
      },
      estimatedDurationMinutes: 120,
      serviceZoneConfirmed: true,
    };
    const hash = digest(JSON.stringify(documentSnapshot));
    const [version] = await db
      .insert(quoteVersions)
      .values({
        quoteId: quote.id,
        versionNumber: 1,
        state: "issued",
        documentType: "fixed_quote",
        audience: "commercial",
        schedulingMode: "staff_followup",
        documentSnapshot,
        partySnapshot: documentSnapshot.parties,
        issuerSnapshot: documentSnapshot.issuer,
        termsSnapshot: documentSnapshot.terms,
        canonicalRenderJson: JSON.stringify({ document: documentSnapshot }),
        documentSchemaHash: hash,
        pricingHash: hash,
        templateHash: hash,
        contentHash: hash,
        selectedOptionIds: [],
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
        readyAt: issuedAt,
        validFrom: issuedAt,
        issuedAt,
        firstSentAt: issuedAt,
        expiresAt,
        createdByTeamMemberId: owner.id,
      })
      .returning({ id: quoteVersions.id });
    if (!version) throw new Error("refresh_fixture_version_failed");
    await db
      .update(quotes)
      .set({ currentVersionId: version.id, publishedVersionId: version.id })
      .where(eq(quotes.id, quote.id));
    await db.insert(quoteCapabilities).values([
      {
        quoteId: quote.id,
        quoteVersionId: version.id,
        recipientRole: "signer",
        recipientAddressHash: digest(`${run}:other-signer-address`),
        allowedActions: ["view", "pdf", "change", "refresh"],
        tokenHash: otherSignerTokenHash,
        status: "active",
        issuedAt,
        actionExpiresAt: null,
        readExpiresAt,
        issuedByTeamMemberId: owner.id,
      },
      {
        quoteId: quote.id,
        quoteVersionId: version.id,
        recipientRole: "signer",
        recipientAddressHash: digest(`${run}:signer-address`),
        // Compatibility case: this link predates the explicit refresh grant.
        allowedActions: ["view", "pdf", "change"],
        tokenHash: signerTokenHash,
        status: "active",
        issuedAt,
        actionExpiresAt: expiresAt,
        readExpiresAt,
        issuedByTeamMemberId: owner.id,
      },
      {
        quoteId: quote.id,
        quoteVersionId: version.id,
        recipientRole: "cc",
        recipientAddressHash: digest(`${run}:viewer-address`),
        allowedActions: ["view", "pdf"],
        tokenHash: viewerTokenHash,
        status: "active",
        issuedAt,
        actionExpiresAt: null,
        readExpiresAt,
        issuedByTeamMemberId: owner.id,
      },
    ]);

    const command = {
      quoteId: quote.id,
      versionId: version.id,
      message: "Please update the timing while keeping the project scope.",
    };
    const requestHash = quoteV2PublicRequestHash({
      action: "refresh",
      command,
    });

    await expect(
      recordQuoteV2RefreshRequest(db, {
        tokenHash: signerTokenHash,
        command: { ...command, quoteId: randomUUID() },
        idempotencyKeyHash: digest(`${run}:wrong-quote`),
        requestHash: digest(`${run}:wrong-quote-request`),
        correlationId,
        now,
      }),
    ).rejects.toBeInstanceOf(QuoteV2PublicStateError);
    await expect(
      recordQuoteV2RefreshRequest(db, {
        tokenHash: signerTokenHash,
        command: { ...command, versionId: randomUUID() },
        idempotencyKeyHash: digest(`${run}:wrong-version`),
        requestHash: digest(`${run}:wrong-version-request`),
        correlationId,
        now,
      }),
    ).rejects.toBeInstanceOf(QuoteV2PublicStateError);
    await expect(
      recordQuoteV2RefreshRequest(db, {
        tokenHash: viewerTokenHash,
        command,
        idempotencyKeyHash: digest(`${run}:viewer-key`),
        requestHash,
        correlationId,
        now,
      }),
    ).rejects.toThrow("view-only");
    const concurrent = await Promise.all([
      recordQuoteV2RefreshRequest(db, {
        tokenHash: signerTokenHash,
        command,
        idempotencyKeyHash: keyHash,
        requestHash,
        correlationId,
        now,
      }),
      recordQuoteV2RefreshRequest(db, {
        tokenHash: signerTokenHash,
        command,
        idempotencyKeyHash: keyHash,
        requestHash,
        correlationId,
        now: new Date(now.getTime() + 1_000),
      }),
    ]);
    const first = concurrent.find((receipt) => !receipt.replayed);
    const replay = concurrent.find((receipt) => receipt.replayed);
    expect(first).toBeDefined();
    expect(replay).toBeDefined();
    if (!first || !replay) {
      throw new Error("refresh_concurrency_receipt_failed");
    }
    expect(first).toMatchObject({
      quoteId: quote.id,
      versionId: version.id,
      responseType: "refresh_requested",
      replayed: false,
    });
    expect(replay).toMatchObject({
      responseId: first.responseId,
      changeRequestId: first.changeRequestId,
      replayed: true,
    });
    await expect(
      recordQuoteV2RefreshRequest(db, {
        tokenHash: viewerTokenHash,
        command,
        idempotencyKeyHash: keyHash,
        requestHash,
        correlationId,
        now,
      }),
    ).rejects.toThrow("view-only");
    await expect(
      recordQuoteV2RefreshRequest(db, {
        tokenHash: otherSignerTokenHash,
        command,
        idempotencyKeyHash: keyHash,
        requestHash,
        correlationId,
        now,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      recordQuoteV2RefreshRequest(db, {
        tokenHash: signerTokenHash,
        command,
        idempotencyKeyHash: digest(`${run}:second-request`),
        requestHash,
        correlationId,
        now,
      }),
    ).rejects.toThrow("already being prepared");

    const [responses, changes, tasks, activities, audits, unchanged] =
      await Promise.all([
        db
          .select({ id: quoteResponses.id })
          .from(quoteResponses)
          .where(
            and(
              eq(quoteResponses.quoteVersionId, version.id),
              eq(quoteResponses.responseType, "refresh_requested"),
            ),
          ),
        db
          .select({ id: quoteChangeRequests.id })
          .from(quoteChangeRequests)
          .where(eq(quoteChangeRequests.quoteVersionId, version.id)),
        db
          .select({ id: crmTasks.id, assignedTo: crmTasks.assignedTo })
          .from(crmTasks)
          .where(eq(crmTasks.salesOpportunityId, opportunity.id)),
        db
          .select({ id: quoteActivityEvents.id })
          .from(quoteActivityEvents)
          .where(
            and(
              eq(quoteActivityEvents.quoteVersionId, version.id),
              eq(quoteActivityEvents.eventType, "refresh_requested"),
            ),
          ),
        db
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.entityId, first.changeRequestId!),
              eq(auditLogs.action, "quote.public_refresh_requested.v2"),
            ),
          ),
        db
          .select({
            state: quoteVersions.state,
            expiresAt: quoteVersions.expiresAt,
          })
          .from(quoteVersions)
          .where(eq(quoteVersions.id, version.id)),
      ]);

    // Locate the event by its version-bound ID-only payload; its UUID is not
    // intentionally exposed in the customer receipt.
    const matchingEvents = await db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "quote.change_requested.v2"));
    const matchingVersionEvents = matchingEvents.filter(
      ({ payload }) =>
        payload?.["quoteId"] === quote.id &&
        payload?.["versionId"] === version.id &&
        payload?.["responseId"] === first.responseId,
    );
    expect(responses).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(tasks).toEqual([{ id: first.taskId, assignedTo: owner.id }]);
    expect(activities).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(unchanged).toEqual([{ state: "issued", expiresAt }]);
    expect(matchingVersionEvents).toHaveLength(1);
    const serializedEvent = JSON.stringify(matchingVersionEvents[0]?.payload);
    expect(serializedEvent).not.toContain(signerTokenHash);
    expect(serializedEvent).not.toContain(keyHash);
    expect(serializedEvent).not.toContain(command.message);

    const replayInput = {
      tokenHash: signerTokenHash,
      command,
      idempotencyKeyHash: keyHash,
      requestHash,
      correlationId,
      now,
    };
    await db
      .update(quoteCapabilities)
      .set({
        status: "revoked",
        revokedAt: now,
        revocationReason: "test_revocation",
      })
      .where(eq(quoteCapabilities.tokenHash, signerTokenHash));
    await expect(
      recordQuoteV2RefreshRequest(db, replayInput),
    ).rejects.toMatchObject({ code: "gone" });

    await db
      .update(quoteCapabilities)
      .set({
        status: "active",
        revokedAt: null,
        revocationReason: null,
        actionExpiresAt: null,
        readExpiresAt: new Date("2030-01-15T15:00:00.000Z"),
      })
      .where(eq(quoteCapabilities.tokenHash, signerTokenHash));
    await expect(
      recordQuoteV2RefreshRequest(db, replayInput),
    ).rejects.toMatchObject({ code: "gone" });

    await db
      .update(quoteCapabilities)
      .set({ readExpiresAt })
      .where(eq(quoteCapabilities.tokenHash, signerTokenHash));
    await db
      .update(contacts)
      .set({
        deletedAt: now,
        purgeEligibleAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      })
      .where(eq(contacts.id, contact.id));
    await expect(
      recordQuoteV2RefreshRequest(db, replayInput),
    ).rejects.toMatchObject({ code: "gone" });
  });
});
