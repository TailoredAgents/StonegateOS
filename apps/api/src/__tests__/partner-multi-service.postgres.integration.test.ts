import {
  queuePartnerVisitCalendarCancellations,
  verifyPartnerVisitCalendarCancellation,
} from "@/lib/partner-visit-calendar-cancellation";
import { randomUUID } from "node:crypto";
import { createPortalV2StrongEtag } from "@/lib/portal-v2-contract";
import { and, eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  auditLogs,
  outboxEvents,
  getDb,
  appointments,
  partnerNotifications,
  contacts,
  properties,
  contactProperties,
  partnerAccounts,
  mediaAssets,
  partnerDraftMedia,
  partnerJobEvidence,
  partnerBulkImportRows,
  partnerUsers,
  partnerAccountMemberships,
  partnerAccountLocations,
  partnerBookings,
  partnerBookingServiceLines,
  partnerBookingVisits,
  partnerApprovalRules,
  partnerApprovalRequests,
  scheduleResourcePools,
  scheduleResources,
  teamRoles,
  teamMembers,
} from "@/db";
import {
  createPartnerBookingDraft,
  requestPartnerVisitReschedule,
  createPartnerRescheduleDraft,
  getPartnerRescheduleRequestForStaff,
  withdrawPartnerRescheduleRequest,
  decidePartnerRescheduleRequest,
  createPartnerAdditionalServiceDraft,
  getPartnerDraftAvailability,
  submitPartnerBookingDraft,
  updatePartnerBookingDraft,
  type PartnerSchedulingActor,
} from "@/lib/partner-portal-v2-scheduling";
import {
  createBookAgainDraft,
  createPartnerServiceTemplate,
  createPartnerRecurringSeries,
  validatePartnerBulkCsv,
  createPartnerBulkImport,
  processPartnerBulkImport,
} from "@/lib/partner-repeat-work";
import {
  createPartnerMultiServiceVisit,
  pricePartnerMultiServiceRequest,
  updatePartnerMultiServiceVisit,
  getPartnerMultiServiceRequest,
  cancelPartnerMultiServiceRequest,
} from "@/lib/partner-multi-service";
import { loadPartnerAdditionalServiceSource } from "@/lib/partner-additional-service";
import { savePartnerServiceRates } from "@/lib/partner-structured-rates";
import {
  assertAppointmentHasIndependentFinancials,
  lockPartnerRequestFinancials,
} from "@/lib/partner-request-financials";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import type { TeamMutationContext } from "@/lib/team-mutation";
import { completeTestPartnerRateCard } from "./fixtures/partner-service-rates";
import { queuePartnerCommittedStatusNotification } from "@/lib/partner-job-lifecycle";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
const NOW = new Date("2035-06-01T12:00:00Z");
async function fixture() {
  const db = getDb(),
    accountId = randomUUID(),
    contactId = randomUUID(),
    propertyId = randomUUID(),
    locationId = randomUUID(),
    userId = randomUUID(),
    membershipId = randomUUID(),
    memberId = randomUUID(),
    roleId = randomUUID(),
    crewId = randomUUID();
  const actor: PartnerSchedulingActor = {
    accountId,
    membershipId,
    partnerUserId: userId,
    email: `${userId}@example.test`,
    sessionId: randomUUID(),
    accessLevel: "account",
    canReadRates: true,
    locationIds: [],
    propertyIds: [],
  };
  await db.transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: "Synthetic multi-service company",
      normalizedName: accountId,
      status: "active_partner",
      portalAccessEnabled: true,
      portalWorkflowConfig: {
        tools: { bulk: true, templates: true, recurring: true },
      },
    });
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Synthetic",
      lastName: "Partner",
      partnerAccountId: accountId,
    });
    await tx
      .update(partnerAccounts)
      .set({ portalContactId: contactId })
      .where(eq(partnerAccounts.id, accountId));
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressKey: accountId,
      addressLine1: "1 Test Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      lat: "39.29",
      lng: "-76.61",
    });
    await tx.insert(contactProperties).values({
      contactId,
      propertyId,
      relationship: "partner_service_location",
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email: actor.email,
      normalizedEmail: actor.email,
      name: "Synthetic Partner",
      active: true,
      identityStatus: "active",
      emailVerifiedAt: NOW,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "operations",
      status: "active",
      accessLevel: "account",
      capabilityGrants: [
        "bookings.create",
        "bookings.read",
        "bookings.update",
        "jobs.read",
        "bookings.pricing.read",
      ],
      acceptedAt: NOW,
    });
    await tx.insert(partnerAccountLocations).values({
      id: locationId,
      partnerAccountId: accountId,
      propertyId,
      siteName: "Synthetic site",
      addressLine1: "1 Test Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      timezone: "America/New_York",
      latitude: "39.29",
      longitude: "-76.61",
      geocodeStatus: "verified",
      serviceAreaStatus: "eligible",
      active: true,
      createdByMembershipId: membershipId,
    });
    await tx.insert(teamRoles).values({
      id: roleId,
      slug: `multi-${roleId}`,
      name: "Synthetic manager",
      permissions: [
        "partners.accounts.manage",
        "partners.rates",
        "partners.commercial.manage",
      ],
    });
    await tx.insert(teamMembers).values({
      id: memberId,
      roleId,
      name: "Synthetic manager",
      email: `${memberId}@example.test`,
      active: true,
    });
    await tx
      .insert(scheduleResourcePools)
      .values({
        key: "field_service",
        label: "Field service",
        capacityUnits: 100,
        active: true,
      })
      .onConflictDoUpdate({
        target: scheduleResourcePools.key,
        set: { capacityUnits: 100, active: true },
      });
    await tx.insert(scheduleResources).values({
      id: crewId,
      capacityPoolKey: "field_service",
      kind: "crew",
      label: "Synthetic selected crew",
      source: "staff",
      capacityUnits: 1,
      active: true,
      skillKeys: [],
    });
  });
  const mutation = (version: number): TeamMutationContext =>
    ({
      actor: {
        type: "human",
        id: memberId,
        authMethod: "team_session",
        sessionId: randomUUID(),
        label: "Synthetic manager",
      },
      correlationId: randomUUID(),
      expectedVersion: String(version),
      idempotencyKeyHash: "b".repeat(64),
    }) as TeamMutationContext;
  const lines = [
    {
      id: randomUUID(),
      serviceKey: "painting" as const,
      description: "Paint the interior lobby",
      scope: { workArea: "interior" },
      selectedAddOns: [],
      proofRequirements: {},
    },
    {
      id: randomUUID(),
      serviceKey: "pressure-washing" as const,
      description: "Wash the walkway",
      scope: { surfaces: "Concrete walkway" },
      selectedAddOns: [],
      proofRequirements: {},
    },
  ];
  async function submit() {
    const { draft } = await createPartnerBookingDraft({
      actor,
      mutation: {
        modelVersion: 2,
        serviceLines: lines,
        locationId,
        onSiteContact: { name: "Property contact", email: actor.email },
        proofRequirements: { before: 0, after: 0 },
        preferredWindows: [
          {
            localDate: "2035-06-04",
            timeOfDay: "morning",
            timezone: "America/New_York",
          },
        ],
      },
      idempotencyKeyHash: randomUUID(),
      now: NOW,
    });
    const availability = await getPartnerDraftAvailability({
      actor,
      draftId: draft.id,
      rangeStartAt: new Date("2035-06-04T04:00:00Z"),
      rangeEndAt: new Date("2035-06-05T04:00:00Z"),
      now: NOW,
    });
    expect(availability).toMatchObject({
      instantConfirmationEligible: false,
      windows: [],
      pricing: { total: null },
    });
    const submission = {
      actor,
      draftId: draft.id,
      holdId: null,
      ifMatch: draft.etag,
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    };
    const result = await submitPartnerBookingDraft(submission);
    expect((await submitPartnerBookingDraft(submission)).replayed).toBe(true);
    return { jobId: result.booking.id, draft };
  }
  async function rates(incomplete = false) {
    const card = completeTestPartnerRateCard();
    if (incomplete)
      card.rates = card.rates.filter(
        (rate) =>
          !(rate.serviceKey === "painting" && rate.variantKey === "interior"),
      );
    await db.transaction((tx) =>
      savePartnerServiceRates(tx, mutation(1), accountId, {
        action: "publish",
        portalVisible: true,
        card,
      }),
    );
  }
  const prices = (amounts = [10000, 10000]) => ({
    accountId,
    linePrices: lines.map((line, index) => ({
      serviceLineId: line.id,
      amountCents: amounts[index]!,
      description: line.description,
    })),
    reason: "Staff reviewed the complete project scope.",
  });
  // Each fixture uses a separate future week so prior local/browser fixtures cannot reserve its dates.
  const dateOffsetDays = 10000 + Number.parseInt(randomUUID().slice(0, 4), 16);
  const visit = (ids = lines.map((line) => line.id), date = "2035-06-04") => ({
    accountId,
    serviceLineIds: ids,
    date: new Date(Date.parse(`${date}T12:00:00Z`) + dateOffsetDays * 86400000)
      .toISOString()
      .slice(0, 10),
    startTime: "10:00",
    durationMinutes: 60,
    travelBufferMinutes: 0,
    resourceIds: [crewId],
  });
  return {
    db,
    actor,
    accountId,
    locationId,
    mutation,
    crewId,
    lines,
    submit,
    rates,
    prices,
    visit,
  };
}

suite("multi-service requests / real PostgreSQL", () => {
  beforeAll(() => {
    process.env["PARTNER_MULTI_SERVICE_REQUESTS_ENABLED"] = "true";
    process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = "true";
    process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "true";
    process.env["PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED"] = "false";
    process.env["PUBLIC_SITE_URL"] = "https://example.test";
  });
  afterAll(async () => closeDbForTests());
  it("submits an unpriced commercial parent once, creates no appointment, and blocks pricing without rates", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    const [parent] = await f.db
      .select()
      .from(partnerBookings)
      .where(eq(partnerBookings.id, jobId));
    expect(parent).toMatchObject({
      modelVersion: 2,
      appointmentId: null,
      serviceKey: null,
      amountCents: null,
      quotedTotalCents: null,
      publicStatus: "under_review",
    });
    expect(
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, f.accountId)),
    ).toHaveLength(0);
    const saved = await f.db
      .select()
      .from(partnerBookingServiceLines)
      .where(eq(partnerBookingServiceLines.partnerBookingId, jobId));
    expect(saved).toHaveLength(2);
    expect(saved.every((line) => line.rateSnapshot === null)).toBe(true);
    await expect(
      f.db.transaction((tx) =>
        pricePartnerMultiServiceRequest(
          tx,
          f.mutation(1),
          jobId,
          f.prices(),
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.db.transaction((tx) =>
        createPartnerMultiServiceVisit(
          tx,
          f.mutation(1),
          jobId,
          f.visit(),
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("keeps submitted rates and visit minimum after newer publications before pricing and scheduling", async () => {
    const f = await fixture();
    await f.rates();
    const { jobId } = await f.submit();
    const original = await f.db
      .select()
      .from(partnerBookingServiceLines)
      .where(eq(partnerBookingServiceLines.partnerBookingId, jobId));
    const submittedId = original[0]!.rateSnapshot!["rateCardVersionId"];
    const publish = async (revision: number, amount: string) => {
      const card = completeTestPartnerRateCard();
      card.visitMinimum = "150.00";
      card.rates = card.rates.map((rate) => ({ ...rate, unitAmount: amount }));
      await f.db.transaction((tx) =>
        savePartnerServiceRates(tx, f.mutation(revision), f.accountId, {
          action: "publish",
          portalVisible: true,
          card,
        }),
      );
    };
    await publish(2, "200.00");
    const beforePrice = await getPartnerMultiServiceRequest(
      f.db,
      f.accountId,
      jobId,
      { currentRates: true, rates: true },
    );
    expect(
      beforePrice!.serviceLines.every(
        (line) => line.currentRateSnapshot?.versionId === submittedId,
      ),
    ).toBe(true);
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        {
          ...f.prices(),
          linePrices: f.prices().linePrices.map((price, index) => ({
            ...price,
            charges: [
              {
                rateKey:
                  index === 0
                    ? "painting_interior"
                    : "pressure-washing_standard",
                quantity: "1",
              },
            ],
          })),
        },
        NOW,
      ),
    );
    await publish(3, "300.00");
    const visit = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(tx, f.mutation(2), jobId, f.visit(), NOW),
    );
    const after = await f.db
      .select()
      .from(partnerBookingServiceLines)
      .where(eq(partnerBookingServiceLines.partnerBookingId, jobId));
    expect(after.map((line) => line.rateSnapshot)).toEqual(
      original.map((line) => line.rateSnapshot),
    );
    expect(
      after.every(
        (line) => line.pricingSnapshot?.["rateCardVersionId"] === submittedId,
      ),
    ).toBe(true);
    const [savedVisit] = await f.db
      .select()
      .from(partnerBookingVisits)
      .where(eq(partnerBookingVisits.id, visit.visitId));
    expect(savedVisit!.minimumAmountCents).toBe(7500);
    expect(savedVisit!.rateSnapshot).toMatchObject({
      rateCardVersionIds: [submittedId],
    });
  });
  it.each(["partial", "empty"] as const)(
    "fills %s submitted rates without replacing known rates or the saved minimum",
    async (mode) => {
      const f = await fixture();
      f.lines[0]!.scope.workArea = "both";
      const cardA = completeTestPartnerRateCard();
      cardA.rates = cardA.rates.filter(
        (rate) =>
          rate.serviceKey !== "painting" ||
          (mode === "partial" && rate.variantKey === "interior"),
      );
      const savedA = await f.db.transaction((tx) =>
        savePartnerServiceRates(tx, f.mutation(1), f.accountId, {
          action: "publish",
          portalVisible: true,
          card: cardA,
        }),
      );
      const { jobId } = await f.submit();
      const [original] = await f.db
        .select()
        .from(partnerBookingServiceLines)
        .where(eq(partnerBookingServiceLines.id, f.lines[0]!.id));
      expect(original!.rateSnapshot).toMatchObject({
        rateCardVersionId: savedA.publishedVersionId,
        visitMinimum: "75.00",
      });
      const incomplete = await getPartnerMultiServiceRequest(
        f.db,
        f.accountId,
        jobId,
        { currentRates: true, rates: true },
      );
      expect(incomplete!.serviceLines[0]!.rateSnapshot?.status).toBe("missing");
      expect(incomplete!.serviceLines[0]!.currentRateSnapshot?.status).toBe(
        "missing",
      );
      const cardB = completeTestPartnerRateCard();
      cardB.visitMinimum = "150.00";
      cardB.rates = cardB.rates.map((rate) => ({
        ...rate,
        unitAmount: "200.00",
      }));
      const savedB = await f.db.transaction((tx) =>
        savePartnerServiceRates(tx, f.mutation(2), f.accountId, {
          action: "publish",
          portalVisible: true,
          card: cardB,
        }),
      );
      const prices = f.prices([mode === "partial" ? 30000 : 40000, 10000]);
      await f.db.transaction((tx) =>
        pricePartnerMultiServiceRequest(
          tx,
          f.mutation(1),
          jobId,
          {
            ...prices,
            linePrices: prices.linePrices.map((price, index) => ({
              ...price,
              charges:
                index === 0
                  ? [
                      { rateKey: "painting_interior", quantity: "1" },
                      { rateKey: "painting_exterior", quantity: "1" },
                    ]
                  : [{ rateKey: "pressure-washing_standard", quantity: "1" }],
            })),
          },
          NOW,
        ),
      );
      const [priced] = await f.db
        .select()
        .from(partnerBookingServiceLines)
        .where(eq(partnerBookingServiceLines.id, f.lines[0]!.id));
      expect(priced!.rateSnapshot).toEqual(original!.rateSnapshot);
      expect(priced!.pricingSnapshot).toMatchObject({
        visitMinimum: "75.00",
        minimumRateCardVersionId: savedA.publishedVersionId,
      });
      expect(priced!.pricingSnapshot!["rateSources"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rateKey: "painting_interior",
            rateCardVersionId:
              mode === "partial"
                ? savedA.publishedVersionId
                : savedB.publishedVersionId,
          }),
          expect.objectContaining({
            rateKey: "painting_exterior",
            rateCardVersionId: savedB.publishedVersionId,
          }),
        ]),
      );
      expect(priced!.pricingSnapshot!["rateSources"]).toHaveLength(2);
      const visit = await f.db.transaction((tx) =>
        createPartnerMultiServiceVisit(
          tx,
          f.mutation(2),
          jobId,
          f.visit([f.lines[0]!.id]),
          NOW,
        ),
      );
      const [savedVisit] = await f.db
        .select()
        .from(partnerBookingVisits)
        .where(eq(partnerBookingVisits.id, visit.visitId));
      expect(savedVisit!.minimumAmountCents).toBe(7500);
    },
  );
  it("prices explicitly, keeps original missing-rate evidence, and reserves only real visits", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const first = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(tx, f.mutation(2), jobId, f.visit(), NOW),
    );
    const second = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(
        tx,
        f.mutation(3),
        jobId,
        f.visit([f.lines[0]!.id], "2035-06-05"),
        NOW,
      ),
    );
    const notificationId = randomUUID();
    const notifyVisit = {
      accountId: f.accountId,
      jobId,
      visitId: second.visitId,
      status: "confirmed" as const,
      version: "1",
      eventId: notificationId,
    };
    await f.db.transaction((tx) =>
      queuePartnerCommittedStatusNotification(tx, {
        ...notifyVisit,
        accountId: randomUUID(),
      }),
    );
    await f.db.transaction((tx) =>
      queuePartnerCommittedStatusNotification(tx, {
        ...notifyVisit,
        version: "0",
      }),
    );
    expect(
      await f.db
        .select()
        .from(partnerNotifications)
        .where(
          and(
            eq(partnerNotifications.partnerAccountId, f.accountId),
            eq(partnerNotifications.eventKey, "job.created"),
          ),
        ),
    ).toHaveLength(0);
    await f.db.transaction((tx) =>
      queuePartnerCommittedStatusNotification(tx, notifyVisit),
    );
    await f.db.transaction((tx) =>
      queuePartnerCommittedStatusNotification(tx, notifyVisit),
    );
    expect(
      await f.db
        .select()
        .from(partnerNotifications)
        .where(
          and(
            eq(partnerNotifications.partnerAccountId, f.accountId),
            eq(partnerNotifications.eventKey, "job.created"),
          ),
        ),
    ).toHaveLength(1);
    const rows = await f.db
      .select()
      .from(appointments)
      .where(eq(appointments.partnerAccountId, f.accountId));
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.capacityUnits === 1 &&
          row.quotedTotalCents === null &&
          row.finalTotalCents === null,
      ),
    ).toBe(true);
    const mapped = await getPartnerMultiServiceRequest(
      f.db,
      f.accountId,
      jobId,
      { financials: true, currentRates: true },
    );
    expect(mapped).toMatchObject({
      quotedTotalCents: 20000,
      serviceLines: [
        {
          rateSnapshot: { status: "missing" },
          pricingSnapshot: { status: "published" },
        },
        {
          rateSnapshot: { status: "missing" },
          pricingSnapshot: { status: "published" },
        },
      ],
    });
    expect(mapped!.visits.map((row) => row.minimumAmountCents)).toEqual([
      7500, 7500,
    ]);
    await expect(
      f.db.transaction((tx) =>
        createPartnerMultiServiceVisit(
          tx,
          f.mutation(4),
          jobId,
          f.visit([f.lines[1]!.id], "2035-06-06"),
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, f.accountId)),
    ).toHaveLength(2);
    const moved = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(
        tx,
        f.mutation(4),
        jobId,
        f.visit([f.lines[0]!.id], "2035-06-07"),
        NOW,
        second.visitId,
      ),
    );
    expect(moved.appointmentId).toBe(second.appointmentId);
    expect(moved.visitId).toBe(second.visitId);
    await expect(
      f.db.transaction((tx) =>
        updatePartnerMultiServiceVisit(
          tx,
          f.mutation(5),
          jobId,
          first.visitId,
          {
            accountId: f.accountId,
            status: "completed",
            completedServiceLineIds: [f.lines[0]!.id],
          },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.db.transaction((tx) =>
      updatePartnerMultiServiceVisit(
        tx,
        f.mutation(5),
        jobId,
        first.visitId,
        {
          accountId: f.accountId,
          status: "completed",
          completedServiceLineIds: [f.lines[1]!.id],
        },
        NOW,
      ),
    );
    expect(
      (await getPartnerMultiServiceRequest(
        f.db,
        f.accountId,
        jobId,
      ))!.serviceLines.map((line) => line.status),
    ).toEqual(["pending", "completed"]);
    expect(
      await f.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "partner.proof.prepare"),
            sql`${outboxEvents.payload}->>'jobId' = ${jobId}`,
          ),
        ),
    ).toHaveLength(0);
    const done = await f.db.transaction((tx) =>
      updatePartnerMultiServiceVisit(
        tx,
        f.mutation(6),
        jobId,
        second.visitId,
        {
          accountId: f.accountId,
          status: "completed",
          completedServiceLineIds: [f.lines[0]!.id],
        },
        NOW,
      ),
    );
    expect(done.parentCompleted).toBe(true);
    expect(
      await f.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "partner.proof.prepare"),
            sql`${outboxEvents.payload}->>'jobId' = ${jobId}`,
          ),
        ),
    ).toHaveLength(1);
    const completedNotification = {
      accountId: f.accountId,
      jobId,
      status: "completed" as const,
      eventId: randomUUID(),
    };
    await f.db.transaction((tx) =>
      queuePartnerCommittedStatusNotification(tx, completedNotification),
    );
    await f.db.transaction((tx) =>
      queuePartnerCommittedStatusNotification(tx, completedNotification),
    );
    expect(
      await f.db
        .select()
        .from(partnerNotifications)
        .where(
          and(
            eq(partnerNotifications.partnerAccountId, f.accountId),
            eq(partnerNotifications.eventKey, "job.completed"),
          ),
        ),
    ).toHaveLength(1);
  });
  it("blocks missing requested variants and amount/rate calculation mismatches", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates(true);
    await expect(
      f.db.transaction((tx) =>
        pricePartnerMultiServiceRequest(
          tx,
          f.mutation(1),
          jobId,
          f.prices(),
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const card = completeTestPartnerRateCard();
    await f.db.transaction((tx) =>
      savePartnerServiceRates(tx, f.mutation(2), f.accountId, {
        action: "publish",
        portalVisible: true,
        card,
      }),
    );
    const input = f.prices();
    input.linePrices[0] = { ...input.linePrices[0]!, amountCents: 123 };
    await expect(
      f.db.transaction((tx) =>
        pricePartnerMultiServiceRequest(
          tx,
          f.mutation(1),
          jobId,
          {
            ...input,
            linePrices: input.linePrices.map((line, index) =>
              index === 0
                ? {
                    ...line,
                    charges: [{ rateKey: "painting_interior", quantity: "1" }],
                  }
                : line,
            ),
          },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("keeps rate visibility separate from final price visibility and enforces tenant binding", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const hidden = await getPartnerMultiServiceRequest(
      f.db,
      f.accountId,
      jobId,
      { financials: true, rates: false },
    );
    expect(hidden?.quotedTotalCents).toBe(20000);
    expect(
      hidden?.serviceLines.every(
        (line) => line.pricingSnapshot?.status === "hidden",
      ),
    ).toBe(true);
    expect(
      await getPartnerMultiServiceRequest(f.db, randomUUID(), jobId, {
        financials: true,
      }),
    ).toBeNull();
    await expect(
      f.db.transaction((tx) =>
        createPartnerMultiServiceVisit(
          tx,
          f.mutation(2),
          jobId,
          { ...f.visit(), accountId: randomUUID() },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("copies scope for book again and templates without copying prices, visits, or approval", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    const again = await createBookAgainDraft({
      actor: f.actor,
      jobId,
      idempotencyKeyHash: randomUUID(),
    });
    expect(again.draft).toMatchObject({
      modelVersion: 2,
      serviceKey: null,
      serviceLines: f.lines,
    });
    expect(again.draft).not.toHaveProperty("pricingSnapshot");
    const template = await createPartnerServiceTemplate({
      actor: f.actor,
      principal: {
        ...f.actor,
        roleKey: "operations",
        session: { id: f.actor.sessionId },
      } as unknown as PartnerPrincipal,
      jobId,
      name: `Local multi ${randomUUID()}`,
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(template.template).toMatchObject({
      serviceKey: null,
      reusable: { modelVersion: 2, serviceLines: f.lines },
    });
    const serviceJson = JSON.stringify(
      f.lines.map(({ id: _id, ...line }) => line),
    ).replaceAll('"', '""');
    const rows = await validatePartnerBulkCsv({
      actor: f.actor,
      csv: `location_id,service_lines,contact_name,contact_email,preferred_date\n${f.locationId},"${serviceJson}",Local contact,local@example.test,${new Date(Date.now() + 172800000).toISOString().slice(0, 10)}`,
    });
    expect(rows[0]?.errors).toEqual([]);
    expect(rows[0]?.normalized).toMatchObject({
      modelVersion: 2,
      serviceKey: null,
    });
    expect(rows[0]?.normalized?.serviceLines).toHaveLength(2);
  });
  it("keeps completed work intact when the remaining request is canceled", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const first = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(
        tx,
        f.mutation(2),
        jobId,
        f.visit([f.lines[0]!.id]),
        NOW,
      ),
    );
    await f.db.transaction((tx) =>
      updatePartnerMultiServiceVisit(
        tx,
        f.mutation(3),
        jobId,
        first.visitId,
        {
          accountId: f.accountId,
          status: "completed",
          completedServiceLineIds: [f.lines[0]!.id],
        },
        NOW,
      ),
    );
    const second = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(
        tx,
        f.mutation(4),
        jobId,
        f.visit([f.lines[1]!.id], "2035-06-05"),
        NOW,
      ),
    );
    const canceled = await f.db.transaction(async (tx) => {
      await lockPartnerRequestFinancials(tx, f.accountId, jobId);
      return cancelPartnerMultiServiceRequest(tx, f.accountId, jobId, NOW);
    });
    expect(canceled).toEqual({
      canceledVisitIds: [second.visitId],
      completedWorkRemains: true,
    });
    expect(
      (await getPartnerMultiServiceRequest(
        f.db,
        f.accountId,
        jobId,
      ))!.serviceLines.map((line) => line.status),
    ).toEqual(["completed", "canceled"]);
    const [unchanged] = await f.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, first.appointmentId));
    expect(unchanged?.status).toBe("completed");
  });
  it("preserves service-specific company approval rules before pricing and scheduling", async () => {
    const f = await fixture();
    await f.db.insert(partnerApprovalRules).values({
      partnerAccountId: f.accountId,
      name: "Painting approval",
      conditions: { serviceKeys: ["painting"], minimumAmountMinor: 10000 },
      requiredApproverCapabilities: ["approvals.decide"],
      requiredApproverRoleKeys: [],
      requiredDecisionCount: 1,
      createdByMembershipId: f.actor.membershipId,
      active: true,
    });
    const { jobId } = await f.submit();
    expect(
      (
        await f.db
          .select()
          .from(partnerBookings)
          .where(eq(partnerBookings.id, jobId))
      )[0]?.publicStatus,
    ).toBe("approval_needed");
    await f.rates();
    const price = await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    expect(price.approvalRequired).toBe(true);
    const approvals = await f.db
      .select()
      .from(partnerApprovalRequests)
      .where(eq(partnerApprovalRequests.partnerBookingId, jobId));
    expect(approvals.filter((row) => row.state === "pending")).toHaveLength(1);
    expect(approvals.filter((row) => row.state === "withdrawn")).toHaveLength(
      1,
    );
    await expect(
      f.db.transaction((tx) =>
        createPartnerMultiServiceVisit(
          tx,
          f.mutation(2),
          jobId,
          f.visit(),
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, f.accountId)),
    ).toHaveLength(0);
  });
  it("rolls back final visit completion when required shared evidence is missing", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db
      .update(partnerBookings)
      .set({ proofRequirementsSnapshot: { before: 0, after: 1 } })
      .where(eq(partnerBookings.id, jobId));
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const visit = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(tx, f.mutation(2), jobId, f.visit(), NOW),
    );
    await expect(
      f.db.transaction((tx) =>
        updatePartnerMultiServiceVisit(
          tx,
          f.mutation(3),
          jobId,
          visit.visitId,
          {
            accountId: f.accountId,
            status: "completed",
            completedServiceLineIds: f.lines.map((line) => line.id),
          },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await f.db
          .select()
          .from(partnerBookingVisits)
          .where(eq(partnerBookingVisits.id, visit.visitId))
      )[0]?.status,
    ).toBe("scheduled");
    expect(
      (
        await f.db
          .select()
          .from(partnerBookingServiceLines)
          .where(eq(partnerBookingServiceLines.partnerBookingId, jobId))
      ).every((line) => line.status === "pending"),
    ).toBe(true);
  });
  it("commits and replays a grouped CSV as one parent while linking every group row", async () => {
    const f = await fixture();
    const date = new Date(Date.now() + 172800000).toISOString().slice(0, 10);
    const csv = `request_group,location_id,service_key,description,contact_name,contact_email,preferred_date\nproject-a,${f.locationId},painting,Paint interior walls,Property contact,local@example.test,${date}\nproject-a,${f.locationId},pressure-washing,Wash concrete walkway,Property contact,local@example.test,${date}`;
    const principal = {
      ...f.actor,
      roleKey: "operations",
      session: { id: f.actor.sessionId },
    } as unknown as PartnerPrincipal;
    const imported = await createPartnerBulkImport({
      actor: f.actor,
      principal,
      sourceFilename: "multi-service-groups.csv",
      csv,
      dryRun: false,
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
    });
    await processPartnerBulkImport({
      importId: imported.import.id,
      accountId: f.accountId,
    });
    await processPartnerBulkImport({
      importId: imported.import.id,
      accountId: f.accountId,
    });
    const rows = await f.db
      .select()
      .from(partnerBulkImportRows)
      .where(eq(partnerBulkImportRows.partnerBulkImportId, imported.import.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === "review")).toBe(true);
    expect(new Set(rows.map((row) => row.partnerBookingId)).size).toBe(1);
    expect(rows[0]?.partnerBookingId).not.toBeNull();
    expect(
      await f.db
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.partnerAccountId, f.accountId)),
    ).toHaveLength(1);
    expect(
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, f.accountId)),
    ).toHaveLength(0);
  });
  it("transfers a photo once with optional service references and rejects foreign draft associations", async () => {
    const f = await fixture(),
      photoId = randomUUID(),
      assetId = randomUUID();
    const created = await createPartnerBookingDraft({
      actor: f.actor,
      mutation: {
        modelVersion: 2,
        serviceLines: f.lines,
        locationId: f.locationId,
        onSiteContact: { name: "Photo contact", email: f.actor.email },
        proofRequirements: { before: 0, after: 0 },
        preferredWindows: [
          {
            localDate: "2035-06-04",
            timeOfDay: "anytime",
            timezone: "America/New_York",
          },
        ],
      },
      idempotencyKeyHash: randomUUID(),
      now: NOW,
    });
    await f.db.insert(mediaAssets).values({
      id: assetId,
      partnerAccountId: f.accountId,
      storageBucket: "synthetic-local",
      originalObjectKey: assetId,
      status: "ready",
      readyAt: NOW,
      contentType: "image/jpeg",
      byteSize: 100,
      sha256: "a".repeat(64),
    });
    await f.db.insert(partnerDraftMedia).values({
      id: photoId,
      partnerAccountId: f.accountId,
      bookingDraftId: created.draft.id,
      mediaAssetId: assetId,
      category: "intake",
      uploadedByMembershipId: f.actor.membershipId,
    });
    const wrong = await updatePartnerBookingDraft({
      actor: f.actor,
      draftId: created.draft.id,
      ifMatch: created.draft.etag,
      mutation: {
        scope: {
          photoServiceAssociations: { [randomUUID()]: [f.lines[0]!.id] },
        },
      },
      correlationId: randomUUID(),
      now: NOW,
    });
    await expect(
      submitPartnerBookingDraft({
        actor: f.actor,
        draftId: wrong.id,
        holdId: null,
        ifMatch: wrong.etag,
        idempotencyKeyHash: randomUUID(),
        correlationId: randomUUID(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid_fields" });
    const ready = await updatePartnerBookingDraft({
      actor: f.actor,
      draftId: wrong.id,
      ifMatch: wrong.etag,
      mutation: {
        scope: {
          photoServiceAssociations: {
            [photoId]: f.lines.map((line) => line.id),
          },
        },
      },
      correlationId: randomUUID(),
      now: NOW,
    });
    const submitted = await submitPartnerBookingDraft({
      actor: f.actor,
      draftId: ready.id,
      holdId: null,
      ifMatch: ready.etag,
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    });
    const evidence = await f.db
      .select()
      .from(partnerJobEvidence)
      .where(eq(partnerJobEvidence.partnerBookingId, submitted.booking.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.mediaAssetId).toBe(assetId);
    const details = await getPartnerMultiServiceRequest(
      f.db,
      f.accountId,
      submitted.booking.id,
      { photos: true },
    );
    expect(details!.serviceLines.map((line) => line.photoEvidenceIds)).toEqual([
      [evidence[0]!.id],
      [evidence[0]!.id],
    ]);
    expect(
      (await getPartnerMultiServiceRequest(
        f.db,
        f.accountId,
        submitted.booking.id,
      ))!.serviceLines.every((line) => line.photoEvidenceIds?.length === 0),
    ).toBe(true);
  });

  it("keeps a partially scheduled request visible and requires service-specific proof without borrowing another line's photo", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db
      .update(partnerBookingServiceLines)
      .set({ proofRequirements: { before: 1, after: 1 } })
      .where(
        and(
          eq(partnerBookingServiceLines.partnerBookingId, jobId),
          eq(partnerBookingServiceLines.id, f.lines[0]!.id),
        ),
      );
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const visit = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(
        tx,
        f.mutation(2),
        jobId,
        f.visit([f.lines[0]!.id]),
        NOW,
      ),
    );
    expect(
      (
        await f.db
          .select()
          .from(partnerBookings)
          .where(eq(partnerBookings.id, jobId))
      )[0]?.publicStatus,
    ).toBe("partially_scheduled");
    expect(
      (await getPartnerMultiServiceRequest(f.db, f.accountId, jobId))
        ?.unscheduledServiceLineIds,
    ).toEqual([f.lines[1]!.id]);
    const complete = () =>
      f.db.transaction((tx) =>
        updatePartnerMultiServiceVisit(
          tx,
          f.mutation(3),
          jobId,
          visit.visitId,
          {
            accountId: f.accountId,
            status: "completed",
            completedServiceLineIds: [f.lines[0]!.id],
          },
          NOW,
        ),
      );
    await expect(complete()).rejects.toThrow(/before evidence/);
    const evidenceIds = [randomUUID(), randomUUID()];
    for (const [index, category] of ["before", "after"].entries()) {
      const assetId = randomUUID();
      await f.db.insert(mediaAssets).values({
        id: assetId,
        partnerAccountId: f.accountId,
        storageBucket: "synthetic-local",
        originalObjectKey: assetId,
        status: "ready",
        readyAt: NOW,
        contentType: "image/jpeg",
        byteSize: 100,
        sha256: "a".repeat(64),
      });
      await f.db.insert(partnerJobEvidence).values({
        id: evidenceIds[index]!,
        partnerAccountId: f.accountId,
        partnerBookingId: jobId,
        mediaAssetId: assetId,
        category: category,
        uploadedByMembershipId: f.actor.membershipId,
      });
    }
    const [parent] = await f.db
      .select()
      .from(partnerBookings)
      .where(eq(partnerBookings.id, jobId));
    await f.db
      .update(partnerBookings)
      .set({
        scopeSnapshot: {
          ...parent!.scopeSnapshot,
          scope: {
            photoServiceAssociations: { [evidenceIds[0]!]: [f.lines[1]!.id] },
          },
        },
      })
      .where(eq(partnerBookings.id, jobId));
    await expect(complete()).rejects.toThrow(/before evidence/);
    expect(
      (
        await f.db
          .select()
          .from(partnerBookingVisits)
          .where(eq(partnerBookingVisits.id, visit.visitId))
      )[0]?.status,
    ).toBe("scheduled");
    await f.db
      .update(partnerBookings)
      .set({
        scopeSnapshot: {
          ...parent!.scopeSnapshot,
          scope: {
            photoServiceAssociations: { [evidenceIds[0]!]: [f.lines[0]!.id] },
          },
        },
      })
      .where(eq(partnerBookings.id, jobId));
    await complete(); // The after photo is shared; the before photo is explicitly assigned.
    const detail = await getPartnerMultiServiceRequest(
      f.db,
      f.accountId,
      jobId,
    );
    expect(detail?.serviceLines[0]?.status).toBe("completed");
    expect(detail?.unscheduledServiceLineIds).toEqual([f.lines[1]!.id]);
    expect(
      (
        await f.db
          .select()
          .from(partnerBookings)
          .where(eq(partnerBookings.id, jobId))
      )[0]?.publicStatus,
    ).toBe("in_progress");
  });
  it("requests and resolves one visit's date change without another appointment or minimum charge", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const visit = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(tx, f.mutation(2), jobId, f.visit(), NOW),
    );
    const parent = async () =>
      (
        await f.db
          .select()
          .from(partnerBookings)
          .where(eq(partnerBookings.id, jobId))
      )[0]!;
    const etag = async () => {
      const row = await parent();
      return createPortalV2StrongEtag(
        `${row.id}:${row.version}:${row.updatedAt.toISOString()}`,
      );
    };
    const command = {
      actor: f.actor,
      jobId,
      visitId: visit.visitId,
      preferredWindows: [
        {
          localDate: "2035-06-06",
          timeOfDay: "morning",
          timezone: "America/New_York",
        },
      ],
      ifMatch: await etag(),
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    };
    const created = await requestPartnerVisitReschedule(command);
    expect(created).toMatchObject({
      replayed: false,
      result: {
        mode: "review",
        jobId,
        visitId: visit.visitId,
        consequence: { existingScheduleRemainsInPlace: true },
      },
    });
    expect((await requestPartnerVisitReschedule(command)).replayed).toBe(true);
    await expect(
      requestPartnerVisitReschedule({
        ...command,
        preferredWindows: [
          {
            localDate: "2035-06-07",
            timeOfDay: "morning",
            timezone: "America/New_York",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      createPartnerRescheduleDraft({
        actor: f.actor,
        jobId,
        ifMatch: await etag(),
        idempotencyKeyHash: randomUUID(),
        correlationId: randomUUID(),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid_fields" });
    const before = (
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, visit.appointmentId))
    )[0]!;
    expect(before.startAt?.toISOString()).toBe(visit.startAt);
    const staff = await getPartnerRescheduleRequestForStaff(
      created.result.requestId,
      NOW,
    );
    expect(staff.request).toMatchObject({
      visitId: visit.visitId,
      appointmentId: visit.appointmentId,
    });
    const withdrawn = await withdrawPartnerRescheduleRequest({
      actor: f.actor,
      jobId,
      requestId: created.result.requestId,
      ifMatch: await etag(),
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    });
    expect(withdrawn.state).toBe("withdrawn");
    const next = await requestPartnerVisitReschedule({
      ...command,
      ifMatch: await etag(),
      idempotencyKeyHash: randomUUID(),
    });
    const target = new Date(before.startAt!.getTime() + 86400000);
    const wrong = await fixture();
    await expect(
      requestPartnerVisitReschedule({
        ...command,
        actor: wrong.actor,
        ifMatch: await etag(),
        idempotencyKeyHash: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    const decided = await f.db.transaction((tx) =>
      decidePartnerRescheduleRequest(tx, {
        requestId: next.result.requestId,
        decision: "accepted",
        reason: "Confirmed the requested visit date with the property contact.",
        startAt: target,
        expectedVersion: NOW.toISOString(),
        teamMemberId: f.mutation(1).actor.id,
        correlationId: randomUUID(),
        now: NOW,
      }),
    );
    expect(decided).toMatchObject({
      state: "accepted",
      visitId: visit.visitId,
    });
    const after = (
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, visit.appointmentId))
    )[0]!;
    expect(after.startAt?.toISOString()).toBe(target.toISOString());
    expect(
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, f.accountId)),
    ).toHaveLength(1);
    expect(
      (
        await getPartnerMultiServiceRequest(f.db, f.accountId, jobId, {
          financials: true,
        })
      )?.visits,
    ).toEqual([
      expect.objectContaining({ id: visit.visitId, minimumAmountCents: 7500 }),
    ]);
    expect((await parent()).quotedTotalCents).toBe(20000);
  });
  it("allows additional work from a completed appointment-free parent without copying prior lines or photos", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.db
      .update(partnerBookings)
      .set({ publicStatus: "completed" })
      .where(eq(partnerBookings.id, jobId));
    const principal = {
      ...f.actor,
      roleKey: "operations",
      session: { id: f.actor.sessionId },
    } as unknown as PartnerPrincipal;
    expect(
      await loadPartnerAdditionalServiceSource(f.db, principal, jobId),
    ).toMatchObject({ id: jobId, eligible: true });
    const result = await createPartnerAdditionalServiceDraft({
      actor: f.actor,
      jobId,
      idempotencyKeyHash: randomUUID(),
      now: NOW,
    });
    expect(result.draft).toMatchObject({
      modelVersion: 2,
      serviceLines: [],
      additionalServiceFromJobId: jobId,
    });
    expect(
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, f.accountId)),
    ).toHaveLength(0);
  });
  it("blocks visit-level financial mutation while retaining historical appointment authority", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const visit = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(tx, f.mutation(2), jobId, f.visit(), NOW),
    );
    await expect(
      f.db.transaction(async (tx) => {
        await assertAppointmentHasIndependentFinancials(
          tx,
          visit.appointmentId,
        );
        await tx
          .update(appointments)
          .set({ finalTotalCents: 9999 })
          .where(eq(appointments.id, visit.appointmentId));
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await f.db
          .select()
          .from(appointments)
          .where(eq(appointments.id, visit.appointmentId))
      )[0]?.finalTotalCents,
    ).toBeNull();
    const [parent] = await f.db
      .select()
      .from(partnerBookings)
      .where(eq(partnerBookings.id, jobId));
    const [legacy] = await f.db
      .insert(appointments)
      .values({
        contactId: parent!.orgContactId,
        propertyId: parent!.propertyId,
        partnerAccountId: f.accountId,
        type: "job",
        status: "requested",
        quotedTotalCents: 12000,
        rescheduleToken: randomUUID(),
      })
      .returning();
    await f.db.transaction(async (tx) => {
      await assertAppointmentHasIndependentFinancials(tx, legacy!.id);
      await tx
        .update(appointments)
        .set({ finalTotalCents: 12500 })
        .where(eq(appointments.id, legacy!.id));
    });
    expect(
      (
        await f.db
          .select()
          .from(appointments)
          .where(eq(appointments.id, legacy!.id))
      )[0]?.finalTotalCents,
    ).toBe(12500);
    expect(
      (
        await getPartnerMultiServiceRequest(f.db, f.accountId, jobId, {
          financials: true,
        })
      )?.quotedTotalCents,
    ).toBe(20000);
  });
  it("replays recurring multi-service occurrences as distinct unpriced parents without reservations", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    const principal = {
      ...f.actor,
      roleKey: "operations",
      session: { id: f.actor.sessionId },
    } as unknown as PartnerPrincipal;
    const template = await createPartnerServiceTemplate({
      actor: f.actor,
      principal,
      jobId,
      name: `Recurring local ${randomUUID()}`,
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
    });
    const input = {
      actor: f.actor,
      principal,
      recurrence: {
        templateId: template.template.id,
        name: "Weekly two-service request",
        frequency: "weekly" as const,
        startsOn: "2035-06-04",
        occurrenceCount: 2,
        preferredWindowStart: null,
      },
      idempotencyKeyHash: randomUUID(),
      correlationId: randomUUID(),
      now: NOW,
    };
    const result = await createPartnerRecurringSeries(input);
    expect(result.series.occurrences).toHaveLength(2);
    expect(
      result.series.occurrences.every(
        (occurrence) =>
          occurrence.state === "review" &&
          occurrence.jobId &&
          occurrence.evaluation["reservationCreated"] === false,
      ),
    ).toBe(true);
    const ids = result.series.occurrences.map(
      (occurrence) => occurrence.jobId!,
    );
    expect(new Set(ids).size).toBe(2);
    const replay = await createPartnerRecurringSeries(input);
    expect(replay.replayed).toBe(true);
    expect(
      replay.series.occurrences.map((occurrence) => occurrence.jobId),
    ).toEqual(ids);
    for (const id of ids) {
      expect(
        await getPartnerMultiServiceRequest(f.db, f.accountId, id, {
          financials: true,
        }),
      ).toMatchObject({
        modelVersion: 2,
        quotedTotalCents: null,
        visits: [],
        serviceLines: f.lines.map((line) => ({
          id: line.id,
          serviceKey: line.serviceKey,
          status: "pending",
          rateSnapshot: { status: "missing" },
        })),
      });
    }
    expect(
      await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.partnerAccountId, f.accountId)),
    ).toHaveLength(0);
  });
  it("requires an audited visit cancellation receipt before the worker may delete its calendar event", async () => {
    const f = await fixture(),
      { jobId } = await f.submit();
    await f.rates();
    await f.db.transaction((tx) =>
      pricePartnerMultiServiceRequest(
        tx,
        f.mutation(1),
        jobId,
        f.prices(),
        NOW,
      ),
    );
    const visit = await f.db.transaction((tx) =>
      createPartnerMultiServiceVisit(tx, f.mutation(2), jobId, f.visit(), NOW),
    );
    await f.db
      .update(appointments)
      .set({ calendarEventId: "synthetic-calendar-event", updatedAt: NOW })
      .where(eq(appointments.id, visit.appointmentId));
    const cancel = async (
      tx: Parameters<Parameters<typeof f.db.transaction>[0]>[0],
      auditId: string,
    ) => {
      await updatePartnerMultiServiceVisit(
        tx,
        f.mutation(3),
        jobId,
        visit.visitId,
        {
          accountId: f.accountId,
          status: "canceled",
          completedServiceLineIds: [],
        },
        NOW,
      );
      await queuePartnerVisitCalendarCancellations(tx, {
        accountId: f.accountId,
        bookingId: jobId,
        visitId: visit.visitId,
        changedAt: NOW,
        sourceAuditEventId: auditId,
      });
    };
    await expect(
      f.db.transaction((tx) => cancel(tx, randomUUID())),
    ).rejects.toThrow("partner_visit_cancellation_authorization_invalid");
    expect(
      (
        await f.db
          .select()
          .from(partnerBookingVisits)
          .where(eq(partnerBookingVisits.id, visit.visitId))
      )[0]?.status,
    ).toBe("scheduled");
    const auditId = randomUUID();
    await f.db.transaction(async (tx) => {
      await tx.insert(auditLogs).values({
        id: auditId,
        actorType: "human",
        actorId: f.mutation(1).actor.id,
        sessionId: randomUUID(),
        authMethod: "team_session",
        correlationId: randomUUID(),
        requiredPermissions: ["appointments.update"],
        outcome: "succeeded",
        action: "partner.multi_service.visit_status",
        entityType: "partner_booking",
        entityId: jobId,
        meta: {
          accountId: f.accountId,
          operation: "visit_status",
          after: {
            bookingId: jobId,
            visitId: visit.visitId,
            status: "canceled",
          },
        },
        createdAt: NOW,
      });
      await cancel(tx, auditId);
    });
    const queued = (
      await f.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.type, "appointment.calendar_sync_requested"))
    ).find(
      (row) =>
        row.payload["appointmentId"] === visit.appointmentId &&
        row.payload["reason"] === "partner.visit.canceled",
    );
    expect(queued).toBeDefined();
    const payload = queued!.payload;
    const binding = {
      accountId: f.accountId,
      bookingId: jobId,
      visitId: visit.visitId,
      appointmentId: visit.appointmentId,
      version: NOW.toISOString(),
      calendarEventId: "synthetic-calendar-event",
      sourceAuditEventId: payload["sourceAuditEventId"] as string,
    };
    expect(binding.sourceAuditEventId).not.toBe(auditId);
    expect(await verifyPartnerVisitCalendarCancellation(f.db, binding)).toBe(
      true,
    );
    expect(
      await verifyPartnerVisitCalendarCancellation(f.db, {
        ...binding,
        sourceAuditEventId: auditId,
      }),
    ).toBe(false);
    expect(
      await verifyPartnerVisitCalendarCancellation(f.db, {
        ...binding,
        accountId: randomUUID(),
      }),
    ).toBe(false);
    expect(
      await verifyPartnerVisitCalendarCancellation(f.db, {
        ...binding,
        calendarEventId: "different-event",
      }),
    ).toBe(false);
    expect(
      await verifyPartnerVisitCalendarCancellation(f.db, {
        ...binding,
        version: new Date(NOW.getTime() + 1).toISOString(),
      }),
    ).toBe(false);
  });
});
