import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  appointmentCommissions,
  appointmentCrewMembers,
  appointments,
  calendarSyncState,
  closeDbForTests,
  commissionManagementSplits,
  contactProperties,
  contacts,
  getDb,
  partnerAccountCostCenters,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccountSchedulingPolicies,
  partnerAccountServiceAgreements,
  partnerAccounts,
  partnerBookingDrafts,
  partnerBookings,
  partnerDocuments,
  partnerDraftMedia,
  partnerInvoices,
  partnerMembershipCostCenterScopes,
  partnerMembershipLocationScopes,
  partnerPaymentAllocations,
  partnerRateCards,
  partnerRateItems,
  partnerRoleTemplates,
  partnerSchedulingProfiles,
  partnerServiceCatalog,
  partnerUsers,
  payments,
  payoutRunLines,
  payoutRuns,
  policySettings,
  properties,
  scheduleResourcePools,
  teamMembers,
} from "@/db";
import {
  createOrReplacePartnerHold,
  createPartnerAdditionalServiceDraft,
  getPartnerBookingDraft,
  getPartnerDraftAvailability,
  submitPartnerBookingDraft,
  updatePartnerBookingDraft,
  type PartnerDraftDto,
  type PartnerSchedulingActor,
} from "@/lib/partner-portal-v2-scheduling/service";
import {
  runPartnerBillingCommand,
  type PartnerBillingCommand,
} from "@/lib/partner-billing-administration";
import { applyPartnerChangeOrderPrice } from "@/lib/partner-change-order-price";
import {
  getOrCreateCommissionSettings,
  recalculateAppointmentCommissions,
} from "@/lib/commissions";
import {
  lockAppointmentInvoiceCollection,
  reconcilePartnerAppointmentInvoices,
} from "@/lib/partner-invoice-ledger";

// These are real database/domain tests. No session, authorization, scheduling,
// billing, payment-ledger, or commission functions are mocked; no provider is called.
const localUrl = process.env["DATABASE_URL"];
const local =
  localUrl && ["127.0.0.1", "localhost"].includes(new URL(localUrl).hostname);
const suite = local ? describe : describe.skip;
const NOW = new Date("2035-06-01T12:00:00.000Z");
const ORIGINAL_COMPLETION = new Date("2035-05-20T16:00:00.000Z");
const CALENDAR_ID = `additional-service-${randomUUID()}@example.test`;
const ENV_KEYS = [
  "PARTNER_PORTAL_V2_READS_ENABLED",
  "PARTNER_PORTAL_V2_WRITES_ENABLED",
  "PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED",
  "PARTNER_PORTAL_INTERNAL_TEST_MODE",
  "PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS",
  "PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED",
  "GOOGLE_CALENDAR_ENABLED",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_ID",
  "GOOGLE_CALENDAR_TIMEZONE",
] as const;
const originalEnvironment = new Map<string, string | undefined>();
let originalPolicies: Array<typeof policySettings.$inferSelect> = [];
let originalCatalog: typeof partnerServiceCatalog.$inferSelect | undefined;
const profileIds: string[] = [];
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function fixture(
  input: {
    status?: "completed" | "confirmed" | "canceled";
    finalized?: boolean;
    paid?: boolean;
  } = {},
) {
  const accountId = randomUUID(),
    userId = randomUUID(),
    membershipId = randomUUID();
  const contactId = randomUUID(),
    propertyId = randomUUID(),
    locationId = randomUUID();
  const jobId = randomUUID(),
    appointmentId = randomUUID(),
    invoiceId = randomUUID();
  const paymentId = randomUUID(),
    teamMemberId = randomUUID(),
    payoutRunId = randomUUID();
  const serviceKey = "junk-removal";
  const profileId = randomUUID();
  const poolKey = `extra_${accountId.replaceAll("-", "")}`;
  const email = `${userId}@example.test`;
  const status = input.status ?? "completed",
    finalized = input.finalized ?? true,
    paid = input.paid ?? true;
  const actor: PartnerSchedulingActor = {
    accountId,
    membershipId,
    partnerUserId: userId,
    email,
    sessionId: randomUUID(),
    accessLevel: "account",
    canReadRates: true,
    locationIds: [],
    propertyIds: [],
  };
  await getDb().transaction(async (tx) => {
    const [role] = await tx
      .select()
      .from(partnerRoleTemplates)
      .where(
        and(
          eq(partnerRoleTemplates.key, "operations"),
          isNull(partnerRoleTemplates.partnerAccountId),
        ),
      );
    if (!role) throw new Error("Local canonical Operations role is missing");
    await tx
      .insert(teamMembers)
      .values({ id: teamMemberId, name: "Local additional-service operator" });
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: "Local additional service",
      normalizedName: accountId,
      status: "active_partner",
      portalAccessEnabled: true,
    });
    await tx.insert(contacts).values({
      id: contactId,
      partnerAccountId: accountId,
      firstName: "Local",
      lastName: "Additional service",
      partnerStatus: "partner",
    });
    await tx
      .update(partnerAccounts)
      .set({ portalContactId: contactId })
      .where(eq(partnerAccounts.id, accountId));
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressLine1: "1 Integration Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      lat: "39.290400",
      lng: "-76.612200",
    });
    await tx.insert(contactProperties).values({
      contactId,
      propertyId,
      relationship: "partner_service_location",
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email,
      normalizedEmail: email,
      name: "Local additional-service partner",
      active: true,
      identityStatus: "active",
      emailVerifiedAt: NOW,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleTemplateId: role.id,
      roleKey: "operations",
      status: "active",
      accessLevel: "account",
      acceptedAt: NOW,
    });
    await tx.insert(partnerAccountLocations).values({
      id: locationId,
      partnerAccountId: accountId,
      propertyId,
      siteName: "Original service site",
      addressLine1: "1 Integration Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      latitude: "39.290400",
      longitude: "-76.612200",
      geocodeStatus: "verified",
      serviceAreaStatus: "eligible",
      active: true,
      accessSecretCiphertext: "LOCAL-ORIGINAL-GATE-SECRET-NOT-TO-COPY",
      accessSecretKeyVersion: 1,
    });
    await tx.insert(scheduleResourcePools).values({
      key: poolKey,
      label: "Local additional capacity",
      capacityUnits: 1,
    });
    await tx.insert(partnerSchedulingProfiles).values({
      id: profileId,
      serviceKey,
      version: 1_500_000_000 + (Date.now() % 500_000_000),
      durationMinutes: 60,
      travelBufferMinutes: 30,
      capacityPoolKey: poolKey,
      capacityUnits: 1,
      supportedTerritories: [],
      requiredScopeFields: [],
      pricingEligibility: {},
      proofDefaults: { before: 1, after: 1 },
      automaticReviewRules: {},
      instantConfirmationEnabled: true,
      active: true,
      effectiveFrom: new Date("2035-01-01T00:00:00.000Z"),
    });
    await tx.insert(partnerAccountServiceAgreements).values({
      partnerAccountId: accountId,
      active: true,
      agreementLabel: "Local additional service agreement",
      currency: "USD",
      effectiveFrom: new Date("2035-01-01T00:00:00.000Z"),
      inclusions: [],
      exclusions: [],
      serviceEntitlements: [
        {
          serviceKey,
          pricingState: "contracted",
          inclusions: [],
          exclusions: [],
          quoteRule: null,
        },
      ],
      revision: 1,
    });
    const rateCardId = randomUUID();
    await tx.insert(partnerRateCards).values({
      id: rateCardId,
      orgContactId: contactId,
      partnerAccountId: accountId,
      currency: "USD",
      active: true,
      version: 1,
      effectiveFrom: new Date("2035-01-01T00:00:00.000Z"),
    });
    await tx.insert(partnerRateItems).values({
      rateCardId,
      serviceKey,
      tierKey: "standard",
      label: "New additional work only",
      amountCents: 2500,
    });
    await tx
      .update(partnerAccountSchedulingPolicies)
      .set({ instantConfirmationEnabled: true, revision: 2 })
      .where(eq(partnerAccountSchedulingPolicies.partnerAccountId, accountId));
    await tx.insert(appointments).values({
      id: appointmentId,
      contactId,
      propertyId,
      partnerAccountId: accountId,
      type: "job",
      status,
      quotedTotalCents: 10000,
      quotedTotalMaxCents: 10000,
      finalTotalCents: finalized ? 10000 : null,
      completedAt: status === "completed" ? ORIGINAL_COMPLETION : null,
      quotedScopeText: "ORIGINAL WORK MUST NOT COPY",
      soldByMemberId: teamMemberId,
      rescheduleToken: randomUUID(),
    });
    await tx.insert(partnerBookings).values({
      id: jobId,
      orgContactId: contactId,
      partnerAccountId: accountId,
      appointmentId,
      propertyId,
      serviceKey,
      tierKey: "standard",
      amountCents: 10000,
      publicStatus: status,
      scopeSnapshot: {
        locationId,
        description: "ORIGINAL WORK MUST NOT COPY",
        accessDetails: "ONE-TIME-ORIGINAL-ACCESS",
        onSiteContact: { name: "OLD ON-SITE CONTACT" },
        scope: { oldPhoto: "ORIGINAL-MEDIA", hazards: ["ORIGINAL-HAZARD"] },
      },
      rateSnapshot: {
        amountMinor: 10000,
        source: "ORIGINAL-ACCEPTED-QUOTE",
        commissionSnapshot: "ORIGINAL-COMMISSION",
      },
      proofRequirementsSnapshot: { before: 8, after: 8 },
      poNumber: "ORIGINAL-PO",
      costCenter: "ORIGINAL-COST-CENTER",
      requestedByMembershipId: membershipId,
    });
    await tx.insert(partnerInvoices).values({
      id: invoiceId,
      partnerAccountId: accountId,
      partnerBookingId: jobId,
      invoiceNumber: `ORIGINAL-${invoiceId}`,
      status: paid ? "paid" : "issued",
      subtotalCents: 10000,
      totalCents: 10000,
      paidCents: paid ? 10000 : 0,
      balanceCents: paid ? 0 : 10000,
      billingContact: { name: "Original billing" },
      issuedAt: ORIGINAL_COMPLETION,
      paidAt: paid ? ORIGINAL_COMPLETION : null,
    });
    if (paid) {
      await tx.insert(payments).values({
        id: paymentId,
        appointmentId,
        provider: "manual",
        providerPaymentId: `local-original-${paymentId}`,
        method: "cash",
        tenderType: "cash",
        amount: 10500,
        jobAmountCents: 10000,
        tipAmountCents: 500,
        totalAmountCents: 10500,
        currency: "USD",
        status: "completed",
        canonicalStatus: "completed",
        paidAt: ORIGINAL_COMPLETION,
        capturedAt: ORIGINAL_COMPLETION,
      });
      await tx.insert(partnerPaymentAllocations).values({
        partnerAccountId: accountId,
        partnerInvoiceId: invoiceId,
        paymentId,
        amountCents: 10000,
        state: "settled",
        allocatedAt: ORIGINAL_COMPLETION,
      });
    }
    await tx.insert(partnerDocuments).values({
      partnerAccountId: accountId,
      partnerBookingId: jobId,
      documentType: "invoice",
      filename: "Original invoice.pdf",
      contentType: "application/pdf",
      byteSize: 100,
      storageBucket: "local-only-original-documents",
      storageObjectKey: `original/${jobId}.pdf`,
      sha256: "a".repeat(64),
    });
    await tx.insert(appointmentCommissions).values({
      appointmentId,
      memberId: teamMemberId,
      role: "crew",
      baseCents: 10000,
      amountCents: 3000,
      meta: { fixedOriginalEvidence: true },
    });
    await tx.insert(payoutRuns).values({
      id: payoutRunId,
      timezone: "America/New_York",
      periodStart: new Date("2035-05-20T04:00:00.000Z"),
      periodEnd: new Date("2035-05-27T04:00:00.000Z"),
      scheduledPayoutAt: new Date("2035-05-30T12:00:00.000Z"),
      status: "draft",
      reportHtml: "ORIGINAL PAYOUT REPORT",
    });
    await tx.insert(payoutRunLines).values({
      payoutRunId,
      memberId: teamMemberId,
      crewCents: 3000,
      totalCents: 3000,
    });
    await tx
      .update(payoutRuns)
      .set({ status: "locked", lockedAt: new Date("2035-05-28T12:00:00.000Z") })
      .where(eq(payoutRuns.id, payoutRunId));
    await tx
      .update(payoutRuns)
      .set({ status: "paid", paidAt: new Date("2035-05-30T12:00:00.000Z") })
      .where(eq(payoutRuns.id, payoutRunId));
  });
  profileIds.push(profileId);
  return {
    accountId,
    userId,
    membershipId,
    contactId,
    propertyId,
    locationId,
    jobId,
    appointmentId,
    invoiceId,
    paymentId,
    teamMemberId,
    payoutRunId,
    serviceKey,
    actor,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function originalEvidence(f: Fixture) {
  const db = getDb();
  return Promise.all([
    db.select().from(appointments).where(eq(appointments.id, f.appointmentId)),
    db.select().from(partnerBookings).where(eq(partnerBookings.id, f.jobId)),
    db
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.id, f.invoiceId)),
    db
      .select()
      .from(payments)
      .where(eq(payments.appointmentId, f.appointmentId)),
    db
      .select()
      .from(partnerPaymentAllocations)
      .where(eq(partnerPaymentAllocations.partnerInvoiceId, f.invoiceId)),
    db
      .select()
      .from(appointmentCommissions)
      .where(eq(appointmentCommissions.appointmentId, f.appointmentId)),
    db.select().from(payoutRuns).where(eq(payoutRuns.id, f.payoutRunId)),
    db
      .select()
      .from(payoutRunLines)
      .where(eq(payoutRunLines.payoutRunId, f.payoutRunId)),
    db
      .select()
      .from(partnerDocuments)
      .where(eq(partnerDocuments.partnerBookingId, f.jobId)),
  ]);
}
const create = (f: Fixture, idempotencyKeyHash = digest(randomUUID())) =>
  createPartnerAdditionalServiceDraft({
    actor: f.actor,
    jobId: f.jobId,
    idempotencyKeyHash,
    correlationId: randomUUID(),
    now: NOW,
  });
async function ready(f: Fixture, draft: PartnerDraftDto) {
  return updatePartnerBookingDraft({
    actor: f.actor,
    draftId: draft.id,
    ifMatch: draft.etag,
    correlationId: randomUUID(),
    now: NOW,
    mutation: {
      serviceKey: f.serviceKey,
      tierKey: "standard",
      description: "Remove only the NEW additional items requested today.",
      onSiteContact: {
        name: "New site contact",
        email: "new-site@example.test",
      },
      proofRequirements: { before: 1, after: 1 },
      preferredWindows: [
        {
          localDate: "2035-06-04",
          timeOfDay: "anytime",
          timezone: "America/New_York",
        },
      ],
    },
  });
}
const submit = (
  f: Fixture,
  draft: PartnerDraftDto,
  key = digest(randomUUID()),
  holdId: string | null = null,
) =>
  submitPartnerBookingDraft({
    actor: f.actor,
    draftId: draft.id,
    ifMatch: draft.etag,
    idempotencyKeyHash: key,
    holdId,
    correlationId: randomUUID(),
    now: NOW,
  });
async function billing(
  f: Fixture,
  command: PartnerBillingCommand,
  revision?: number,
) {
  return getDb().transaction((tx) =>
    runPartnerBillingCommand(tx, {
      accountId: f.accountId,
      actorId: f.teamMemberId,
      command,
      expectedVersion: revision ? String(revision) : null,
    }),
  );
}

async function mutationRacingAccountRevocation<T>(
  f: Fixture,
  mutation: () => Promise<T>,
) {
  let outcome:
    | Promise<{ ok: true; value: T } | { ok: false; error: unknown }>
    | undefined;
  await getDb().transaction(async (tx) => {
    await tx
      .select({ id: partnerAccounts.id })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, f.accountId))
      .for("update");
    const pidRows = await tx.execute(sql`select pg_backend_pid() as pid`);
    const controllerPid = Number(pidRows[0]?.["pid"]);
    if (!Number.isSafeInteger(controllerPid))
      throw new Error("Missing controller PID");
    outcome = mutation().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    // Observe a real PostgreSQL lock wait, not an assumed JavaScript ordering.
    // Before the fix this is the late INSERT FK wait, after the fix it is the
    // early authorization/account lock whose post-wait read must see revocation.
    let waiting = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await tx.execute(sql`select exists (
        select 1 from pg_stat_activity candidate
        where candidate.datname = current_database()
          and ${controllerPid} = any(pg_blocking_pids(candidate.pid))
          and candidate.wait_event_type = 'Lock'
      ) as waiting`);
      if (rows[0]?.["waiting"] === true) {
        waiting = true;
        break;
      }
      await delay(10);
    }
    expect(waiting).toBe(true);
    await tx
      .update(partnerAccountMemberships)
      .set({ status: "suspended", suspendedAt: NOW })
      .where(eq(partnerAccountMemberships.id, f.membershipId));
  });
  if (!outcome) throw new Error("The concurrent mutation did not start");
  return outcome;
}

suite(
  "linked additional-service preservation with real local PostgreSQL",
  () => {
    beforeAll(async () => {
      for (const key of ENV_KEYS)
        originalEnvironment.set(key, process.env[key]);
      for (const key of [
        "PARTNER_PORTAL_V2_READS_ENABLED",
        "PARTNER_PORTAL_V2_WRITES_ENABLED",
        "PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED",
        "GOOGLE_CALENDAR_ENABLED",
      ])
        process.env[key] = "true";
      process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"] = "false";
      process.env["PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED"] = "false";
      delete process.env["PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS"];
      process.env["GOOGLE_CLIENT_ID"] = "local-additional-client";
      process.env["GOOGLE_CLIENT_SECRET"] = "local-additional-secret";
      process.env["GOOGLE_REFRESH_TOKEN"] = "local-additional-refresh";
      process.env["GOOGLE_CALENDAR_ID"] = CALENDAR_ID;
      process.env["GOOGLE_CALENDAR_TIMEZONE"] = "America/New_York";
      const db = getDb();
      [originalCatalog] = await db
        .select()
        .from(partnerServiceCatalog)
        .where(eq(partnerServiceCatalog.key, "junk-removal"));
      if (!originalCatalog)
        throw new Error("Local canonical junk-removal catalog is missing");
      await db
        .update(partnerServiceCatalog)
        .set({ instantBookable: true })
        .where(eq(partnerServiceCatalog.key, "junk-removal"));
      originalPolicies = await db
        .select()
        .from(policySettings)
        .where(
          inArray(policySettings.key, ["business_hours", "booking_rules"]),
        );
      const weekly = Object.fromEntries(
        [
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ].map((day) => [day, [{ start: "08:00", end: "18:00" }]]),
      );
      await db
        .insert(policySettings)
        .values([
          {
            key: "business_hours",
            value: { timezone: "America/New_York", weekly },
          },
          {
            key: "booking_rules",
            value: {
              bookingWindowDays: 30,
              bufferMinutes: 30,
              maxJobsPerDay: 100,
              maxJobsPerCrew: 100,
            },
          },
        ])
        .onConflictDoUpdate({
          target: policySettings.key,
          set: { value: sql`excluded.value` },
        });
      await db.insert(calendarSyncState).values({
        calendarId: CALENDAR_ID,
        lastSyncedAt: NOW,
        externalBusyCoverageSyncedAt: NOW,
      });
    });
    afterAll(async () => {
      // Preserve immutable financial fixture graphs in this disposable local DB.
      const db = getDb();
      await db
        .delete(policySettings)
        .where(
          inArray(policySettings.key, ["business_hours", "booking_rules"]),
        );
      if (originalPolicies.length)
        await db.insert(policySettings).values(originalPolicies);
      if (originalCatalog)
        await db
          .update(partnerServiceCatalog)
          .set({
            instantBookable: originalCatalog.instantBookable,
            updatedAt: originalCatalog.updatedAt,
          })
          .where(eq(partnerServiceCatalog.key, "junk-removal"));
      if (profileIds.length)
        await db
          .update(partnerSchedulingProfiles)
          .set({ active: false })
          .where(inArray(partnerSchedulingProfiles.id, profileIds));
      await db
        .delete(calendarSyncState)
        .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeDbForTests();
    });

    it("creates one blank linked draft on concurrent retry without copying original work, secrets, prices, documents or payroll", async () => {
      const f = await fixture(),
        before = await originalEvidence(f),
        key = digest(randomUUID());
      const results = await Promise.all([create(f, key), create(f, key)]);
      expect(new Set(results.map((result) => result.draft.id)).size).toBe(1);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      const draft = results[0].draft;
      expect(draft).toMatchObject({
        additionalServiceFromJobId: f.jobId,
        locationId: f.locationId,
        serviceKey: "service_request",
        description: null,
        crewInstructions: null,
        accessDetails: null,
        onSiteContact: null,
        scope: {},
        commercial: {},
        preferredWindows: [],
        selectedAddOns: [],
      });
      expect(JSON.stringify(draft)).not.toMatch(
        /ORIGINAL-|ORIGINAL WORK|ONE-TIME|OLD ON-SITE/u,
      );
      expect(
        await getDb()
          .select()
          .from(partnerDraftMedia)
          .where(eq(partnerDraftMedia.bookingDraftId, draft.id)),
      ).toHaveLength(0);
      expect(await originalEvidence(f)).toEqual(before);
      expect((await create(f)).draft.id).not.toBe(draft.id); // More than one intentional extra-work request is valid.
    });

    it.each([
      { status: "completed" as const, finalized: false, paid: false },
      { status: "confirmed" as const, finalized: true, paid: false },
      { status: "confirmed" as const, finalized: false, paid: true },
    ])(
      "accepts the explicit completed/finalized/settled source condition %j",
      async (condition) => {
        const f = await fixture(condition),
          before = await originalEvidence(f);
        expect((await create(f)).draft.additionalServiceFromJobId).toBe(
          f.jobId,
        );
        expect(await originalEvidence(f)).toEqual(before);
      },
    );

    it("rejects a still-open unpaid unfinalized source without creating an additional-work draft", async () => {
      const f = await fixture({
        status: "confirmed",
        finalized: false,
        paid: false,
      });
      await expect(create(f)).rejects.toMatchObject({ status: 409 });
      expect(
        await getDb()
          .select()
          .from(partnerBookingDrafts)
          .where(eq(partnerBookingDrafts.partnerAccountId, f.accountId)),
      ).toHaveLength(0);
    });

    it("submits and retries an independent review job, bills only the new work, and leaves original financial evidence unchanged", async () => {
      const f = await fixture(),
        before = await originalEvidence(f);
      const draft = await ready(f, (await create(f)).draft),
        key = digest(randomUUID());
      const results = await Promise.all([
        submit(f, draft, key),
        submit(f, draft, key),
      ]);
      expect(new Set(results.map((result) => result.booking.id)).size).toBe(1);
      const childId = results[0].booking.id;
      const [child] = await getDb()
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, childId));
      if (!child) throw new Error("Expected submitted child job");
      expect(child).toMatchObject({
        additionalServiceFromPartnerBookingId: f.jobId,
        publicStatus: "under_review",
        arrivalWindowStartAt: null,
        arrivalWindowEndAt: null,
        bookingDraftId: draft.id,
        amountCents: 2500,
      });
      expect(child.appointmentId).not.toBe(f.appointmentId);
      expect(child.rateSnapshot).not.toHaveProperty("commissionSnapshot");
      const [appointment] = await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, child.appointmentId));
      expect(appointment).toMatchObject({
        status: "requested",
        quotedTotalCents: 2500,
        finalTotalCents: null,
        completedAt: null,
        soldByMemberId: null,
      });
      expect(
        await getDb()
          .select()
          .from(payments)
          .where(eq(payments.appointmentId, child.appointmentId)),
      ).toHaveLength(0);
      const invoice = await billing(f, {
        action: "create_invoice",
        jobId: child.id,
        lines: [
          {
            description: "New additional removal",
            quantity: "1",
            unitAmountCents: 2500,
          },
        ],
        taxCents: 0,
        discountCents: 0,
        depositCents: 0,
        poNumber: null,
        costCenter: null,
        billingContact: { name: "New billing contact" },
        terms: null,
        dueDate: null,
        reason: "Reviewed new additional work only",
      });
      if (!invoice.invoiceId) throw new Error("Expected new invoice");
      await billing(
        f,
        {
          action: "issue_invoice",
          invoiceId: invoice.invoiceId,
          reason: "Issue only the new agreed work",
        },
        invoice.revision,
      );
      expect(invoice.invoiceId).not.toBe(f.invoiceId);
      const childPaymentId = randomUUID();
      await getDb()
        .insert(payments)
        .values({
          id: childPaymentId,
          appointmentId: child.appointmentId,
          provider: "manual",
          providerPaymentId: `local-child-${childPaymentId}`,
          amount: 2500,
          jobAmountCents: 2500,
          totalAmountCents: 2500,
          currency: "USD",
          method: "cash",
          tenderType: "cash",
          status: "completed",
          canonicalStatus: "completed",
          paidAt: NOW,
        });
      await getDb().transaction(async (tx) => {
        await lockAppointmentInvoiceCollection(tx, child.appointmentId);
        await reconcilePartnerAppointmentInvoices(tx, child.appointmentId);
      });
      expect(
        (
          await getDb()
            .select()
            .from(partnerInvoices)
            .where(eq(partnerInvoices.id, invoice.invoiceId))
        )[0],
      ).toMatchObject({
        partnerBookingId: child.id,
        totalCents: 2500,
        paidCents: 2500,
        balanceCents: 0,
      });
      expect(
        (
          await getDb()
            .select()
            .from(partnerPaymentAllocations)
            .where(eq(partnerPaymentAllocations.paymentId, childPaymentId))
        )[0],
      ).toMatchObject({
        partnerInvoiceId: invoice.invoiceId,
        amountCents: 2500,
      });
      // Exercise the existing child-only commission core after its own completion.
      // This is financial-core evidence, not a browser/CRM completion-route test.
      await getDb()
        .update(appointments)
        .set({ status: "completed", completedAt: NOW, finalTotalCents: 2500 })
        .where(eq(appointments.id, child.appointmentId));
      await getDb().insert(appointmentCrewMembers).values({
        appointmentId: child.appointmentId,
        memberId: f.teamMemberId,
        splitBps: 10000,
        fixedJobRateBps: 1000,
      });
      // A fresh migrated DB has no configured management recipient. Supply a
      // temporary local recipient, not a different commission formula or rate.
      const localManagementId = randomUUID();
      await getOrCreateCommissionSettings(getDb());
      await getDb().insert(commissionManagementSplits).values({
        id: localManagementId,
        settingsKey: "default",
        memberId: f.teamMemberId,
        splitBps: 10000,
        enabled: true,
      });
      try {
        await recalculateAppointmentCommissions(getDb(), child.appointmentId, {
          failClosedOnSchemaMismatch: true,
        });
      } finally {
        await getDb()
          .delete(commissionManagementSplits)
          .where(eq(commissionManagementSplits.id, localManagementId));
      }
      const childCommissions = await getDb()
        .select()
        .from(appointmentCommissions)
        .where(eq(appointmentCommissions.appointmentId, child.appointmentId));
      expect(
        childCommissions.find(
          (entry) => entry.role === "crew" && entry.memberId === f.teamMemberId,
        ),
      ).toMatchObject({ baseCents: 2500, amountCents: 250 });
      expect(await originalEvidence(f)).toEqual(before);
    });

    it("retains the immutable source through a fresh held confirmation without reusing the original schedule", async () => {
      const f = await fixture(),
        before = await originalEvidence(f),
        draft = await ready(f, (await create(f)).draft);
      const availability = await getPartnerDraftAvailability({
        actor: f.actor,
        draftId: draft.id,
        rangeStartAt: new Date("2035-06-04T04:00:00.000Z"),
        rangeEndAt: new Date("2035-06-05T03:59:59.999Z"),
        now: NOW,
      });
      const window = availability.windows.find((entry) => entry.available);
      if (!window)
        throw new Error(
          `No isolated additional-service window: ${availability.reviewReasons.join(",")}`,
        );
      const held = await createOrReplacePartnerHold({
        actor: f.actor,
        draftId: draft.id,
        windowId: window.id,
        idempotencyKeyHash: digest(randomUUID()),
        ifMatch: draft.etag,
        correlationId: randomUUID(),
        now: NOW,
      });
      const key = digest(randomUUID()),
        result = await submit(f, draft, key, held.hold.id);
      expect((await submit(f, draft, key, held.hold.id)).booking.id).toBe(
        result.booking.id,
      );
      const [child] = await getDb()
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, result.booking.id));
      expect(child).toMatchObject({
        additionalServiceFromPartnerBookingId: f.jobId,
        publicStatus: "confirmed",
        confirmationMode: "instant",
        amountCents: 2500,
      });
      expect(child?.arrivalWindowStartAt).toBeInstanceOf(Date);
      expect(child?.appointmentId).not.toBe(f.appointmentId);
      expect(await originalEvidence(f)).toEqual(before);
    });

    it("denies foreign and revoked scope, while an authorized scoped Operations member can request additional work", async () => {
      const f = await fixture(),
        foreign = await fixture();
      await expect(
        createPartnerAdditionalServiceDraft({
          actor: f.actor,
          jobId: foreign.jobId,
          idempotencyKeyHash: digest(randomUUID()),
          now: NOW,
        }),
      ).rejects.toMatchObject({ status: 404 });
      await getDb()
        .update(partnerAccountMemberships)
        .set({ accessLevel: "scoped" })
        .where(eq(partnerAccountMemberships.id, f.membershipId));
      await expect(create(f)).rejects.toMatchObject({ status: 404 }); // Stale account-wide actor cannot restore removed grants.
      await getDb().insert(partnerMembershipLocationScopes).values({
        partnerAccountId: f.accountId,
        membershipId: f.membershipId,
        locationId: f.locationId,
      });
      const scopedActor: PartnerSchedulingActor = {
        ...f.actor,
        accessLevel: "scoped",
        locationIds: [f.locationId],
        propertyIds: [f.propertyId],
      };
      const draft = (
        await createPartnerAdditionalServiceDraft({
          actor: scopedActor,
          jobId: f.jobId,
          idempotencyKeyHash: digest(randomUUID()),
          now: NOW,
        })
      ).draft;
      expect(draft.locationId).toBe(f.locationId);
      await getDb()
        .update(partnerAccountMemberships)
        .set({ status: "suspended", suspendedAt: NOW })
        .where(eq(partnerAccountMemberships.id, f.membershipId));
      await expect(create(f)).rejects.toMatchObject({ status: 404 });
    });

    it("preserves legitimate combined location and cost-center scope when creating and reading the linked draft", async () => {
      const f = await fixture(),
        costCenterId = randomUUID();
      await getDb().transaction(async (tx) => {
        await tx
          .update(partnerAccountMemberships)
          .set({ accessLevel: "scoped" })
          .where(eq(partnerAccountMemberships.id, f.membershipId));
        await tx.insert(partnerMembershipLocationScopes).values({
          partnerAccountId: f.accountId,
          membershipId: f.membershipId,
          locationId: f.locationId,
        });
        await tx.insert(partnerAccountCostCenters).values({
          id: costCenterId,
          partnerAccountId: f.accountId,
          code: "ADDITIONAL-SERVICE",
          name: "Additional service test center",
        });
        await tx.insert(partnerMembershipCostCenterScopes).values({
          partnerAccountId: f.accountId,
          membershipId: f.membershipId,
          costCenterId,
        });
      });
      const actor: PartnerSchedulingActor = {
        ...f.actor,
        accessLevel: "scoped",
        locationIds: [f.locationId],
        propertyIds: [f.propertyId],
        costCenterIds: [costCenterId],
      };
      const result = await createPartnerAdditionalServiceDraft({
        actor,
        jobId: f.jobId,
        idempotencyKeyHash: digest(randomUUID()),
        now: NOW,
      });
      expect(
        await getPartnerBookingDraft({ actor, draftId: result.draft.id }),
      ).toMatchObject({
        id: result.draft.id,
        additionalServiceFromJobId: f.jobId,
        locationId: f.locationId,
      });
      await expect(
        getPartnerBookingDraft({
          actor: { ...actor, costCenterIds: [] },
          draftId: result.draft.id,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("leaves the service chooser empty when the fallback request service is disabled", async () => {
      const f = await fixture();
      const [fallback] = await getDb()
        .select()
        .from(partnerServiceCatalog)
        .where(eq(partnerServiceCatalog.key, "service_request"));
      if (!fallback)
        throw new Error("Local request service fixture is missing");
      try {
        await getDb()
          .update(partnerServiceCatalog)
          .set({ active: false })
          .where(eq(partnerServiceCatalog.key, fallback.key));
        expect((await create(f)).draft).toMatchObject({
          serviceKey: null,
          tierKey: null,
          additionalServiceFromJobId: f.jobId,
        });
      } finally {
        await getDb()
          .update(partnerServiceCatalog)
          .set({ active: fallback.active, updatedAt: fallback.updatedAt })
          .where(eq(partnerServiceCatalog.key, fallback.key));
      }
    });

    it("rejects reusing one request key for a different source job in the same account", async () => {
      const f = await fixture(),
        otherAppointmentId = randomUUID(),
        otherJobId = randomUUID(),
        key = digest(randomUUID());
      await getDb().transaction(async (tx) => {
        await tx.insert(appointments).values({
          id: otherAppointmentId,
          partnerAccountId: f.accountId,
          contactId: f.contactId,
          propertyId: f.propertyId,
          type: "job",
          status: "completed",
          finalTotalCents: 3000,
          completedAt: ORIGINAL_COMPLETION,
          rescheduleToken: randomUUID(),
        });
        await tx.insert(partnerBookings).values({
          id: otherJobId,
          partnerAccountId: f.accountId,
          orgContactId: f.contactId,
          propertyId: f.propertyId,
          appointmentId: otherAppointmentId,
          publicStatus: "completed",
          scopeSnapshot: { locationId: f.locationId },
        });
      });
      await create(f, key);
      await expect(
        createPartnerAdditionalServiceDraft({
          actor: f.actor,
          jobId: otherJobId,
          idempotencyKeyHash: key,
          now: NOW,
        }),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      expect(
        await getDb()
          .select()
          .from(partnerBookingDrafts)
          .where(eq(partnerBookingDrafts.partnerAccountId, f.accountId)),
      ).toHaveLength(1);
    });

    it("rechecks current scheduling authority before submitting a previously authorized linked draft", async () => {
      const f = await fixture(),
        before = await originalEvidence(f),
        draft = await ready(f, (await create(f)).draft);
      const [billingRole] = await getDb()
        .select()
        .from(partnerRoleTemplates)
        .where(
          and(
            eq(partnerRoleTemplates.key, "billing_approver"),
            isNull(partnerRoleTemplates.partnerAccountId),
          ),
        );
      if (!billingRole)
        throw new Error("Local canonical Billing role is missing");
      await getDb()
        .update(partnerAccountMemberships)
        .set({ roleKey: "billing_approver", roleTemplateId: billingRole.id })
        .where(eq(partnerAccountMemberships.id, f.membershipId));
      await expect(submit(f, draft)).rejects.toMatchObject({ status: 404 });
      expect(
        await getDb()
          .select()
          .from(partnerBookings)
          .where(eq(partnerBookings.bookingDraftId, draft.id)),
      ).toHaveLength(0);
      expect(await originalEvidence(f)).toEqual(before);
    });

    it("rechecks membership after a concurrent account controller revokes access while draft creation is blocked", async () => {
      const f = await fixture(),
        before = await originalEvidence(f);
      expect(
        await mutationRacingAccountRevocation(f, () => create(f)),
      ).toMatchObject({ ok: false, error: { status: 404, code: "not_found" } });
      expect(
        await getDb()
          .select()
          .from(partnerBookingDrafts)
          .where(eq(partnerBookingDrafts.partnerAccountId, f.accountId)),
      ).toHaveLength(0);
      expect(await originalEvidence(f)).toEqual(before);
    });

    it("rechecks membership after a concurrent account controller revokes access while submission is blocked", async () => {
      const f = await fixture(),
        before = await originalEvidence(f),
        draft = await ready(f, (await create(f)).draft);
      expect(
        await mutationRacingAccountRevocation(f, () => submit(f, draft)),
      ).toMatchObject({ ok: false, error: { status: 404, code: "not_found" } });
      expect(
        await getDb()
          .select()
          .from(partnerBookings)
          .where(eq(partnerBookings.bookingDraftId, draft.id)),
      ).toHaveLength(0);
      expect(await originalEvidence(f)).toEqual(before);
    });

    it("does not permit in-place price changes on the paid source while its child request exists", async () => {
      const f = await fixture(),
        before = await originalEvidence(f);
      await create(f);
      await expect(
        getDb().transaction((tx) =>
          applyPartnerChangeOrderPrice(tx, {
            accountId: f.accountId,
            jobId: f.jobId,
            appointmentId: f.appointmentId,
            amountCents: 12500,
            actorMembershipId: f.membershipId,
            changeOrderId: randomUUID(),
            quoteVersionId: randomUUID(),
            correlationId: randomUUID(),
            now: NOW,
          }),
        ),
      ).rejects.toThrow("existing invoice or payment");
      expect(await originalEvidence(f)).toEqual(before);
    });

    it("enforces account-safe immutable draft and child links independently of application authorization", async () => {
      const f = await fixture(),
        foreign = await fixture();
      const draft = await ready(f, (await create(f)).draft);
      await expect(
        getDb()
          .update(partnerBookingDrafts)
          .set({ additionalServiceFromPartnerBookingId: foreign.jobId })
          .where(eq(partnerBookingDrafts.id, draft.id)),
      ).rejects.toHaveProperty(
        "cause.message",
        "partner_additional_service_link_immutable",
      );
      await expect(
        getDb()
          .update(partnerBookingDrafts)
          .set({ additionalServiceFromPartnerBookingId: null })
          .where(eq(partnerBookingDrafts.id, draft.id)),
      ).rejects.toHaveProperty(
        "cause.message",
        "partner_additional_service_link_immutable",
      );
      const result = await submit(f, draft);
      await expect(
        getDb()
          .update(partnerBookings)
          .set({ additionalServiceFromPartnerBookingId: foreign.jobId })
          .where(eq(partnerBookings.id, result.booking.id)),
      ).rejects.toHaveProperty(
        "cause.message",
        "partner_additional_service_link_immutable",
      );
      await expect(
        getDb()
          .update(partnerBookings)
          .set({ additionalServiceFromPartnerBookingId: null })
          .where(eq(partnerBookings.id, result.booking.id)),
      ).rejects.toHaveProperty(
        "cause.message",
        "partner_additional_service_link_immutable",
      );
      await expect(
        getDb().insert(partnerBookingDrafts).values({
          partnerAccountId: f.accountId,
          createdByMembershipId: f.membershipId,
          additionalServiceFromPartnerBookingId: foreign.jobId,
        }),
      ).rejects.toHaveProperty(
        "cause.constraint_name",
        "partner_additional_draft_source_fk",
      );
      expect(
        await getDb()
          .select()
          .from(partnerBookings)
          .where(
            and(
              eq(partnerBookings.partnerAccountId, f.accountId),
              eq(
                partnerBookings.additionalServiceFromPartnerBookingId,
                f.jobId,
              ),
            ),
          ),
      ).toHaveLength(1);
    });
  },
);
