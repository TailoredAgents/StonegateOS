import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { registerApiAliases } from "./lib/register-api-aliases";
async function main() {
  registerApiAliases();
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  assert.equal(
    url.hostname,
    "127.0.0.1",
    "Use an isolated local database only",
  );
  assert.equal(url.port, "5446");
  assert.equal(url.pathname, "/campaign_integration");
  process.env.NODE_ENV = "test";
  process.env.TEAM_KILL_EXTERNAL_SENDS = "true";
  Object.assign(process.env, {
    SMS_CAMPAIGNS_ENABLED: "true",
    SMS_CAMPAIGN_SENDS_ENABLED: "true",
    SMS_CAMPAIGN_MARKETING_VERIFIED: "true",
    SMS_CAMPAIGN_PRICING_VERIFIED: "true",
    SMS_CAMPAIGN_INTERVAL_SECONDS: "10",
    SMS_CAMPAIGN_SEGMENT_PRICE_USD: "0.02",
    SMS_CAMPAIGN_TEST_NUMBERS: "+12025550199",
    TWILIO_FROM: "+12025550198",
    TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
    TWILIO_AUTH_TOKEN: "local-test-no-network",
    WINTER_SALE_ENABLED: "true",
  });
  const dbm = await import("../apps/api/src/db");
  const { eq, sql } = createRequire(path.resolve("apps/api/package.json"))(
    "drizzle-orm",
  );
  const sdk = await import("../packages/sdk/src/sms-campaigns");
  const service = await import("../apps/api/src/lib/sms-campaigns");
  const dispatch = await import(
    "../apps/api/src/lib/external-message-dispatch"
  );
  const guard = await import("../apps/api/src/lib/sms-campaign-dispatch");
  const domain = await import("../apps/api/src/lib/quote-v2-domain");
  const client = await import(
    "../apps/site/src/app/quote/[token]/quote-v2-customer-model"
  );
  const db = dbm.getDb();
  let passed = 0;
  function pass(name: string) {
    console.log(`PASS ${name}`);
    passed++;
  }
  const actor = randomUUID();
  const context = { actor: { id: actor } } as Parameters<
    typeof service.mutateCampaign
  >[1];
  const mutate = (command: Parameters<typeof service.mutateCampaign>[2]) =>
    db.transaction((tx) => service.mutateCampaign(tx, context, command));
  try {
    await db.execute(sql.raw("SET client_min_messages TO warning"));
    await db.execute(
      sql.raw(
        "TRUNCATE sms_campaigns, sms_marketing_consents, contacts CASCADE",
      ),
    );
    assert.deepEqual(sdk.winterSalePrice(50000), {
      normalCents: 50000,
      discountCents: 20000,
      finalCents: 30000,
      basisPoints: 4000,
    });
    assert.equal(sdk.winterSalePrice(101).finalCents, 61);
    assert.throws(() => sdk.winterSalePrice(-1));
    assert.equal(sdk.smsSegments("a".repeat(160)), 1);
    assert.equal(sdk.smsSegments("a".repeat(161)), 2);
    assert.equal(sdk.smsSegments("^".repeat(81)), 2);
    assert.equal(sdk.smsSegments("😀".repeat(36)), 2);
    pass("40% calculation and SMS encoding boundaries");
    const terms = {
      name: "Winter test",
      expiresAt: "2099-11-29T23:00:00Z",
      serviceThrough: "2099-11-30",
      introduction: "Winter sale.",
      retroactivePolicy: "new_quotes_only",
      stackingPolicy: "no_stacking",
    } as const;
    const promotion = {
      campaignId: randomUUID(),
      name: "Winter sale",
      basisPoints: 4000 as const,
      expiresAt: terms.expiresAt,
      serviceThrough: terms.serviceThrough,
    };
    const pricing = {
      documentType: "fixed_quote" as const,
      currency: "USD" as const,
      winterSale: promotion,
      lineItems: [
        {
          id: "haul",
          name: "Haul",
          description: "Junk",
          quantity: 1,
          unit: "job",
          unitPriceMinCents: 50000,
          displayOrder: 0,
        },
      ],
      optionGroups: [],
      adjustments: [
        {
          id: "travel",
          kind: "travel" as const,
          label: "Travel",
          calculation: "fixed" as const,
          basis: "subtotal" as const,
          eligibleLineItemIds: [],
          amountCents: 5000,
          displayOrder: 0,
        },
      ],
      deposit: { mode: "percentage" as const, basisPoints: 2500 },
    };
    const total = domain.calculateQuoteV2Totals(pricing);
    assert.equal(total.totalMinCents, 33000);
    assert.equal(total.discountMinCents, 22000);
    assert.equal(total.depositCents, 8250);
    const live = client.calculateQuoteV2LivePricing(
      { document: { pricing } } as any,
      [],
    );
    assert.equal(live.totals.totalMinCents, total.totalMinCents);
    pass(
      "Quote totals include fees, customer options and deposits use the discounted total",
    );
    await db.transaction(async (tx) => {
      const schema = "campaign_migration_" + randomUUID().replaceAll("-", "");
      await tx.execute(sql.raw("CREATE SCHEMA " + schema));
      await tx.execute(sql.raw("SET LOCAL search_path TO " + schema));
      await tx.execute(
        sql.raw(
          "CREATE TABLE contacts(id uuid PRIMARY KEY); CREATE TABLE conversation_messages(id uuid PRIMARY KEY)",
        ),
      );
      await tx.execute(
        sql.raw(
          await readFile(
            "apps/api/src/db/migrations/0184_sms_campaigns.sql",
            "utf8",
          ),
        ),
      );
    });
    pass("Additive migration applies on a fresh isolated schema");
    const [owner] = await db
      .insert(dbm.contacts)
      .values({
        firstName: "Owner",
        lastName: "Test",
        phoneE164: "+12025550199",
      })
      .returning();
    const customers = [];
    for (let i = 0; i < 29; i++) {
      const [c] = await db
        .insert(dbm.contacts)
        .values({
          firstName: `Customer${i}`,
          lastName: "Test",
          phoneE164: `+12025550${String(100 + i).padStart(3, "0")}`,
        })
        .returning();
      const [property] = await db
        .insert(dbm.properties)
        .values({
          contactId: c!.id,
          addressLine1: `${i} Test St`,
          city: "Woodstock",
          state: "GA",
          postalCode: "30188",
        })
        .returning();
      await db.insert(dbm.appointments).values({
        contactId: c!.id,
        propertyId: property!.id,
        status: "completed",
        rescheduleToken: randomUUID(),
      });
      if (i < 28)
        await mutate({
          action: "consent",
          contactId: c!.id,
          status: "granted",
          source: "test fixture",
          evidence: "Synthetic written marketing permission",
          capturedAt: "2026-01-01T12:00:00Z",
          timeZone: "America/New_York",
        });
      customers.push(c!);
    }
    const created = await mutate({ action: "create", terms });
    const campaignId = String(created.campaignId);
    const loadCampaign = async () => {
      const [c] = await db
        .select()
        .from(dbm.smsCampaigns)
        .where(eq(dbm.smsCampaigns.id, campaignId));
      return c!;
    };
    let c = await loadCampaign();
    let audience = await service.campaignAudience(db, c);
    assert.equal(audience.filter((r) => !r.reason).length, 28);
    assert.match(
      audience.find((r) => r.contactId === customers[28]!.id)!.reason!,
      /consent/,
    );
    assert.match(
      audience.find((r) => r.contactId === owner!.id)!.reason!,
      /test number/,
    );
    pass("Audience excludes missing consent and owner test numbers");
    assert.equal(
      service.CampaignCommandSchema.safeParse({
        action: "review",
        campaignId,
        version: 1,
        contactIds: customers.slice(0, 26).map((c) => c.id),
      }).success,
      false,
    );
    const test = await mutate({
      action: "test",
      campaignId,
      version: 1,
      testPhone: "+12025550199",
    });
    await db
      .update(dbm.conversationMessages)
      .set({ deliveryStatus: "delivered" })
      .where(eq(dbm.conversationMessages.id, String(test.messageId)));
    const review = (
      await mutate({
        action: "review",
        campaignId,
        version: 1,
        contactIds: customers.slice(0, 25).map((c) => c.id),
      })
    ).review as any;
    assert.equal(review.recipients.length, 25);
    const race = await Promise.allSettled([
      mutate({
        action: "release",
        campaignId,
        version: 1,
        reviewId: review.id,
        capacityConfirmed: true,
      }),
      mutate({
        action: "release",
        campaignId,
        version: 1,
        reviewId: review.id,
        capacityConfirmed: true,
      }),
    ]);
    if (!race.some((r) => r.status === "fulfilled")) console.error(race);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    const released = await db
      .select()
      .from(dbm.smsCampaignRecipients)
      .where(eq(dbm.smsCampaignRecipients.campaignId, campaignId));
    assert.equal(released.filter((r) => !r.isTest).length, 25);
    pass("Two simultaneous launches release exactly one approved batch of 25");
    c = await loadCampaign();
    await mutate({ action: "pause", campaignId, version: c.version });
    const recipient = released.find((r) => !r.isTest)!;
    const events = await db
      .select()
      .from(dbm.outboxEvents)
      .where(
        sql`${dbm.outboxEvents.payload}->>'messageId' = ${recipient.messageId}`,
      );
    const event = events[0]!;
    const requested = await dispatch.ensureMessageDispatchRequested({
      outboxEventId: event.id,
      messageId: recipient.messageId!,
      contactId: recipient.contactId,
      channel: "sms",
      attemptNumber: 1,
    });
    assert.equal(requested.kind, "ready");
    const dispatchId = (requested as any).dispatch.id;
    assert.equal(
      (await dispatch.claimMessageDispatch({ dispatchId })).kind,
      "in_flight",
    );
    pass("Paused campaign holds durable dispatch without provider submission");
    c = await loadCampaign();
    await mutate({ action: "resume", campaignId, version: c.version });
    await mutate({
      action: "consent",
      contactId: recipient.contactId,
      status: "revoked",
      source: "test withdrawal",
      evidence: "Customer withdrew marketing permission",
      capturedAt: "2026-01-01T12:00:00Z",
      timeZone: "America/New_York",
    });
    const blocked = await dispatch.claimMessageDispatch({ dispatchId });
    assert.equal(blocked.kind, "settled");
    assert.equal((blocked as any).state, "failed");
    pass("Revocation after queueing blocks the actual dispatch claim");
    const second = released.filter((r) => !r.isTest)[1]!;
    await db.transaction((tx) =>
      guard.recordCampaignInbound(
        tx,
        second.phone,
        second.contactId,
        "STOP",
        new Date(),
      ),
    );
    const consent = await service.latestCampaignConsent(db, second.phone);
    assert.equal(consent!.status, "revoked");
    pass("Inbound STOP records suppression and revocation");
    c = await loadCampaign();
    const stale = (
      await mutate({
        action: "review",
        campaignId,
        version: c.version,
        contactIds: [customers[25]!.id],
      })
    ).review as any;
    await mutate({ action: "pause", campaignId, version: c.version });
    await assert.rejects(
      mutate({
        action: "release",
        campaignId,
        version: c.version,
        reviewId: stale.id,
        capacityConfirmed: true,
      }),
      /changed/,
    );
    pass("Stale campaign reviews cannot release messages");
    const workspace = await service.readCampaignWorkspace(campaignId, "", true);
    assert.equal(workspace.metrics.released, 25);
    assert.equal(workspace.metrics.optedOut, 2);
    assert.equal(workspace.outcomes?.collectedCents, 0);
    assert.equal(workspace.capacity?.hasOpening, true);
    pass(
      "Delivery, consent, financial and real schedule reports load without counting owner tests",
    );
    const [reportProperty] = await db
      .select()
      .from(dbm.properties)
      .where(eq(dbm.properties.contactId, customers[26]!.id))
      .limit(1);
    const [reportQuote] = await db
      .insert(dbm.quotes)
      .values({
        contactId: customers[26]!.id,
        propertyId: reportProperty!.id,
        engineVersion: "v2",
        aggregateState: "open",
        aggregateRevision: 1,
        quoteNumber: `TEST-${randomUUID()}`,
        services: ["junk_removal"],
        zoneId: "local-test",
        travelFee: "50",
        discounts: "220",
        addOnsTotal: "0",
        subtotal: "500",
        total: "330",
        depositDue: "82.5",
        depositRate: "0.25",
        balanceDue: "247.5",
        lineItems: [],
      })
      .returning();
    const hashes = {
      documentSchemaHash: "a".repeat(64),
      pricingHash: "a".repeat(64),
      templateHash: "a".repeat(64),
      contentHash: "a".repeat(64),
    };
    const [reportVersion] = await db
      .insert(dbm.quoteVersions)
      .values({
        quoteId: reportQuote!.id,
        versionNumber: 1,
        state: "issued",
        documentType: "fixed_quote",
        audience: "residential",
        schedulingMode: "staff_followup",
        documentSnapshot: {
          pricing: { ...pricing, winterSale: { ...promotion, campaignId } },
        },
        canonicalRenderJson: "{}",
        ...hashes,
        subtotalMinCents: 50000,
        subtotalMaxCents: 50000,
        feeMinCents: 5000,
        feeMaxCents: 5000,
        discountMinCents: 22000,
        discountMaxCents: 22000,
        totalMinCents: 33000,
        totalMaxCents: 33000,
        depositCents: 8250,
        balanceMinCents: 24750,
        balanceMaxCents: 24750,
        readyAt: new Date(),
        issuedAt: new Date(),
        expiresAt: new Date(terms.expiresAt),
      })
      .returning();
    await db
      .update(dbm.quotes)
      .set({
        publishedVersionId: reportVersion!.id,
        currentVersionId: reportVersion!.id,
      })
      .where(eq(dbm.quotes.id, reportQuote!.id));
    const [reportJob] = await db
      .insert(dbm.appointments)
      .values({
        contactId: customers[26]!.id,
        propertyId: reportProperty!.id,
        quoteVersionId: reportVersion!.id,
        status: "confirmed",
        quotedTotalCents: 33000,
        rescheduleToken: randomUUID(),
      })
      .returning();
    const [payment] = await db
      .insert(dbm.payments)
      .values({
        appointmentId: reportJob!.id,
        quoteId: reportQuote!.id,
        quoteVersionId: reportVersion!.id,
        provider: "square",
        providerPaymentId: `TEST-${randomUUID()}`,
        amount: 33000,
        currency: "USD",
        status: "completed",
        canonicalStatus: "completed",
        refundedAmountCents: 5000,
      })
      .returning();
    await db.insert(dbm.paymentRefunds).values({
      paymentId: payment!.id,
      provider: "square",
      providerRefundId: `TEST-${randomUUID()}`,
      amountCents: 5000,
      canonicalStatus: "completed",
    });
    await db.insert(dbm.payments).values({
      appointmentId: reportJob!.id,
      amount: 10000,
      currency: "USD",
      status: "pending",
      canonicalStatus: "pending",
    });
    const reporting = await import(
      "../apps/api/src/lib/sms-campaign-reporting"
    );
    const finance = await reporting.readCampaignOutcomes(db, campaignId);
    assert.deepEqual(finance, {
      quoted: 1,
      quotedMinCents: 33000,
      quotedMaxCents: 33000,
      booked: 1,
      bookedCents: 33000,
      collectedCents: 28000,
    });
    await db
      .update(dbm.appointments)
      .set({ status: "canceled" })
      .where(eq(dbm.appointments.id, reportJob!.id));
    const cancelledFinance = await reporting.readCampaignOutcomes(
      db,
      campaignId,
    );
    assert.equal(cancelledFinance.booked, 0);
    assert.equal(cancelledFinance.collectedCents, 28000);
    pass(
      "Offer attribution keeps quoted, booked and collected values separate, excludes pending payments and counts refunds once",
    );

    c = await loadCampaign();
    await mutate({ action: "resume", campaignId, version: c.version });
    const normalRecipient = released.filter((r) => !r.isTest)[2]!;
    const [normalEvent] = await db
      .select()
      .from(dbm.outboxEvents)
      .where(
        sql`${dbm.outboxEvents.payload}->>'messageId' = ${normalRecipient.messageId}`,
      );
    const daytime = new Date();
    daytime.setUTCHours(17, 0, 0, 0);
    const gateInput = {
      recipientId: normalRecipient.id,
      messageId: normalRecipient.messageId!,
      contactId: normalRecipient.contactId,
      outboxId: normalEvent!.id,
      now: daytime,
    };
    const normalGuard = await db.transaction((tx) =>
      guard.guardCampaignDispatch(tx, gateInput),
    );
    assert.deepEqual(normalGuard, { block: null });
    const repeated = await db.transaction((tx) =>
      guard.guardCampaignDispatch(tx, gateInput),
    );
    assert.equal(repeated.block, "campaign_send_already_claimed");
    pass(
      "Eligible dispatch checks capacity and acquires one irreversible provider submission claim",
    );

    const heldRecipient = released.filter((r) => !r.isTest)[3]!;
    const [heldEvent] = await db
      .select()
      .from(dbm.outboxEvents)
      .where(
        sql`${dbm.outboxEvents.payload}->>'messageId' = ${heldRecipient.messageId}`,
      );
    const night = new Date(daytime);
    night.setUTCHours(3, 0, 0, 0);
    const nightGuard = await db.transaction((tx) =>
      guard.guardCampaignDispatch(tx, {
        recipientId: heldRecipient.id,
        messageId: heldRecipient.messageId!,
        contactId: heldRecipient.contactId,
        outboxId: heldEvent!.id,
        now: night,
      }),
    );
    assert.ok(nightGuard.retryAt);
    assert.equal(nightGuard.block, null);
    pass(
      "Recipient-local quiet hours defer work without claiming or submitting it",
    );

    const newCampaign = await mutate({ action: "create", terms });
    const [newRow] = await db
      .select()
      .from(dbm.smsCampaigns)
      .where(eq(dbm.smsCampaigns.id, String(newCampaign.campaignId)));
    const clonedAudience = await service.campaignAudience(db, newRow!);
    assert.match(
      clonedAudience.find((r) => r.contactId === heldRecipient.contactId)!
        .reason!,
      /recent winter campaign/,
    );
    pass("Creating another campaign cannot bypass the destination cooldown");

    const winter = await import("../apps/api/src/lib/winter-sale");
    assert.equal(
      winter.winterServiceDateAllowed(promotion, "2099-12-01T04:59:00Z"),
      true,
    );
    assert.equal(
      winter.winterServiceDateAllowed(promotion, "2099-12-01T05:00:00Z"),
      false,
    );
    const discounted = winter.winterSaleEstimate(
      { priceLow: 100.01, priceHigh: 200.02 },
      promotion,
    );
    assert.equal(discounted.priceLowDiscounted, 60.01);
    assert.equal(
      winter.winterSaleEstimate(discounted, promotion).priceLowDiscounted,
      60.01,
    );
    pass(
      "Eastern service cutoff and repeat discount calculation remain stable",
    );

    const uncertain = await dispatch.ensureMessageDispatchRequested({
      outboxEventId: heldEvent!.id,
      messageId: heldRecipient.messageId!,
      contactId: heldRecipient.contactId,
      channel: "sms",
      attemptNumber: 1,
    });
    assert.equal(uncertain.kind, "ready");
    await db
      .update(dbm.externalMessageDispatches)
      .set({
        state: "reconciliation_required",
        reconciliationRequiredAt: new Date(),
        dispatchedAt: new Date(),
        completedAt: new Date(),
        uncertaintyAt: new Date(),
        failureDetail: "Synthetic lost provider response",
        retryable: false,
      })
      .where(
        eq(dbm.externalMessageDispatches.id, (uncertain as any).dispatch.id),
      );
    const uncertainWorkspace = await service.readCampaignWorkspace(campaignId);
    assert.equal(uncertainWorkspace.metrics.uncertain, 1);
    const outcome = await dispatch.claimMessageDispatch({
      dispatchId: (uncertain as any).dispatch.id,
    });
    assert.equal(outcome.kind, "settled");
    assert.equal((outcome as any).state, "reconciliation_required");
    pass(
      "Uncertain provider results remain distinct and cannot be automatically resent",
    );

    c = await loadCampaign();
    await mutate({ action: "end", campaignId, version: c.version });
    assert.equal(await winter.activeWinterSale(db), null);
    assert.equal(
      await guard.hasCampaignConversation({ contactId: second.contactId }),
      true,
    );
    assert.equal(domain.calculateQuoteV2Totals(pricing).totalMinCents, 33000);
    pass(
      "Ending the campaign stops new sale pricing while frozen quote totals stay unchanged",
    );
    const draftId = String(newCampaign.campaignId);
    const draftTest = await mutate({
      action: "test",
      campaignId: draftId,
      version: 1,
      testPhone: "+12025550199",
    });
    const [draftTestEvent] = await db
      .select()
      .from(dbm.outboxEvents)
      .where(
        sql`${dbm.outboxEvents.payload}->>'messageId' = ${draftTest.messageId}`,
      );
    const draftAttempt = await dispatch.ensureMessageDispatchRequested({
      outboxEventId: draftTestEvent!.id,
      messageId: String(draftTest.messageId),
      contactId: owner!.id,
      channel: "sms",
      attemptNumber: 1,
    });
    assert.equal(draftAttempt.kind, "ready");
    await db
      .update(dbm.externalMessageDispatches)
      .set({
        state: "reconciliation_required",
        reconciliationRequiredAt: new Date(),
        dispatchedAt: new Date(),
        completedAt: new Date(),
        uncertaintyAt: new Date(),
        failureDetail: "Synthetic lost test response",
        retryable: false,
      })
      .where(
        eq(dbm.externalMessageDispatches.id, (draftAttempt as any).dispatch.id),
      );
    const retryTest = await mutate({
      action: "test",
      campaignId: draftId,
      version: 1,
      testPhone: "+12025550199",
    });
    const [retryRecipient] = await db
      .select()
      .from(dbm.smsCampaignRecipients)
      .where(
        eq(dbm.smsCampaignRecipients.messageId, String(retryTest.messageId)),
      );
    const [retryEvent] = await db
      .select()
      .from(dbm.outboxEvents)
      .where(
        sql`${dbm.outboxEvents.payload}->>'messageId' = ${retryTest.messageId}`,
      );
    const testGuard = await db.transaction((tx) =>
      guard.guardCampaignDispatch(tx, {
        recipientId: retryRecipient!.id,
        messageId: String(retryTest.messageId),
        contactId: owner!.id,
        outboxId: retryEvent!.id,
        now: new Date(),
      }),
    );
    assert.ok(testGuard.retryAt);
    const testWorkspace = await service.readCampaignWorkspace(draftId);
    assert.equal(testWorkspace.campaign?.status, "draft");
    assert.equal(
      testWorkspace.recipients.find((r) => r.messageId === draftTest.messageId)
        ?.deliveryStatus,
      "Needs reconciliation",
    );
    assert.equal(await winter.activeWinterSale(db), null);
    pass(
      "Uncertain owner tests stay visible and cannot activate public sale pricing",
    );
    console.log(
      `${passed} campaign verification groups passed. No provider calls were made.`,
    );
  } finally {
    await dbm.closeDbForTests();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
