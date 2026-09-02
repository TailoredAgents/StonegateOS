import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  closeDbForTests,
  getDb,
  outboxEvents,
  quoteResponses,
  quoteVersions,
  quotes,
  salesOpportunities,
} from "@/db";
import {
  persistQuoteV2TerminalDecision,
  QuoteV2TerminalDecisionConflict,
} from "@/lib/quote-v2-terminal-decision";
import {
  reconcileQuoteAcceptanceCertificate,
  type QuoteAcceptanceCertificateEnsurer,
} from "@/lib/quote-v2-acceptance-certificate";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;
const HASH = "c".repeat(64);
const NOW = new Date("2035-09-01T14:00:00.000Z");

function sslOptions(connectionString: string) {
  return process.env["DATABASE_SSL"] === "true" ||
    /render\.com|sslmode=require/u.test(connectionString)
    ? { ssl: { rejectUnauthorized: false } }
    : {};
}

describeWithDatabase("Quote V2 terminal actor contention", () => {
  let admin: ReturnType<typeof postgres>;
  let schemaName = "";

  beforeAll(async () => {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    admin = postgres(connectionString, {
      prepare: false,
      max: 1,
      onnotice: () => undefined,
      ...sslOptions(connectionString),
    });
    schemaName = `quote_v2_race_${randomUUID().replaceAll("-", "")}`;
    if (!/^quote_v2_race_[0-9a-f]{32}$/u.test(schemaName)) {
      throw new Error("quote_race_schema_invalid");
    }
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    for (const table of [
      "sales_opportunities",
      "quotes",
      "quote_versions",
      "quote_responses",
      "quote_capabilities",
      "outbox_events",
    ]) {
      await admin.unsafe(
        `CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
  });

  afterAll(async () => {
    if (/^quote_v2_race_[0-9a-f]{32}$/u.test(schemaName)) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
    await admin.end({ timeout: 2 });
    await closeDbForTests();
  });

  it("commits exactly one terminal result when public, Staff, and Partner actors race", async () => {
    const contactId = randomUUID();
    const propertyId = randomUUID();
    const opportunityId = randomUUID();
    const quoteId = randomUUID();
    const versionId = randomUUID();
    const partnerAccountId = randomUUID();
    const partnerMembershipId = randomUUID();
    const partnerUserId = randomUUID();
    const teamMemberId = randomUUID();
    const quoteNumber = `Q-RACE-${randomUUID()}`;

    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL search_path TO "${schemaName}", public`),
      );
      await tx.insert(salesOpportunities).values({
        id: opportunityId,
        contactId,
        propertyId,
        name: "Terminal decision actor race",
        status: "open",
        pipelineStage: "quoted",
        currency: "USD",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await tx.insert(quotes).values({
        id: quoteId,
        salesOpportunityId: opportunityId,
        partnerAccountId,
        engineVersion: "v2",
        aggregateState: "open",
        aggregateRevision: 1,
        contactId,
        propertyId,
        status: "sent",
        services: ["custom"],
        addOns: [],
        zoneId: "quote-terminal-race",
        travelFee: "0",
        discounts: "0",
        addOnsTotal: "0",
        subtotal: "100",
        total: "100",
        depositDue: "0",
        depositRate: "0",
        balanceDue: "100",
        lineItems: [],
        quoteNumber,
        revision: 1,
        jobDurationMinutes: 120,
        createdAt: NOW,
        updatedAt: NOW,
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
        documentSchemaHash: HASH,
        pricingHash: HASH,
        templateHash: HASH,
        contentHash: HASH,
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
        validFrom: NOW,
        readyAt: NOW,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await tx
        .update(quotes)
        .set({ currentVersionId: versionId, publishedVersionId: versionId })
        .where(eq(quotes.id, quoteId));
    });

    const context = {
      quoteId,
      quoteNumber,
      versionId,
      versionNumber: 1,
      contactId,
      opportunityId,
      opportunityStatus: "open" as const,
      opportunityRevision: 1,
      quoteRevision: 1,
    };
    const contenders: Array<{
      source: "customer" | "team_member" | "partner_member";
      responseValues: typeof quoteResponses.$inferInsert;
    }> = [
      {
        source: "customer",
        responseValues: {
          quoteId,
          quoteVersionId: versionId,
          responseType: "declined",
          source: "customer",
          signerSnapshot: { name: "Public signer" },
          selectedOptionIds: [],
          reason: "timing",
          message: "Public terminal contender",
          idempotencyKeyHash: "1".repeat(64),
          requestMetadata: { interactionSource: "public_quote" },
          respondedAt: NOW,
          createdAt: NOW,
        },
      },
      {
        source: "team_member",
        responseValues: {
          quoteId,
          quoteVersionId: versionId,
          responseType: "declined",
          source: "team_member",
          teamMemberId,
          signerSnapshot: { name: "Staff recorder" },
          selectedOptionIds: [],
          reason: "timing",
          message: "Staff terminal contender",
          idempotencyKeyHash: "2".repeat(64),
          requestMetadata: { interactionSource: "staff_quote_v2" },
          respondedAt: NOW,
          createdAt: NOW,
        },
      },
      {
        source: "partner_member",
        responseValues: {
          quoteId,
          quoteVersionId: versionId,
          responseType: "declined",
          source: "partner_member",
          partnerAccountId,
          partnerMembershipId,
          partnerUserId,
          signerSnapshot: { name: "Partner signer" },
          selectedOptionIds: [],
          reason: "timing",
          message: "Partner terminal contender",
          idempotencyKeyHash: "3".repeat(64),
          requestHash: "4".repeat(64),
          requestMetadata: { interactionSource: "partner_portal_v2" },
          respondedAt: NOW,
          createdAt: NOW,
        },
      },
    ];

    const settled = await Promise.allSettled(
      contenders.map((contender) =>
        getDb().transaction(async (tx) => {
          await tx.execute(
            sql.raw(`SET LOCAL search_path TO "${schemaName}", public`),
          );
          return persistQuoteV2TerminalDecision(tx, {
            context,
            decision: "declined",
            responseValues: contender.responseValues,
            acceptedTotals: null,
            decisionNotes: "timing\nActor contention proof",
            correlationId: randomUUID(),
            now: NOW,
          });
        }),
      ),
    );

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(2);
    for (const result of settled) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(QuoteV2TerminalDecisionConflict);
        expect((result.reason as QuoteV2TerminalDecisionConflict).reason).toBe(
          "version_changed",
        );
      }
    }

    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL search_path TO "${schemaName}", public`),
      );
      const [quote] = await tx
        .select({
          state: quotes.aggregateState,
          revision: quotes.aggregateRevision,
        })
        .from(quotes)
        .where(eq(quotes.id, quoteId));
      const [version] = await tx
        .select({ state: quoteVersions.state })
        .from(quoteVersions)
        .where(eq(quoteVersions.id, versionId));
      const [opportunity] = await tx
        .select({
          status: salesOpportunities.status,
          revision: salesOpportunities.revision,
        })
        .from(salesOpportunities)
        .where(eq(salesOpportunities.id, opportunityId));
      const responses = await tx
        .select({ source: quoteResponses.source })
        .from(quoteResponses)
        .where(
          and(
            eq(quoteResponses.quoteId, quoteId),
            eq(quoteResponses.quoteVersionId, versionId),
          ),
        );
      const events = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(sql`${outboxEvents.payload} ->> 'quoteId' = ${quoteId}`);

      expect(quote).toEqual({ state: "declined", revision: 2 });
      expect(version).toEqual({ state: "declined" });
      expect(opportunity).toEqual({ status: "lost", revision: 2 });
      expect(responses).toHaveLength(1);
      expect(["customer", "team_member", "partner_member"]).toContain(
        responses[0]?.source,
      );
      expect(events).toHaveLength(1);
    });
  });

  it("keeps accepted certificate intent durable across a derived-storage fault and retry", async () => {
    const contactId = randomUUID();
    const propertyId = randomUUID();
    const opportunityId = randomUUID();
    const quoteId = randomUUID();
    const versionId = randomUUID();
    const quoteNumber = `Q-CERTIFICATE-${randomUUID()}`;
    const response = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL search_path TO "${schemaName}", public`),
      );
      await tx.insert(salesOpportunities).values({
        id: opportunityId,
        contactId,
        propertyId,
        name: "Certificate recovery proof",
        status: "open",
        pipelineStage: "quoted",
        currency: "USD",
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await tx.insert(quotes).values({
        id: quoteId,
        salesOpportunityId: opportunityId,
        engineVersion: "v2",
        aggregateState: "open",
        aggregateRevision: 1,
        contactId,
        propertyId,
        status: "sent",
        services: ["custom"],
        addOns: [],
        zoneId: "quote-certificate-recovery",
        travelFee: "0",
        discounts: "0",
        addOnsTotal: "0",
        subtotal: "100",
        total: "100",
        depositDue: "0",
        depositRate: "0",
        balanceDue: "100",
        lineItems: [],
        quoteNumber,
        revision: 1,
        jobDurationMinutes: 120,
        createdAt: NOW,
        updatedAt: NOW,
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
        documentSchemaHash: HASH,
        pricingHash: HASH,
        templateHash: HASH,
        contentHash: HASH,
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
        validFrom: NOW,
        readyAt: NOW,
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000),
        createdAt: NOW,
        updatedAt: NOW,
      });
      await tx
        .update(quotes)
        .set({ currentVersionId: versionId, publishedVersionId: versionId })
        .where(eq(quotes.id, quoteId));

      return persistQuoteV2TerminalDecision(tx, {
        context: {
          quoteId,
          quoteNumber,
          versionId,
          versionNumber: 1,
          contactId,
          opportunityId,
          opportunityStatus: "open",
          opportunityRevision: 1,
          quoteRevision: 1,
        },
        decision: "accepted",
        responseValues: {
          quoteId,
          quoteVersionId: versionId,
          responseType: "accepted",
          source: "customer",
          signerSnapshot: {
            name: "Certificate signer",
            title: "Authorized approver",
            authorityAffirmed: true,
          },
          configurationSnapshot: { selectedOptionIds: [] },
          selectedOptionIds: [],
          consentText: "I accept this proposal.",
          consentVersion: "certificate-test-v1",
          consentAffirmed: true,
          configurationHash: "1".repeat(64),
          consentHash: "2".repeat(64),
          contentHash: HASH,
          issuedPdfHash: "3".repeat(64),
          acceptedTotalMinCents: 10_000,
          acceptedTotalMaxCents: 10_000,
          acceptedDepositCents: 0,
          acceptedBalanceMinCents: 10_000,
          acceptedBalanceMaxCents: 10_000,
          idempotencyKeyHash: "4".repeat(64),
          requestMetadata: {
            certificateIntent: {
              schemaVersion: 1,
              state: "pending",
              source: "immutable_quote_response",
            },
          },
          respondedAt: NOW,
          createdAt: NOW,
        },
        acceptedTotals: {
          selectedOptionIds: [],
          subtotalMinCents: 10_000,
          discountMinCents: 0,
          totalMinCents: 10_000,
          depositCents: 0,
          balanceMinCents: 10_000,
        },
        decisionNotes: null,
        correlationId: randomUUID(),
        now: NOW,
      });
    });

    let attempts = 0;
    const ensure: QuoteAcceptanceCertificateEnsurer = (_db, input) => {
      attempts += 1;
      if (attempts === 1)
        return Promise.reject(new Error("injected_storage_failure"));
      return Promise.resolve({
        documentId: randomUUID(),
        quoteId,
        versionId,
        responseId: input.responseId,
        sha256: "5".repeat(64),
        state: "created",
      });
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await expect(
        reconcileQuoteAcceptanceCertificate(
          getDb(),
          { responseId: response.responseId },
          { ensure },
        ),
      ).resolves.toEqual({ state: "pending", retryable: true });
      await expect(
        reconcileQuoteAcceptanceCertificate(
          getDb(),
          { responseId: response.responseId },
          { ensure },
        ),
      ).resolves.toMatchObject({ state: "ready" });
    } finally {
      console.warn = warn;
    }

    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL search_path TO "${schemaName}", public`),
      );
      const [quote] = await tx
        .select({ state: quotes.aggregateState })
        .from(quotes)
        .where(eq(quotes.id, quoteId));
      const rows = await tx
        .select({
          id: quoteResponses.id,
          metadata: quoteResponses.requestMetadata,
        })
        .from(quoteResponses)
        .where(eq(quoteResponses.quoteVersionId, versionId));
      expect(quote?.state).toBe("accepted");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: response.responseId,
        metadata: {
          certificateIntent: {
            schemaVersion: 1,
            state: "pending",
            source: "immutable_quote_response",
          },
        },
      });
      expect(attempts).toBe(2);
    });
  });
});
