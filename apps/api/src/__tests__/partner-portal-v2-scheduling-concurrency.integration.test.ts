import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  calendarSyncState,
  closeDbForTests,
  contactProperties,
  contacts,
  getDb,
  outboxEvents,
  partnerAccountCancellationPolicies,
  partnerAccountServiceAgreements,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccountSchedulingPolicies,
  partnerAccounts,
  partnerApprovalDecisions,
  partnerApprovalRequests,
  partnerApprovalRules,
  partnerBookingDrafts,
  partnerBookings,
  partnerDraftMedia,
  partnerJobEvents,
  partnerJobEvidence,
  partnerNotifications,
  partnerRateCards,
  partnerRateItems,
  partnerRescheduleRequests,
  partnerScheduleAssistanceRequests,
  partnerSchedulingProfiles,
  partnerServiceCatalog,
  partnerUsers,
  policySettings,
  properties,
  scheduleResources,
  scheduleResourcePools,
} from "@/db";
import {
  acquireScheduleConflictLock,
  inspectScheduleConflicts,
} from "@/lib/appointment-schedule-conflicts";
import { PartnerPortalSchedulingError } from "@/lib/partner-portal-v2-scheduling/errors";
import { createPortalV2StrongEtag } from "@/lib/portal-v2-contract";

const jest = import.meta.jest;
const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequirePartnerCapability = jest.fn<
  Promise<unknown>,
  [unknown, unknown]
>();

// The cancellation handler is intentionally exercised as the real route. Only
// its already-tested session decoder is replaced so the database race reaches
// the same schedule lock, authorization predicate, revision checks, and writes
// used in production. The approval service needs the canonical capability
// materializer from this module, so the test double retains deny-wins behavior.
mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
  computePartnerCapabilities: (input: {
    roleCapabilities?: readonly string[] | null;
    grants?: readonly string[] | null;
    denies?: readonly string[] | null;
  }) => {
    const denied = new Set(input.denies ?? []);
    return [
      ...new Set([...(input.roleCapabilities ?? []), ...(input.grants ?? [])]),
    ].filter((capability) => !denied.has(capability));
  },
}));

const {
  createOrReplacePartnerHold,
  createPartnerRescheduleDraft,
  getPartnerBookingDraft,
  getPartnerDraftAvailability,
  releasePartnerHold,
  reschedulePartnerBooking,
  submitPartnerBookingDraft,
} = await import("@/lib/partner-portal-v2-scheduling");
const { decidePartnerApprovalRequest } = await import(
  "@/lib/partner-portal-v2-approvals"
);
const { POST: cancelPartnerJob } = await import(
  "../../app/api/portal/v2/jobs/[jobId]/cancel/route"
);

const FIXED_NOW = new Date("2035-06-01T12:00:00.000Z");
const FIRST_SERVICE_DATE = "2035-06-04";
const SECOND_SERVICE_DATE = "2035-06-05";
const CALENDAR_ID = `partner-concurrency-${randomUUID()}@example.test`;
const POLICY_KEYS = ["business_hours", "booking_rules"] as const;
const ENVIRONMENT_KEYS = [
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

type Actor = Readonly<{
  accountId: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  sessionId: string;
  accessLevel: "account";
  canReadRates: true;
  locationIds: readonly string[];
  propertyIds: readonly string[];
}>;

type Fixture = Readonly<{
  accountId: string;
  requesterUserId: string;
  requesterMembershipId: string;
  requesterEmail: string;
  approverUserId: string;
  approverMembershipId: string;
  approverEmail: string;
  contactId: string;
  propertyId: string;
  locationId: string;
  profileId: string;
  serviceKey: string;
  poolKey: string;
  tierKey: string;
  actor: Actor;
}>;

type StoredPolicy = typeof policySettings.$inferSelect;

const originalEnvironment = new Map<string, string | undefined>();
let storedPolicies: StoredPolicy[] = [];
let storedCatalogInstantBookable = false;
let storedCatalogUpdatedAt: Date | null = null;
const fixtures = new Map<string, Fixture>();

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function correlation(label: string): string {
  return `partner-concurrency-${label}-${randomUUID()}`;
}

function dateRange(localDate: string): { start: Date; end: Date } {
  // June 2035 is EDT. Use a deliberately wide UTC range so all candidates for
  // the local service day are loaded without relying on process timezone.
  return {
    start: new Date(`${localDate}T04:00:00.000Z`),
    end: new Date(`${localDate}T23:59:59.999Z`),
  };
}

async function createFixture(): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "");
  const accountId = randomUUID();
  const requesterUserId = randomUUID();
  const requesterMembershipId = randomUUID();
  const approverUserId = randomUUID();
  const approverMembershipId = randomUUID();
  const contactId = randomUUID();
  const propertyId = randomUUID();
  const locationId = randomUUID();
  const rateCardId = randomUUID();
  const profileId = randomUUID();
  const serviceKey = "junk-removal";
  const poolKey = `pc_${suffix.slice(0, 28)}`;
  const tierKey = "standard";
  const requesterEmail = `requester-${suffix}@example.test`;
  const approverEmail = `approver-${suffix}@example.test`;
  const actor: Actor = Object.freeze({
    accountId,
    membershipId: requesterMembershipId,
    partnerUserId: requesterUserId,
    email: requesterEmail,
    sessionId: randomUUID(),
    accessLevel: "account" as const,
    canReadRates: true as const,
    locationIds: Object.freeze([]),
    propertyIds: Object.freeze([]),
  });
  const fixture: Fixture = Object.freeze({
    accountId,
    requesterUserId,
    requesterMembershipId,
    requesterEmail,
    approverUserId,
    approverMembershipId,
    approverEmail,
    contactId,
    propertyId,
    locationId,
    profileId,
    serviceKey,
    poolKey,
    tierKey,
    actor,
  });

  await db.transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: `Concurrency account ${suffix.slice(0, 8)}`,
      normalizedName: `concurrency account ${suffix.slice(0, 8)}`,
      status: "active_partner",
      segment: "commercial_client",
      portalAccessEnabled: true,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx.insert(partnerAccountServiceAgreements).values({
      partnerAccountId: accountId,
      active: true,
      agreementLabel: "Concurrency service agreement",
      currency: "USD",
      effectiveFrom: new Date(FIXED_NOW.getTime() - 86_400_000),
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
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    // Migration 0147 deliberately seeds production accounts fail-closed. This
    // fixture opts its Stonegate-owned test account into the instant paths the
    // concurrency suite is designed to exercise.
    await tx
      .update(partnerAccountSchedulingPolicies)
      .set({ instantConfirmationEnabled: true, revision: 2 })
      .where(eq(partnerAccountSchedulingPolicies.partnerAccountId, accountId));
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Concurrency",
      lastName: "Account",
      company: `Concurrency ${suffix.slice(0, 8)}`,
      partnerAccountId: accountId,
      partnerStatus: "partner",
      source: "partner_portal_concurrency_integration",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx
      .update(partnerAccounts)
      .set({ portalContactId: contactId })
      .where(eq(partnerAccounts.id, accountId));
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressKey: `partner-concurrency:${suffix}`,
      addressLine1: "1 Integration Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      lat: "39.290400",
      lng: "-76.612200",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx.insert(contactProperties).values({
      contactId,
      propertyId,
      relationship: "partner_service_location",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx.insert(partnerUsers).values([
      {
        id: requesterUserId,
        email: requesterEmail,
        normalizedEmail: requesterEmail,
        name: "Concurrency Requester",
        active: true,
        identityStatus: "active",
        emailVerifiedAt: FIXED_NOW,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      {
        id: approverUserId,
        email: approverEmail,
        normalizedEmail: approverEmail,
        name: "Concurrency Approver",
        active: true,
        identityStatus: "active",
        emailVerifiedAt: FIXED_NOW,
        mfaRequired: true,
        mfaEnrolledAt: FIXED_NOW,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ]);
    await tx.insert(partnerAccountMemberships).values([
      {
        id: requesterMembershipId,
        partnerAccountId: accountId,
        partnerUserId: requesterUserId,
        roleKey: "operations",
        status: "active",
        accessLevel: "account",
        acceptedAt: FIXED_NOW,
        isDefault: true,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      {
        id: approverMembershipId,
        partnerAccountId: accountId,
        partnerUserId: approverUserId,
        roleKey: "billing_approver",
        status: "active",
        accessLevel: "account",
        capabilityGrants: ["approvals.decide"],
        acceptedAt: FIXED_NOW,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ]);
    await tx.insert(partnerAccountLocations).values({
      id: locationId,
      partnerAccountId: accountId,
      propertyId,
      siteName: "Concurrency test site",
      addressLine1: "1 Integration Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      timezone: "America/New_York",
      latitude: "39.290400",
      longitude: "-76.612200",
      geocodeStatus: "verified",
      serviceAreaStatus: "eligible",
      active: true,
      createdByMembershipId: requesterMembershipId,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx.insert(scheduleResourcePools).values({
      key: poolKey,
      label: "Concurrency capacity",
      capacityUnits: 1,
      active: true,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx.insert(partnerSchedulingProfiles).values({
      id: profileId,
      serviceKey,
      version: 1_000_000 + Number.parseInt(suffix.slice(0, 7), 16),
      durationMinutes: 120,
      travelBufferMinutes: 0,
      capacityPoolKey: poolKey,
      capacityUnits: 1,
      supportedTerritories: [],
      requiredScopeFields: [],
      pricingEligibility: {},
      proofDefaults: { before: 1, after: 1 },
      automaticReviewRules: {},
      instantConfirmationEnabled: true,
      active: true,
      effectiveFrom: new Date(FIXED_NOW.getTime() - 86_400_000),
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx.insert(partnerRateCards).values({
      id: rateCardId,
      orgContactId: contactId,
      partnerAccountId: accountId,
      currency: "USD",
      active: true,
      version: 1,
      effectiveFrom: new Date(FIXED_NOW.getTime() - 86_400_000),
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await tx.insert(partnerRateItems).values({
      rateCardId,
      serviceKey,
      tierKey,
      label: "Standard",
      amountCents: 25_000,
      createdAt: FIXED_NOW,
    });
  });
  fixtures.set(accountId, fixture);
  return fixture;
}

async function createReadyDraft(
  fixture: Fixture,
): Promise<Awaited<ReturnType<typeof getPartnerBookingDraft>>> {
  const draftId = randomUUID();
  await getDb()
    .insert(partnerBookingDrafts)
    .values({
      id: draftId,
      partnerAccountId: fixture.accountId,
      createdByMembershipId: fixture.requesterMembershipId,
      locationId: fixture.locationId,
      serviceKey: fixture.serviceKey,
      tierKey: fixture.tierKey,
      selectedAddOns: [],
      state: "ready",
      scope: {},
      description: "Remove the staged commercial debris.",
      onSiteContact: {
        name: "Site contact",
        email: "site-contact@example.test",
      },
      proofRequirements: { before: 1, after: 1 },
      commercial: {},
      preferredWindows: [],
      reviewReasons: [],
      validation: {
        valid: true,
        ready: true,
        fieldErrors: {},
        checkedAt: FIXED_NOW.toISOString(),
      },
      revision: 1,
      expiresAt: new Date(FIXED_NOW.getTime() + 30 * 86_400_000),
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
  return getPartnerBookingDraft({
    actor: fixture.actor,
    draftId,
  });
}

async function firstAvailableWindow(
  fixture: Fixture,
  draftId: string,
  localDate: string,
) {
  const range = dateRange(localDate);
  const availability = await getPartnerDraftAvailability({
    actor: fixture.actor,
    draftId,
    rangeStartAt: range.start,
    rangeEndAt: range.end,
    now: FIXED_NOW,
  });
  const window = availability.windows.find(
    (candidate) => candidate.localDate === localDate && candidate.available,
  );
  if (!window) {
    throw new Error(
      `partner_concurrency_window_missing:${availability.reviewReasons.join(",")}`,
    );
  }
  return window;
}

async function holdFirstWindow(
  fixture: Fixture,
  draft: Awaited<ReturnType<typeof getPartnerBookingDraft>>,
  localDate: string,
  label: string,
) {
  const window = await firstAvailableWindow(fixture, draft.id, localDate);
  return createOrReplacePartnerHold({
    actor: fixture.actor,
    draftId: draft.id,
    windowId: window.id,
    idempotencyKeyHash: digest(`${label}:${randomUUID()}`),
    ifMatch: draft.etag,
    correlationId: correlation(label),
    now: FIXED_NOW,
  });
}

async function submitHeldDraft(
  fixture: Fixture,
  draft: Awaited<ReturnType<typeof getPartnerBookingDraft>>,
  localDate: string,
  label: string,
) {
  const held = await holdFirstWindow(fixture, draft, localDate, label);
  return submitPartnerBookingDraft({
    actor: fixture.actor,
    draftId: draft.id,
    holdId: held.hold.id,
    idempotencyKeyHash: digest(`submit:${label}:${randomUUID()}`),
    ifMatch: draft.etag,
    correlationId: correlation(`submit-${label}`),
    now: FIXED_NOW,
  });
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  const db = getDb();
  const [immutableDecision] = await db
    .select({ id: partnerApprovalDecisions.id })
    .from(partnerApprovalDecisions)
    .where(eq(partnerApprovalDecisions.partnerAccountId, fixture.accountId))
    .limit(1);

  if (immutableDecision) {
    // Approval decisions are deliberately append-only. This suite is run only
    // against a disposable migrated database, so preserve that evidence graph
    // while neutralizing the fixture identities instead of disabling the
    // production immutability trigger in test teardown.
    await db.transaction(async (tx) => {
      await tx
        .update(partnerAccounts)
        .set({
          name: `Retained concurrency evidence ${fixture.accountId}`,
          normalizedName: `retained concurrency evidence ${fixture.accountId}`,
          portalAccessEnabled: false,
          updatedAt: new Date(),
        })
        .where(eq(partnerAccounts.id, fixture.accountId));
      await tx
        .update(partnerUsers)
        .set({
          name: "Retained integration fixture",
          active: false,
          identityStatus: "disabled",
          updatedAt: new Date(),
        })
        .where(
          inArray(partnerUsers.id, [
            fixture.requesterUserId,
            fixture.approverUserId,
          ]),
        );
      await tx
        .update(contacts)
        .set({
          firstName: "Retained",
          lastName: "Integration fixture",
          company: null,
          email: null,
          phone: null,
          phoneE164: null,
          partnerStatus: "inactive",
          deletedAt: sql`statement_timestamp()`,
          purgeEligibleAt: sql`statement_timestamp() + interval '30 days'`,
        })
        .where(eq(contacts.id, fixture.contactId));
      await tx
        .update(partnerSchedulingProfiles)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(partnerSchedulingProfiles.id, fixture.profileId));
    });
    fixtures.delete(fixture.accountId);
    return;
  }

  await db.transaction(async (tx) => {
    const appointmentIds = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.partnerAccountId, fixture.accountId));
    const ids = appointmentIds.map((row) => row.id);
    await tx.execute(
      sql`delete from partner_notification_deliveries where partner_account_id = ${fixture.accountId}`,
    );
    await tx
      .delete(partnerNotifications)
      .where(eq(partnerNotifications.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerApprovalRequests)
      .where(eq(partnerApprovalRequests.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerApprovalRules)
      .where(eq(partnerApprovalRules.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerRescheduleRequests)
      .where(eq(partnerRescheduleRequests.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerJobEvidence)
      .where(eq(partnerJobEvidence.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerJobEvents)
      .where(eq(partnerJobEvents.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerDraftMedia)
      .where(eq(partnerDraftMedia.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerScheduleAssistanceRequests)
      .where(
        eq(
          partnerScheduleAssistanceRequests.partnerAccountId,
          fixture.accountId,
        ),
      );
    await tx
      .delete(partnerBookingDrafts)
      .where(eq(partnerBookingDrafts.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerBookings)
      .where(eq(partnerBookings.partnerAccountId, fixture.accountId));
    if (ids.length > 0) {
      await tx.delete(outboxEvents).where(
        sql`${outboxEvents.payload}->>'appointmentId' in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
    await tx.execute(
      sql`delete from outbox_events where payload->>'partnerAccountId' = ${fixture.accountId}`,
    );
    await tx
      .delete(appointments)
      .where(eq(appointments.partnerAccountId, fixture.accountId));
    await tx
      .update(partnerAccounts)
      .set({ defaultPartnerLocationId: null, portalContactId: null })
      .where(eq(partnerAccounts.id, fixture.accountId));
    await tx
      .delete(partnerAccountLocations)
      .where(eq(partnerAccountLocations.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerRateCards)
      .where(eq(partnerRateCards.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerAccountServiceAgreements)
      .where(
        eq(partnerAccountServiceAgreements.partnerAccountId, fixture.accountId),
      );
    await tx
      .delete(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerUsers)
      .where(
        inArray(partnerUsers.id, [
          fixture.requesterUserId,
          fixture.approverUserId,
        ]),
      );
    await tx
      .delete(contactProperties)
      .where(eq(contactProperties.contactId, fixture.contactId));
    await tx.delete(properties).where(eq(properties.id, fixture.propertyId));
    await tx
      .update(contacts)
      .set({
        firstName: "Retained",
        lastName: "Integration fixture",
        company: null,
        email: null,
        phone: null,
        phoneE164: null,
        partnerStatus: "inactive",
        deletedAt: sql`statement_timestamp() - interval '31 days'`,
        purgeEligibleAt: sql`statement_timestamp() - interval '1 second'`,
      })
      .where(eq(contacts.id, fixture.contactId));
    await tx
      .delete(partnerSchedulingProfiles)
      .where(eq(partnerSchedulingProfiles.id, fixture.profileId));
    await tx
      .delete(scheduleResources)
      .where(eq(scheduleResources.capacityPoolKey, fixture.poolKey));
    await tx
      .delete(scheduleResourcePools)
      .where(eq(scheduleResourcePools.key, fixture.poolKey));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.accountId));
  });
  fixtures.delete(fixture.accountId);
}

function principalFor(fixture: Fixture) {
  return {
    type: "partner" as const,
    partnerUserId: fixture.requesterUserId,
    email: fixture.requesterEmail,
    name: "Concurrency Requester",
    passwordSet: true,
    accountId: fixture.accountId,
    accountName: "Concurrency account",
    membershipId: fixture.requesterMembershipId,
    roleKey: "operations",
    persona: "commercial_client" as const,
    accessLevel: "account" as const,
    accessScope: {},
    preferences: {},
    legacyOrgContactId: fixture.contactId,
    capabilities: ["bookings.cancel"],
    accessSource: "membership" as const,
    session: {
      id: fixture.actor.sessionId,
      authMethod: "password" as const,
      assuranceLevel: "aal1" as const,
      mfaVerifiedAt: null,
      deviceName: "PostgreSQL concurrency test",
      createdAt: FIXED_NOW,
      lastSeenAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + 12 * 60 * 60_000),
    },
    security: {
      mfaRequired: false,
      mfaEnrolled: false,
      mfaSatisfied: true,
    },
    availableAccounts: [],
  };
}

describeWithDatabase(
  "partner portal V2 PostgreSQL scheduling concurrency",
  () => {
    jest.setTimeout(60_000);

    beforeAll(async () => {
      for (const key of ENVIRONMENT_KEYS) {
        originalEnvironment.set(key, process.env[key]);
      }
      process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = "true";
      process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "true";
      process.env["PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED"] = "true";
      process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"] = "false";
      delete process.env["PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS"];
      process.env["PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED"] = "false";
      process.env["GOOGLE_CALENDAR_ENABLED"] = "true";
      process.env["GOOGLE_CLIENT_ID"] = "partner-concurrency-client";
      process.env["GOOGLE_CLIENT_SECRET"] = "partner-concurrency-secret";
      process.env["GOOGLE_REFRESH_TOKEN"] = "partner-concurrency-refresh";
      process.env["GOOGLE_CALENDAR_ID"] = CALENDAR_ID;
      process.env["GOOGLE_CALENDAR_TIMEZONE"] = "America/New_York";

      const db = getDb();
      storedPolicies = await db
        .select()
        .from(policySettings)
        .where(inArray(policySettings.key, [...POLICY_KEYS]));
      const [catalog] = await db
        .select({
          instantBookable: partnerServiceCatalog.instantBookable,
          updatedAt: partnerServiceCatalog.updatedAt,
        })
        .from(partnerServiceCatalog)
        .where(eq(partnerServiceCatalog.key, "junk-removal"));
      if (!catalog) throw new Error("partner_concurrency_catalog_missing");
      storedCatalogInstantBookable = catalog.instantBookable;
      storedCatalogUpdatedAt = catalog.updatedAt;
      await db
        .update(partnerServiceCatalog)
        .set({ instantBookable: true, updatedAt: FIXED_NOW })
        .where(eq(partnerServiceCatalog.key, "junk-removal"));
      await db
        .insert(policySettings)
        .values([
          {
            key: "business_hours",
            value: {
              timezone: "America/New_York",
              weekly: {
                monday: [{ start: "08:00", end: "18:00" }],
                tuesday: [{ start: "08:00", end: "18:00" }],
                wednesday: [{ start: "08:00", end: "18:00" }],
                thursday: [{ start: "08:00", end: "18:00" }],
                friday: [{ start: "08:00", end: "18:00" }],
                saturday: [],
                sunday: [],
              },
            },
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          },
          {
            key: "booking_rules",
            value: {
              bookingWindowDays: 30,
              bufferMinutes: 0,
              maxJobsPerDay: 100,
              maxJobsPerCrew: 100,
            },
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          },
        ])
        .onConflictDoUpdate({
          target: policySettings.key,
          set: { value: sql`excluded.value`, updatedAt: FIXED_NOW },
        });
      await db.insert(calendarSyncState).values({
        calendarId: CALENDAR_ID,
        lastSyncedAt: FIXED_NOW,
        externalBusyCoverageSyncedAt: FIXED_NOW,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      });
    });

    afterEach(async () => {
      mockRequirePartnerCapability.mockReset();
      for (const fixture of [...fixtures.values()]) {
        await cleanupFixture(fixture);
      }
    });

    afterAll(async () => {
      const db = getDb();
      await db
        .delete(calendarSyncState)
        .where(eq(calendarSyncState.calendarId, CALENDAR_ID));
      await db
        .delete(policySettings)
        .where(inArray(policySettings.key, [...POLICY_KEYS]));
      if (storedPolicies.length > 0) {
        await db.insert(policySettings).values(storedPolicies);
      }
      await db
        .update(partnerServiceCatalog)
        .set({
          instantBookable: storedCatalogInstantBookable,
          ...(storedCatalogUpdatedAt
            ? { updatedAt: storedCatalogUpdatedAt }
            : {}),
        })
        .where(eq(partnerServiceCatalog.key, "junk-removal"));
      for (const key of ENVIRONMENT_KEYS) {
        const original = originalEnvironment.get(key);
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
      await closeDbForTests();
    });

    it("grants only one simultaneous hold on the same last-capacity arrival window", async () => {
      const fixture = await createFixture();
      const firstDraft = await createReadyDraft(fixture);
      const secondDraft = await createReadyDraft(fixture);
      const window = await firstAvailableWindow(
        fixture,
        firstDraft.id,
        FIRST_SERVICE_DATE,
      );

      const outcomes = await Promise.allSettled([
        createOrReplacePartnerHold({
          actor: fixture.actor,
          draftId: firstDraft.id,
          windowId: window.id,
          idempotencyKeyHash: digest(`hold-a:${randomUUID()}`),
          ifMatch: firstDraft.etag,
          correlationId: correlation("hold-a"),
          now: FIXED_NOW,
        }),
        createOrReplacePartnerHold({
          actor: fixture.actor,
          draftId: secondDraft.id,
          windowId: window.id,
          idempotencyKeyHash: digest(`hold-b:${randomUUID()}`),
          ifMatch: secondDraft.etag,
          correlationId: correlation("hold-b"),
          now: FIXED_NOW,
        }),
      ]);
      const granted = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<unknown> =>
          outcome.status === "fulfilled",
      );
      const refused = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );

      expect(granted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toBeInstanceOf(PartnerPortalSchedulingError);
      expect((refused[0]?.reason as PartnerPortalSchedulingError).code).toBe(
        "slot_unavailable",
      );
      const active = await getDb()
        .select({
          id: appointmentHolds.id,
          startAt: appointmentHolds.startAt,
          resourceAssignments: appointmentHolds.resourceAssignmentSnapshot,
        })
        .from(appointmentHolds)
        .where(
          and(
            eq(appointmentHolds.partnerAccountId, fixture.accountId),
            eq(appointmentHolds.status, "active"),
            inArray(appointmentHolds.partnerBookingDraftId, [
              firstDraft.id,
              secondDraft.id,
            ]),
          ),
        );
      expect(active).toHaveLength(1);
      expect(active[0]?.resourceAssignments).toEqual([
        expect.objectContaining({ kind: "crew", capacityUnits: 1 }),
        expect.objectContaining({ kind: "truck", capacityUnits: 1 }),
      ]);
    });

    it("releases partner capacity through the locked service before another draft claims the same window", async () => {
      const fixture = await createFixture();
      const firstDraft = await createReadyDraft(fixture);
      const secondDraft = await createReadyDraft(fixture);
      const window = await firstAvailableWindow(
        fixture,
        firstDraft.id,
        FIRST_SERVICE_DATE,
      );
      const firstHold = await createOrReplacePartnerHold({
        actor: fixture.actor,
        draftId: firstDraft.id,
        windowId: window.id,
        idempotencyKeyHash: digest(`release-first:${randomUUID()}`),
        ifMatch: firstDraft.etag,
        correlationId: correlation("release-first"),
        now: FIXED_NOW,
      });

      await expect(
        releasePartnerHold({
          actor: fixture.actor,
          draftId: firstDraft.id,
          holdId: firstHold.hold.id,
          now: FIXED_NOW,
        }),
      ).resolves.toEqual({ released: true });
      const replacement = await createOrReplacePartnerHold({
        actor: fixture.actor,
        draftId: secondDraft.id,
        windowId: window.id,
        idempotencyKeyHash: digest(`release-second:${randomUUID()}`),
        ifMatch: secondDraft.etag,
        correlationId: correlation("release-second"),
        now: FIXED_NOW,
      });

      const rows = await getDb()
        .select({ id: appointmentHolds.id, status: appointmentHolds.status })
        .from(appointmentHolds)
        .where(
          inArray(appointmentHolds.id, [
            firstHold.hold.id,
            replacement.hold.id,
          ]),
        );
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: firstHold.hold.id, status: "released" },
          { id: replacement.hold.id, status: "active" },
        ]),
      );
    });

    it("makes a capacity claim wait for a locked staff cancellation and then re-read the committed schedule", async () => {
      const fixture = await createFixture();
      const sourceDraft = await createReadyDraft(fixture);
      const waitingDraft = await createReadyDraft(fixture);
      const window = await firstAvailableWindow(
        fixture,
        sourceDraft.id,
        FIRST_SERVICE_DATE,
      );
      const held = await createOrReplacePartnerHold({
        actor: fixture.actor,
        draftId: sourceDraft.id,
        windowId: window.id,
        idempotencyKeyHash: digest(`status-source-hold:${randomUUID()}`),
        ifMatch: sourceDraft.etag,
        correlationId: correlation("status-source-hold"),
        now: FIXED_NOW,
      });
      const submitted = await submitPartnerBookingDraft({
        actor: fixture.actor,
        draftId: sourceDraft.id,
        holdId: held.hold.id,
        idempotencyKeyHash: digest(`status-source-submit:${randomUUID()}`),
        ifMatch: sourceDraft.etag,
        correlationId: correlation("status-source-submit"),
        now: FIXED_NOW,
      });
      const [sourceBooking] = await getDb()
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, submitted.booking.id));
      if (!sourceBooking) throw new Error("status_source_booking_missing");

      let signalCanceled: (() => void) | undefined;
      const canceledInsideTransaction = new Promise<void>((resolve) => {
        signalCanceled = resolve;
      });
      let allowCommit: (() => void) | undefined;
      const commitGate = new Promise<void>((resolve) => {
        allowCommit = resolve;
      });
      const cancellation = getDb().transaction(async (tx) => {
        await acquireScheduleConflictLock(tx);
        const [canceled] = await tx
          .update(appointments)
          .set({
            status: "canceled",
            updatedAt: new Date(FIXED_NOW.getTime() + 1),
          })
          .where(eq(appointments.id, sourceBooking.appointmentId))
          .returning({ id: appointments.id });
        if (!canceled) throw new Error("status_source_cancel_failed");
        signalCanceled?.();
        await commitGate;
      });
      await canceledInsideTransaction;

      const waitingHold = createOrReplacePartnerHold({
        actor: fixture.actor,
        draftId: waitingDraft.id,
        windowId: window.id,
        idempotencyKeyHash: digest(`status-waiting-hold:${randomUUID()}`),
        ifMatch: waitingDraft.etag,
        correlationId: correlation("status-waiting-hold"),
        now: FIXED_NOW,
      });
      allowCommit?.();
      const [, claimed] = await Promise.all([cancellation, waitingHold]);

      const [appointment, activeHolds] = await Promise.all([
        getDb()
          .select({ status: appointments.status })
          .from(appointments)
          .where(eq(appointments.id, sourceBooking.appointmentId)),
        getDb()
          .select({ id: appointmentHolds.id })
          .from(appointmentHolds)
          .where(
            and(
              eq(appointmentHolds.partnerAccountId, fixture.accountId),
              eq(appointmentHolds.status, "active"),
            ),
          ),
      ]);
      expect(appointment).toEqual([{ status: "canceled" }]);
      expect(activeHolds).toEqual([{ id: claimed.hold.id }]);
    });

    it("replays simultaneous duplicate submission without duplicating the booking, appointment, or hold consumption", async () => {
      const fixture = await createFixture();
      const draft = await createReadyDraft(fixture);
      const held = await holdFirstWindow(
        fixture,
        draft,
        FIRST_SERVICE_DATE,
        "duplicate-submit-hold",
      );
      const idempotencyKeyHash = digest(`duplicate-submit:${randomUUID()}`);
      const input = {
        actor: fixture.actor,
        draftId: draft.id,
        holdId: held.hold.id,
        idempotencyKeyHash,
        ifMatch: draft.etag,
        correlationId: correlation("duplicate-submit"),
        now: FIXED_NOW,
      } as const;

      const results = await Promise.all([
        submitPartnerBookingDraft(input),
        submitPartnerBookingDraft(input),
      ]);

      expect(results.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(
        new Set(results.map((result) => result.booking.id)),
      ).toHaveProperty("size", 1);
      const [bookings, scheduledAppointments, holds] = await Promise.all([
        getDb()
          .select({ id: partnerBookings.id })
          .from(partnerBookings)
          .where(eq(partnerBookings.bookingDraftId, draft.id)),
        getDb()
          .select({
            id: appointments.id,
            resourceAssignments: appointments.resourceAssignmentSnapshot,
          })
          .from(appointments)
          .where(eq(appointments.partnerAccountId, fixture.accountId)),
        getDb()
          .select({ id: appointmentHolds.id, status: appointmentHolds.status })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, held.hold.id)),
      ]);
      expect(bookings).toHaveLength(1);
      expect(scheduledAppointments).toHaveLength(1);
      expect(scheduledAppointments[0]?.resourceAssignments).toEqual([
        expect.objectContaining({ kind: "crew", capacityUnits: 1 }),
        expect.objectContaining({ kind: "truck", capacityUnits: 1 }),
      ]);
      expect(holds).toEqual([
        expect.objectContaining({ id: held.hold.id, status: "consumed" }),
      ]);
    });

    it("keeps a replacement hold authoritative while reschedule races a staff scheduling transaction", async () => {
      const fixture = await createFixture();
      const sourceDraft = await createReadyDraft(fixture);
      const submitted = await submitHeldDraft(
        fixture,
        sourceDraft,
        FIRST_SERVICE_DATE,
        "reschedule-source",
      );
      const [sourceBooking] = await getDb()
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, submitted.booking.id));
      if (!sourceBooking) throw new Error("source_booking_missing");
      const sourceEtag = createPortalV2StrongEtag(
        `${sourceBooking.id}:${sourceBooking.version}:${sourceBooking.updatedAt.toISOString()}`,
      );
      const rescheduleDraft = await createPartnerRescheduleDraft({
        actor: fixture.actor,
        jobId: sourceBooking.id,
        idempotencyKeyHash: digest(`reschedule-draft:${randomUUID()}`),
        ifMatch: sourceEtag,
        correlationId: correlation("reschedule-draft"),
        now: FIXED_NOW,
      });
      const replacement = await holdFirstWindow(
        fixture,
        rescheduleDraft.draft,
        SECOND_SERVICE_DATE,
        "replacement-hold",
      );
      const [replacementRow] = await getDb()
        .select()
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, replacement.hold.id));
      if (!replacementRow) throw new Error("replacement_hold_missing");

      const staffMutation = getDb().transaction(async (tx) => {
        await acquireScheduleConflictLock(tx);
        const decision = await inspectScheduleConflicts(tx, {
          startAt: replacementRow.startAt,
          durationMinutes: replacementRow.durationMinutes,
          travelBufferMinutes: replacementRow.travelBufferMinutes,
          capacity: 1,
          includeHolds: true,
          now: FIXED_NOW,
        });
        if (decision.conflict) {
          return { scheduled: false as const, decision };
        }
        const [created] = await tx
          .insert(appointments)
          .values({
            contactId: fixture.contactId,
            propertyId: fixture.propertyId,
            type: "job",
            startAt: replacementRow.startAt,
            durationMinutes: replacementRow.durationMinutes,
            travelBufferMinutes: replacementRow.travelBufferMinutes,
            status: "confirmed",
            rescheduleToken: randomUUID().replaceAll("-", ""),
            partnerAccountId: fixture.accountId,
            capacityPoolKey: fixture.poolKey,
            capacityUnits: 1,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          })
          .returning({ id: appointments.id });
        return { scheduled: true as const, appointmentId: created?.id ?? null };
      });
      const partnerMutation = reschedulePartnerBooking({
        actor: fixture.actor,
        jobId: sourceBooking.id,
        draftId: rescheduleDraft.draft.id,
        holdId: replacement.hold.id,
        idempotencyKeyHash: digest(`reschedule-submit:${randomUUID()}`),
        jobIfMatch: sourceEtag,
        draftIfMatch: rescheduleDraft.draft.etag,
        correlationId: correlation("reschedule-submit"),
        now: FIXED_NOW,
      });
      const [staffResult, partnerResult] = await Promise.all([
        staffMutation,
        partnerMutation,
      ]);

      expect(staffResult.scheduled).toBe(false);
      expect(
        "decision" in staffResult ? staffResult.decision.conflict : false,
      ).toBe(true);
      expect(partnerResult).toMatchObject({
        replayed: false,
        result: { mode: "instant", publicStatus: "confirmed" },
      });
      const [updatedAppointment] = await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, sourceBooking.appointmentId));
      expect(updatedAppointment?.startAt).toEqual(replacementRow.startAt);
      expect(updatedAppointment?.capacityPoolKey).toBe(
        replacementRow.capacityPoolKey,
      );
      const collidingAppointments = await getDb()
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.partnerAccountId, fixture.accountId),
            gte(appointments.startAt, replacementRow.startAt),
            lt(
              appointments.startAt,
              new Date(replacementRow.startAt.getTime() + 120 * 60_000),
            ),
          ),
        );
      expect(collidingAppointments).toEqual([
        { id: sourceBooking.appointmentId },
      ]);
      const [consumed] = await getDb()
        .select({ status: appointmentHolds.status })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, replacement.hold.id));
      expect(consumed?.status).toBe("consumed");
    });

    it("preserves the confirmed appointment and persists the replacement window when the account cutoff requires reschedule review", async () => {
      const fixture = await createFixture();
      await getDb()
        .update(partnerAccountCancellationPolicies)
        .set({
          minimumNoticeMinutes: 7 * 24 * 60,
          directCancellationEnabled: true,
          revision: 2,
          updatedAt: FIXED_NOW,
        })
        .where(
          eq(
            partnerAccountCancellationPolicies.partnerAccountId,
            fixture.accountId,
          ),
        );
      const sourceDraft = await createReadyDraft(fixture);
      const submitted = await submitHeldDraft(
        fixture,
        sourceDraft,
        FIRST_SERVICE_DATE,
        "late-reschedule-source",
      );
      const [sourceBooking] = await getDb()
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, submitted.booking.id));
      if (!sourceBooking) throw new Error("source_booking_missing");
      const [sourceAppointment] = await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, sourceBooking.appointmentId));
      if (!sourceAppointment?.startAt) {
        throw new Error("source_appointment_missing");
      }
      const sourceEtag = createPortalV2StrongEtag(
        `${sourceBooking.id}:${sourceBooking.version}:${sourceBooking.updatedAt.toISOString()}`,
      );
      const rescheduleDraft = await createPartnerRescheduleDraft({
        actor: fixture.actor,
        jobId: sourceBooking.id,
        idempotencyKeyHash: digest(`late-reschedule-draft:${randomUUID()}`),
        ifMatch: sourceEtag,
        correlationId: correlation("late-reschedule-draft"),
        now: FIXED_NOW,
      });
      const replacement = await holdFirstWindow(
        fixture,
        rescheduleDraft.draft,
        SECOND_SERVICE_DATE,
        "late-reschedule-replacement",
      );

      const result = await reschedulePartnerBooking({
        actor: fixture.actor,
        jobId: sourceBooking.id,
        draftId: rescheduleDraft.draft.id,
        holdId: replacement.hold.id,
        idempotencyKeyHash: digest(`late-reschedule-submit:${randomUUID()}`),
        jobIfMatch: sourceEtag,
        draftIfMatch: rescheduleDraft.draft.etag,
        correlationId: correlation("late-reschedule-submit"),
        now: FIXED_NOW,
      });

      expect(result).toMatchObject({
        replayed: false,
        result: {
          mode: "review",
          publicStatus: "confirmed",
          consequence: {
            existingScheduleRemainsInPlace: true,
            automaticFeeMinor: null,
          },
        },
      });
      expect(result.result.reviewReasons).toContain(
        "schedule_change_policy_review_required",
      );
      const [appointment, hold, request] = await Promise.all([
        getDb()
          .select()
          .from(appointments)
          .where(eq(appointments.id, sourceBooking.appointmentId))
          .then((rows) => rows[0]),
        getDb()
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, replacement.hold.id))
          .then((rows) => rows[0]),
        getDb()
          .select()
          .from(partnerRescheduleRequests)
          .where(
            eq(partnerRescheduleRequests.partnerBookingId, sourceBooking.id),
          )
          .then((rows) => rows[0]),
      ]);
      expect(appointment?.startAt).toEqual(sourceAppointment.startAt);
      expect(hold?.status).toBe("released");
      expect(request).toMatchObject({
        state: "pending",
        previousStartAt: sourceAppointment.startAt,
        requestedArrivalStartAt: new Date(
          replacement.hold.arrivalWindowStartAt,
        ),
        requestedArrivalEndAt: new Date(replacement.hold.arrivalWindowEndAt),
      });
    });

    it("atomically persists and replays a durable scheduling callback for an unscheduled review request", async () => {
      const fixture = await createFixture();
      const initialDraft = await createReadyDraft(fixture);
      await getDb()
        .update(partnerBookingDrafts)
        .set({
          preferredWindows: [
            {
              localDate: FIRST_SERVICE_DATE,
              timeOfDay: "anytime",
              timezone: "America/New_York",
            },
          ],
          scheduleAssistancePreference: "callback",
          revision: initialDraft.revision + 1,
          updatedAt: FIXED_NOW,
        })
        .where(eq(partnerBookingDrafts.id, initialDraft.id));
      const draft = await getPartnerBookingDraft({
        actor: fixture.actor,
        draftId: initialDraft.id,
      });
      const submitKey = digest(`review-callback:${randomUUID()}`);

      const first = await submitPartnerBookingDraft({
        actor: fixture.actor,
        draftId: draft.id,
        holdId: null,
        idempotencyKeyHash: submitKey,
        ifMatch: draft.etag,
        correlationId: correlation("review-callback"),
        now: FIXED_NOW,
      });
      const replay = await submitPartnerBookingDraft({
        actor: fixture.actor,
        draftId: draft.id,
        holdId: null,
        idempotencyKeyHash: submitKey,
        ifMatch: draft.etag,
        correlationId: correlation("review-callback-replay"),
        now: FIXED_NOW,
      });

      const assistance = await getDb()
        .select()
        .from(partnerScheduleAssistanceRequests)
        .where(
          and(
            eq(
              partnerScheduleAssistanceRequests.partnerAccountId,
              fixture.accountId,
            ),
            eq(
              partnerScheduleAssistanceRequests.partnerBookingId,
              first.booking.id,
            ),
          ),
        );
      const [booking] = await getDb()
        .select({ appointmentId: partnerBookings.appointmentId })
        .from(partnerBookings)
        .where(eq(partnerBookings.id, first.booking.id));
      const [appointment] = booking
        ? await getDb()
            .select({ startAt: appointments.startAt })
            .from(appointments)
            .where(eq(appointments.id, booking.appointmentId))
        : [];

      expect(first.replayed).toBe(false);
      expect(replay).toEqual({ booking: first.booking, replayed: true });
      expect(assistance).toHaveLength(1);
      expect(assistance[0]).toMatchObject({
        partnerAccountId: fixture.accountId,
        partnerBookingId: first.booking.id,
        bookingDraftId: draft.id,
        requestedByMembershipId: fixture.requesterMembershipId,
        preference: "callback",
        state: "pending",
        preferredWindowsSnapshot: {
          version: 1,
          windows: [
            {
              localDate: FIRST_SERVICE_DATE,
              timeOfDay: "anytime",
              timezone: "America/New_York",
            },
          ],
        },
      });
      expect(appointment?.startAt).toBeNull();
    });

    it("serializes cancellation against approval confirmation without a split booking/appointment outcome", async () => {
      const fixture = await createFixture();
      await getDb()
        .insert(partnerApprovalRules)
        .values({
          partnerAccountId: fixture.accountId,
          name: "Concurrency approval",
          conditions: {},
          requiredApproverRoleKeys: [],
          requiredApproverCapabilities: ["approvals.decide"],
          requiredDecisionCount: 1,
          active: true,
          version: 1,
          createdByMembershipId: fixture.approverMembershipId,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        });
      const draft = await createReadyDraft(fixture);
      const submitted = await submitHeldDraft(
        fixture,
        draft,
        FIRST_SERVICE_DATE,
        "cancel-confirm",
      );
      expect(submitted.booking.publicStatus).toBe("approval_needed");
      const [booking] = await getDb()
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, submitted.booking.id));
      const [approval] = await getDb()
        .select()
        .from(partnerApprovalRequests)
        .where(
          eq(partnerApprovalRequests.partnerBookingId, submitted.booking.id),
        );
      if (!booking || !approval) throw new Error("approval_fixture_missing");
      const bookingEtag = createPortalV2StrongEtag(
        `${booking.id}:${booking.version}:${booking.updatedAt.toISOString()}`,
      );
      const approvalEtag = createPortalV2StrongEtag(
        `${approval.id}:${approval.revision}:${approval.updatedAt.toISOString()}`,
      );
      mockRequirePartnerCapability.mockResolvedValue({
        ok: true,
        principal: principalFor(fixture),
      });
      const cancelRequest = new NextRequest(
        `http://localhost/api/portal/v2/jobs/${booking.id}/cancel`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `cancel-${randomUUID()}`,
            "if-match": bookingEtag,
            "x-correlation-id": correlation("cancel-confirm-cancel"),
          },
          body: JSON.stringify({ reason: "The customer canceled this job." }),
        },
      );

      const [cancelResponse, approvalResult] = await Promise.all([
        cancelPartnerJob(cancelRequest, {
          params: Promise.resolve({ jobId: booking.id }),
        }),
        decidePartnerApprovalRequest({
          accountId: fixture.accountId,
          membershipId: fixture.approverMembershipId,
          partnerUserId: fixture.approverUserId,
          email: fixture.approverEmail,
          roleKey: "billing_approver",
          sessionId: randomUUID(),
          correlationId: correlation("cancel-confirm-approval"),
          idempotencyKeyHash: digest(`approval:${randomUUID()}`),
          requestId: approval.id,
          ifMatch: approvalEtag,
          decision: "approved",
          reason: "Approved for service.",
          now: new Date(FIXED_NOW.getTime() + 60_000),
        }),
      ]);
      const [finalBooking] = await getDb()
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, booking.id));
      const [finalAppointment] = await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, booking.appointmentId));
      const [finalApproval] = await getDb()
        .select()
        .from(partnerApprovalRequests)
        .where(eq(partnerApprovalRequests.id, approval.id));
      if (!finalBooking || !finalAppointment || !finalApproval) {
        throw new Error("cancel_confirm_final_state_missing");
      }

      expect([200, 409, 412]).toContain(cancelResponse.status);
      expect([200, 409]).toContain(approvalResult.status);
      expect([finalBooking.publicStatus, finalAppointment.status]).toEqual(
        finalBooking.publicStatus === "canceled"
          ? ["canceled", "canceled"]
          : ["confirmed", "confirmed"],
      );
      if (finalBooking.publicStatus === "canceled") {
        expect(approvalResult.status).toBe(409);
        expect(finalApproval.state).toBe("pending");
        expect(cancelResponse.status).toBe(200);
      } else {
        expect(approvalResult.status).toBe(200);
        expect(finalApproval.state).toBe("approved");
        expect(cancelResponse.status).toBe(412);
      }
    });
  },
);
