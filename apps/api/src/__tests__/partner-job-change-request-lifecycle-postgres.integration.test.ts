import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccountMemberships,
  partnerAccountServiceAgreements,
  partnerAccounts,
  partnerBookings,
  partnerJobChangeOrders,
  partnerJobChangeRequests,
  partnerJobEvents,
  partnerNotifications,
  partnerQuotes,
  partnerUsers,
  properties,
  quoteResponses,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  salesOpportunities,
  teamMembers,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import {
  acquirePartnerJobMutationLock,
  createPartnerJobChangeRequest,
  decidePartnerJobChangeRequestAsStaff,
  partnerJobChangeRequestEtag,
  supersedePendingPartnerJobChangeRequestForCancellation,
  updatePartnerJobReferences,
} from "@/lib/partner-job-change-request-lifecycle";
import { resolvePartnerJobChangeOrderFromQuoteResponse } from "@/lib/partner-job-change-orders";

const jest = import.meta.jest;
const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

const NO_MATERIAL_IMPACT = Object.freeze({
  price: false,
  schedule: false,
  service: false,
  quantity: false,
  hazards: false,
  proof: false,
});

type Fixture = Readonly<{
  accountId: string;
  appointmentId: string;
  bookingId: string;
  contactId: string;
  membershipId: string;
  partnerUserId: string;
  principal: PartnerPrincipal;
  propertyId: string;
  teamMemberId: string;
}>;

type DatabaseError = Readonly<{
  code?: unknown;
  constraint_name?: unknown;
  message?: unknown;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepestDatabaseError(error: unknown): DatabaseError {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (!record["cause"]) return record;
    current = record["cause"];
  }
  return {};
}

async function createFixture(): Promise<Fixture> {
  const now = new Date();
  const accountId = randomUUID();
  const appointmentId = randomUUID();
  const bookingId = randomUUID();
  const contactId = randomUUID();
  const membershipId = randomUUID();
  const partnerUserId = randomUUID();
  const propertyId = randomUUID();
  const teamMemberId = randomUUID();
  const suffix = accountId.replaceAll("-", "").slice(0, 12);
  const email = `job-change-${suffix}@example.test`;
  const serviceAt = new Date(now.getTime() + 4 * 60 * 60_000);
  const accountName = `Job change lifecycle ${suffix}`;

  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({
      id: teamMemberId,
      name: `Job change reviewer ${suffix}`,
    });
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: accountName,
      normalizedName: accountName.toLowerCase(),
      status: "active_partner",
      portalAccessEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Job",
      lastName: "Change",
      company: accountName,
      partnerAccountId: accountId,
      partnerStatus: "partner",
      source: "partner_job_change_lifecycle_integration",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressKey: `partner-job-change:${suffix}`,
      addressLine1: "1 Change Request Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(partnerUsers).values({
      id: partnerUserId,
      email,
      normalizedEmail: email,
      name: "Job Change Requester",
      active: true,
      identityStatus: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId,
      roleKey: "administrator",
      status: "active",
      accessLevel: "account",
      acceptedAt: now,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(appointments).values({
      id: appointmentId,
      contactId,
      propertyId,
      type: "job",
      startAt: serviceAt,
      schedulingTimezone: "America/New_York",
      durationMinutes: 120,
      travelBufferMinutes: 30,
      status: "confirmed",
      rescheduleToken: randomUUID().replaceAll("-", ""),
      partnerAccountId: accountId,
      promisedArrivalStartAt: serviceAt,
      promisedArrivalEndAt: new Date(serviceAt.getTime() + 2 * 60 * 60_000),
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(partnerBookings).values({
      id: bookingId,
      orgContactId: contactId,
      partnerAccountId: accountId,
      requestedByMembershipId: membershipId,
      partnerUserId,
      propertyId,
      appointmentId,
      serviceKey: "junk-removal",
      publicStatus: "confirmed",
      confirmationMode: "instant",
      arrivalWindowStartAt: serviceAt,
      arrivalWindowEndAt: new Date(serviceAt.getTime() + 2 * 60 * 60_000),
      scopeSnapshot: {
        description: "Remove boxed materials from the loading area.",
        accessDetails: "Check in at the front desk.",
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  const accountAccess = Object.freeze({
    accountId,
    accountName,
    accountStatus: "active_partner",
    membershipId,
    membershipStatus: "active" as const,
    roleKey: "administrator",
    persona: "commercial_client" as const,
    accessLevel: "account" as const,
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    capabilities: Object.freeze([
      "jobs.change_request" as const,
      "commercial.edit" as const,
    ]),
    isDefault: true,
    legacyOrgContactId: null,
    source: "membership" as const,
  });
  const principal: PartnerPrincipal = Object.freeze({
    type: "partner",
    partnerUserId,
    email,
    name: "Job Change Requester",
    passwordSet: true,
    accountId,
    accountName,
    membershipId,
    roleKey: "administrator",
    persona: "commercial_client",
    accessLevel: "account",
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    legacyOrgContactId: null,
    capabilities: ["jobs.change_request", "commercial.edit"],
    accessSource: "membership",
    session: Object.freeze({
      id: randomUUID(),
      authMethod: "password",
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
      deviceName: "PostgreSQL integration",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    }),
    security: Object.freeze({
      mfaRequired: false,
      mfaEnrolled: false,
      mfaSatisfied: true,
    }),
    availableAccounts: [accountAccess],
  });
  return {
    accountId,
    appointmentId,
    bookingId,
    contactId,
    membershipId,
    partnerUserId,
    principal,
    propertyId,
    teamMemberId,
  };
}

async function currentJobEtag(fixture: Fixture): Promise<string> {
  const [job] = await getDb()
    .select({
      id: partnerBookings.id,
      version: partnerBookings.version,
      updatedAt: partnerBookings.updatedAt,
    })
    .from(partnerBookings)
    .where(eq(partnerBookings.id, fixture.bookingId));
  if (!job) throw new Error("partner_job_change_fixture_missing");
  return partnerJobChangeRequestEtag({
    jobId: job.id,
    revision: job.version,
    updatedAt: job.updatedAt,
  });
}

async function createRequest(
  fixture: Fixture,
  input?: Readonly<{
    operationKeyHash?: string;
    requestHash?: string;
    ifMatch?: string;
  }>,
) {
  return getDb().transaction((tx) =>
    createPartnerJobChangeRequest(tx, {
      principal: fixture.principal,
      jobId: fixture.bookingId,
      payload: {
        reason: "Use the rear loading entrance instead of the front desk.",
        proposedChanges: {
          accessDetails: "Use the rear loading entrance and call on arrival.",
          materiality: NO_MATERIAL_IMPACT,
        },
      },
      operationKeyHash:
        input?.operationKeyHash ?? digest(`operation:${fixture.bookingId}`),
      requestHash: input?.requestHash ?? digest(`request:${fixture.bookingId}`),
      ifMatch: input?.ifMatch ?? null,
      correlationId: `job-change-create-${randomUUID()}`,
    }),
  );
}

async function createMaterialRequest(fixture: Fixture) {
  const ifMatch = await currentJobEtag(fixture);
  return getDb().transaction((tx) =>
    createPartnerJobChangeRequest(tx, {
      principal: fixture.principal,
      jobId: fixture.bookingId,
      payload: {
        reason:
          "Add the loading-dock access change and price the requested schedule impact.",
        proposedChanges: {
          accessDetails:
            "Use loading dock B and call the site contact on arrival.",
          materiality: {
            ...NO_MATERIAL_IMPACT,
            price: true,
            schedule: true,
          },
        },
      },
      operationKeyHash: digest(`material-operation:${fixture.bookingId}`),
      requestHash: digest(`material-request:${fixture.bookingId}`),
      ifMatch,
      correlationId: `material-change-${randomUUID()}`,
    }),
  );
}

async function createIssuedJobQuote(fixture: Fixture): Promise<{
  partnerQuoteId: string;
  quoteId: string;
  versionId: string;
}> {
  const now = new Date();
  const opportunityId = randomUUID();
  const quoteId = randomUUID();
  const versionId = randomUUID();
  const partnerQuoteId = randomUUID();
  const hash = "a".repeat(64);
  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccountServiceAgreements).values({
      partnerAccountId: fixture.accountId,
      active: true,
      agreementLabel: "Change-order test agreement",
      currency: "USD",
      effectiveFrom: new Date(now.getTime() - 86_400_000),
      effectiveTo: new Date(now.getTime() + 86_400_000),
      inclusions: [],
      exclusions: [],
      quoteRules: "Material changes require one issued fixed-price quote.",
      serviceEntitlements: [
        {
          serviceKey: "junk-removal",
          pricingState: "contracted",
          inclusions: [],
          exclusions: [],
          quoteRule: null,
        },
      ],
      revision: 1,
      updatedByTeamMemberId: fixture.teamMemberId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(salesOpportunities).values({
      id: opportunityId,
      contactId: fixture.contactId,
      propertyId: fixture.propertyId,
      name: "Partner job change order",
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
      contactId: fixture.contactId,
      propertyId: fixture.propertyId,
      status: "sent",
      services: ["junk-removal"],
      addOns: [],
      zoneId: "partner-change-order-test",
      travelFee: "0",
      discounts: "0",
      addOnsTotal: "0",
      subtotal: "123.45",
      total: "123.45",
      depositDue: "0",
      depositRate: "0",
      balanceDue: "123.45",
      lineItems: [],
      quoteNumber: `Q-CHANGE-${randomUUID()}`,
      jobDurationMinutes: 120,
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
      subtotalMinCents: 12_345,
      subtotalMaxCents: 12_345,
      discountMinCents: 0,
      discountMaxCents: 0,
      feeMinCents: 0,
      feeMaxCents: 0,
      totalMinCents: 12_345,
      totalMaxCents: 12_345,
      depositCents: 0,
      balanceMinCents: 12_345,
      balanceMaxCents: 12_345,
      validFrom: now,
      readyAt: now,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdByTeamMemberId: fixture.teamMemberId,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .update(quotes)
      .set({ currentVersionId: versionId, publishedVersionId: versionId })
      .where(eq(quotes.id, quoteId));
    await tx.insert(quoteVersionDocuments).values({
      quoteVersionId: versionId,
      kind: "proposal_pdf",
      filename: "change-order.pdf",
      contentType: "application/pdf",
      storageProvider: "test",
      storageBucket: "partner-change-order-test",
      storageObjectKey: `${quoteId}/proposal.pdf`,
      byteSize: 128,
      sha256: hash,
      generatedByTeamMemberId: fixture.teamMemberId,
      generatedAt: now,
      createdAt: now,
    });
    await tx.insert(partnerQuotes).values({
      id: partnerQuoteId,
      authority: "quote_v2",
      partnerAccountId: fixture.accountId,
      partnerBookingId: fixture.bookingId,
      quoteId,
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
      createdByTeamMemberId: fixture.teamMemberId,
      createdAt: now,
      updatedAt: now,
    });
  });
  return { partnerQuoteId, quoteId, versionId };
}

async function cancelFixtureDirectly(fixture: Fixture) {
  return getDb().transaction(async (tx) => {
    await acquireScheduleConflictLock(tx);
    await acquirePartnerJobMutationLock(
      tx,
      fixture.accountId,
      fixture.bookingId,
    );
    const [current] = await tx
      .select({
        bookingVersion: partnerBookings.version,
        appointmentStatus: appointments.status,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(appointments.id, partnerBookings.appointmentId),
      )
      .where(
        and(
          eq(partnerBookings.partnerAccountId, fixture.accountId),
          eq(partnerBookings.id, fixture.bookingId),
        ),
      )
      .for("update", { of: partnerBookings });
    if (!current) throw new Error("partner_job_change_cancel_fixture_missing");
    const now = new Date();
    const [appointment] = await tx
      .update(appointments)
      .set({ status: "canceled", updatedAt: now })
      .where(
        and(
          eq(appointments.id, fixture.appointmentId),
          eq(appointments.status, current.appointmentStatus),
        ),
      )
      .returning({ id: appointments.id });
    if (!appointment)
      throw new Error("partner_job_change_cancel_appointment_race");
    const [booking] = await tx
      .update(partnerBookings)
      .set({
        publicStatus: "canceled",
        canceledAt: now,
        version: current.bookingVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerBookings.partnerAccountId, fixture.accountId),
          eq(partnerBookings.id, fixture.bookingId),
          eq(partnerBookings.version, current.bookingVersion),
        ),
      )
      .returning({ version: partnerBookings.version });
    if (!booking) throw new Error("partner_job_change_cancel_booking_race");
    const superseded =
      await supersedePendingPartnerJobChangeRequestForCancellation(tx, {
        accountId: fixture.accountId,
        jobId: fixture.bookingId,
        actorType: "system",
        triggeringMembershipId: fixture.membershipId,
        bookingRevisionBefore: current.bookingVersion,
        bookingRevisionAfter: booking.version,
        correlationId: `direct-cancel-${randomUUID()}`,
        now,
      });
    return { bookingVersion: booking.version, superseded };
  });
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`delete from partner_notification_deliveries where partner_account_id = ${fixture.accountId}`,
    );
    await tx
      .delete(partnerNotifications)
      .where(eq(partnerNotifications.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerJobEvents)
      .where(eq(partnerJobEvents.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerJobChangeOrders)
      .where(eq(partnerJobChangeOrders.partnerAccountId, fixture.accountId));
    await tx.execute(sql.raw("SET LOCAL session_replication_role = 'replica'"));
    await tx.execute(
      sql`delete from quote_responses where quote_id in (select id from quotes where partner_account_id = ${fixture.accountId})`,
    );
    await tx.execute(
      sql`delete from quote_version_documents where quote_version_id in (select version.id from quote_versions version join quotes quote on quote.id = version.quote_id where quote.partner_account_id = ${fixture.accountId})`,
    );
    await tx
      .delete(partnerQuotes)
      .where(eq(partnerQuotes.partnerAccountId, fixture.accountId));
    await tx.execute(
      sql`update quotes set current_version_id = null, published_version_id = null where partner_account_id = ${fixture.accountId}`,
    );
    await tx.execute(
      sql`delete from quote_versions where quote_id in (select id from quotes where partner_account_id = ${fixture.accountId})`,
    );
    await tx
      .delete(quotes)
      .where(eq(quotes.partnerAccountId, fixture.accountId));
    await tx
      .delete(salesOpportunities)
      .where(eq(salesOpportunities.contactId, fixture.contactId));
    await tx.execute(sql.raw("SET LOCAL session_replication_role = 'origin'"));
    await tx
      .delete(partnerJobChangeRequests)
      .where(eq(partnerJobChangeRequests.partnerAccountId, fixture.accountId));
    await tx.execute(
      sql`delete from outbox_events where payload->>'partnerAccountId' = ${fixture.accountId}`,
    );
    await tx
      .delete(partnerBookings)
      .where(eq(partnerBookings.id, fixture.bookingId));
    await tx
      .delete(appointments)
      .where(eq(appointments.id, fixture.appointmentId));
    await tx
      .delete(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    await tx
      .delete(partnerAccountServiceAgreements)
      .where(
        eq(partnerAccountServiceAgreements.partnerAccountId, fixture.accountId),
      );
    await tx
      .delete(partnerUsers)
      .where(eq(partnerUsers.id, fixture.partnerUserId));
    await tx.delete(properties).where(eq(properties.id, fixture.propertyId));
    await tx
      .update(contacts)
      .set({
        firstName: "Retained",
        lastName: "Job change fixture",
        company: null,
        email: null,
        phone: null,
        phoneE164: null,
        partnerAccountId: null,
        partnerStatus: "inactive",
        deletedAt: sql`statement_timestamp()`,
        purgeEligibleAt: sql`statement_timestamp() + interval '30 days'`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, fixture.contactId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.accountId));
    await tx
      .delete(teamMembers)
      .where(eq(teamMembers.id, fixture.teamMemberId));
  });
}

describeWithDatabase("Partner job change request PostgreSQL lifecycle", () => {
  jest.setTimeout(60_000);
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await deleteFixture(fixture);
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("serializes duplicate creation, safely replays the pair, and rejects cross-tenant access", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    fixtures.push(fixture, foreign);
    const etag = await currentJobEtag(fixture);
    const operationKeyHash = digest(`shared-operation:${fixture.bookingId}`);
    const requestHash = digest(`shared-request:${fixture.bookingId}`);
    const attempts = await Promise.all([
      createRequest(fixture, { operationKeyHash, requestHash, ifMatch: etag }),
      createRequest(fixture, { operationKeyHash, requestHash, ifMatch: etag }),
    ]);
    expect(new Set(attempts.map((result) => result.requestId)).size).toBe(1);
    expect(attempts.filter((result) => result.replayed)).toHaveLength(1);
    expect(attempts.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(attempts.map((result) => result.state))).toEqual(
      new Set(["pending"]),
    );
    expect(new Set(attempts.map((result) => result.requestRevision))).toEqual(
      new Set([1]),
    );
    expect(new Set(attempts.map((result) => result.bookingRevision)).size).toBe(
      1,
    );

    await expect(
      createRequest(fixture, {
        operationKeyHash,
        requestHash: digest("different-request"),
        ifMatch: etag,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    const crossTenantPrincipal: PartnerPrincipal = Object.freeze({
      ...foreign.principal,
      capabilities: ["jobs.change_request"],
    });
    await expect(
      getDb().transaction((tx) =>
        createPartnerJobChangeRequest(tx, {
          principal: crossTenantPrincipal,
          jobId: fixture.bookingId,
          payload: {
            reason: "Attempt to cross the account boundary.",
            proposedChanges: {
              description: "This must never be saved.",
              materiality: NO_MATERIAL_IMPACT,
            },
          },
          operationKeyHash: digest(`cross:${fixture.bookingId}`),
          requestHash: digest(`cross-request:${fixture.bookingId}`),
          ifMatch: etag,
          correlationId: `cross-${randomUUID()}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("enforces composite membership ownership, pending uniqueness, and immutable evidence", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    fixtures.push(fixture, foreign);

    let tenantError: DatabaseError = {};
    try {
      await getDb()
        .insert(partnerJobChangeRequests)
        .values({
          partnerAccountId: fixture.accountId,
          partnerBookingId: fixture.bookingId,
          requestedByMembershipId: foreign.membershipId,
          reason: "This foreign membership must be rejected by the database.",
          proposedChanges: {
            version: 1,
            description: "Invalid tenant association",
            materiality: NO_MATERIAL_IMPACT,
          },
          requestSnapshot: {
            version: 1,
            requestedAt: new Date().toISOString(),
            job: {
              publicStatus: "confirmed",
              appointmentStatus: "confirmed",
              bookingRevision: 2,
            },
            current: {
              description: null,
              crewInstructions: null,
              accessDetails: null,
              onSiteContact: null,
            },
            proposed: {
              description: "Invalid tenant association",
              materiality: NO_MATERIAL_IMPACT,
            },
          },
          baseBookingRevision: 2,
          operationKeyHash: digest(`foreign:${fixture.bookingId}`),
          requestHash: digest(`foreign-request:${fixture.bookingId}`),
        });
    } catch (error) {
      tenantError = deepestDatabaseError(error);
    }
    expect(tenantError.code).toBe("23503");
    expect(tenantError.constraint_name).toBe(
      "partner_job_change_requests_requester_account_fk",
    );

    const created = await createRequest(fixture, {
      ifMatch: await currentJobEtag(fixture),
    });

    let pendingError: DatabaseError = {};
    try {
      await getDb()
        .insert(partnerJobChangeRequests)
        .values({
          partnerAccountId: fixture.accountId,
          partnerBookingId: fixture.bookingId,
          requestedByMembershipId: fixture.membershipId,
          reason: "A second pending request must be rejected by the database.",
          proposedChanges: {
            version: 1,
            description: "Second pending change",
            materiality: NO_MATERIAL_IMPACT,
          },
          requestSnapshot: {
            version: 1,
            requestedAt: new Date().toISOString(),
            job: {
              publicStatus: "confirmed",
              appointmentStatus: "confirmed",
              bookingRevision: 2,
            },
            current: {
              description: null,
              crewInstructions: null,
              accessDetails: null,
              onSiteContact: null,
            },
            proposed: {
              description: "Second pending change",
              materiality: NO_MATERIAL_IMPACT,
            },
          },
          baseBookingRevision: 2,
          operationKeyHash: digest(`second:${fixture.bookingId}`),
          requestHash: digest(`second-request:${fixture.bookingId}`),
        });
    } catch (error) {
      pendingError = deepestDatabaseError(error);
    }
    expect(pendingError.code).toBe("23505");
    expect(pendingError.constraint_name).toBe(
      "partner_job_change_requests_pending_booking_key",
    );

    let immutableError: DatabaseError = {};
    try {
      await getDb()
        .update(partnerJobChangeRequests)
        .set({ reason: "Mutated evidence must never be accepted." })
        .where(eq(partnerJobChangeRequests.id, created.requestId));
    } catch (error) {
      immutableError = deepestDatabaseError(error);
    }
    expect(immutableError.code).toBe("23514");
    expect(String(immutableError.message)).toContain(
      "partner_job_change_request_evidence_immutable",
    );
  });

  it("allows one immutable Staff decision and applies only the requested safe field", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const request = await createRequest(fixture, {
      ifMatch: await currentJobEtag(fixture),
    });
    const decisions = await Promise.allSettled([
      getDb().transaction((tx) =>
        decidePartnerJobChangeRequestAsStaff(tx, {
          requestId: request.requestId,
          decision: "approved",
          reason: "The access-only change was verified and is safe to apply.",
          expectedVersion: "1",
          teamMemberId: fixture.teamMemberId,
          correlationId: `approve-${randomUUID()}`,
        }),
      ),
      getDb().transaction((tx) =>
        decidePartnerJobChangeRequestAsStaff(tx, {
          requestId: request.requestId,
          decision: "declined",
          reason: "A competing reviewer declined the same pending request.",
          expectedVersion: "1",
          teamMemberId: fixture.teamMemberId,
          correlationId: `decline-${randomUUID()}`,
        }),
      ),
    ]);
    expect(
      decisions.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      decisions.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const [requestRow] = await getDb()
      .select()
      .from(partnerJobChangeRequests)
      .where(eq(partnerJobChangeRequests.id, request.requestId));
    const [job] = await getDb()
      .select({ scope: partnerBookings.scopeSnapshot })
      .from(partnerBookings)
      .where(eq(partnerBookings.id, fixture.bookingId));
    expect(requestRow?.revision).toBe(2);
    expect(["approved", "declined"]).toContain(requestRow?.state);
    const scope = job?.scope ?? {};
    if (requestRow?.state === "approved") {
      expect(scope["accessDetails"]).toBe(
        "Use the rear loading entrance and call on arrival.",
      );
    } else {
      expect(scope["accessDetails"]).toBe("Check in at the front desk.");
    }
  });

  it("converges concurrent Quote V2 acceptance on one final price while operational changes stay pending", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const request = await createMaterialRequest(fixture);
    const quote = await createIssuedJobQuote(fixture);
    const offered = await getDb().transaction((tx) =>
      decidePartnerJobChangeRequestAsStaff(tx, {
        requestId: request.requestId,
        decision: "change_order_required",
        reason:
          "The material schedule request requires this exact issued fixed-price quote.",
        expectedVersion: "1",
        partnerQuoteId: quote.partnerQuoteId,
        teamMemberId: fixture.teamMemberId,
        correlationId: `change-order-offer-${randomUUID()}`,
      }),
    );
    expect(offered.changeOrder).toMatchObject({
      partnerQuoteId: quote.partnerQuoteId,
      amountMinor: 12_345,
      currency: "USD",
    });

    const responseId = randomUUID();
    const responseAt = new Date();
    const evidenceHash = "b".repeat(64);
    await getDb()
      .insert(quoteResponses)
      .values({
        id: responseId,
        quoteId: quote.quoteId,
        quoteVersionId: quote.versionId,
        responseType: "accepted",
        source: "system",
        signerSnapshot: { name: "PostgreSQL change-order signer" },
        configurationSnapshot: { selectedOptionIds: [] },
        selectedOptionIds: [],
        consentText: "I accept this change order.",
        consentVersion: "partner-change-order-pg-v1",
        consentAffirmed: true,
        configurationHash: evidenceHash,
        consentHash: evidenceHash,
        contentHash: "a".repeat(64),
        issuedPdfHash: "a".repeat(64),
        acceptedTotalMinCents: 12_345,
        acceptedTotalMaxCents: 12_345,
        acceptedDepositCents: 0,
        acceptedBalanceMinCents: 12_345,
        acceptedBalanceMaxCents: 12_345,
        requestMetadata: { test: "partner_change_order_concurrency" },
        respondedAt: responseAt,
        createdAt: responseAt,
      });
    const [appointmentBefore] = await getDb()
      .select({ startAt: appointments.startAt })
      .from(appointments)
      .where(eq(appointments.id, fixture.appointmentId));

    const resolve = () =>
      getDb().transaction(async (tx) => {
        await acquireScheduleConflictLock(tx);
        await acquirePartnerJobMutationLock(
          tx,
          fixture.accountId,
          fixture.bookingId,
        );
        return resolvePartnerJobChangeOrderFromQuoteResponse(tx, {
          partnerAccountId: fixture.accountId,
          partnerQuoteId: quote.partnerQuoteId,
          quoteId: quote.quoteId,
          quoteVersionId: quote.versionId,
          quoteResponseId: responseId,
          actorMembershipId: fixture.membershipId,
          decision: "accepted",
          acceptedAmountMinor: 12_345,
          currency: "USD",
          correlationId: `change-order-accept-${randomUUID()}`,
          now: responseAt,
        });
      });
    const resolutions = await Promise.all([resolve(), resolve()]);
    expect(resolutions.filter(Boolean)).toHaveLength(1);
    expect(resolutions.filter((result) => result === null)).toHaveLength(1);

    const [storedOrder, storedJob, storedAppointment, storedRequest] =
      await Promise.all([
        getDb()
          .select()
          .from(partnerJobChangeOrders)
          .where(
            eq(partnerJobChangeOrders.partnerQuoteId, quote.partnerQuoteId),
          )
          .then((rows) => rows[0]),
        getDb()
          .select({
            amountCents: partnerBookings.amountCents,
            currency: partnerBookings.currency,
            rateSnapshot: partnerBookings.rateSnapshot,
            scopeSnapshot: partnerBookings.scopeSnapshot,
            version: partnerBookings.version,
          })
          .from(partnerBookings)
          .where(eq(partnerBookings.id, fixture.bookingId))
          .then((rows) => rows[0]),
        getDb()
          .select({
            status: appointments.status,
            startAt: appointments.startAt,
          })
          .from(appointments)
          .where(eq(appointments.id, fixture.appointmentId))
          .then((rows) => rows[0]),
        getDb()
          .select({ state: partnerJobChangeRequests.state })
          .from(partnerJobChangeRequests)
          .where(eq(partnerJobChangeRequests.id, request.requestId))
          .then((rows) => rows[0]),
      ]);
    expect(storedOrder).toMatchObject({
      state: "accepted",
      quoteResponseId: responseId,
      revision: 2,
      resolutionSnapshot: {
        outcome: "accepted",
        appliedPublicFields: ["accessDetails"],
        operationalEffectsPending: ["schedule"],
      },
    });
    expect(storedJob).toMatchObject({
      amountCents: 12_345,
      currency: "USD",
      version: offered.bookingRevision + 1,
      rateSnapshot: {
        finalPriceSource: "accepted_change_order_quote_v2",
        partnerQuoteId: quote.partnerQuoteId,
        quoteId: quote.quoteId,
        quoteVersionId: quote.versionId,
      },
      scopeSnapshot: {
        accessDetails:
          "Use loading dock B and call the site contact on arrival.",
      },
    });
    expect(storedAppointment).toMatchObject({ status: "confirmed" });
    expect(storedAppointment?.startAt).toEqual(appointmentBefore?.startAt);
    expect(storedRequest?.state).toBe("change_order_required");
  });

  it("replays the actual resolved request and current job revision", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const created = await createRequest(fixture, {
      ifMatch: await currentJobEtag(fixture),
    });
    const decided = await getDb().transaction((tx) =>
      decidePartnerJobChangeRequestAsStaff(tx, {
        requestId: created.requestId,
        decision: "declined",
        reason: "The requested access change could not be verified safely.",
        expectedVersion: "1",
        teamMemberId: fixture.teamMemberId,
        correlationId: `decline-replay-${randomUUID()}`,
      }),
    );

    const replay = await createRequest(fixture);
    expect(replay).toMatchObject({
      requestId: created.requestId,
      state: "declined",
      requestRevision: 2,
      replayed: true,
      resolution: { outcome: "declined" },
    });
    expect(replay.resolution?.resolvedAt.toISOString()).toBe(
      decided.resolvedAt.toISOString(),
    );
    const [current] = await getDb()
      .select({
        version: partnerBookings.version,
        updatedAt: partnerBookings.updatedAt,
      })
      .from(partnerBookings)
      .where(eq(partnerBookings.id, fixture.bookingId));
    expect(replay.bookingRevision).toBe(current?.version);
    expect(replay.bookingUpdatedAt.toISOString()).toBe(
      current?.updatedAt.toISOString(),
    );
  });

  it("records truthful system supersession and replays it after direct cancellation", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const created = await createRequest(fixture, {
      ifMatch: await currentJobEtag(fixture),
    });
    const canceled = await cancelFixtureDirectly(fixture);
    expect(canceled.superseded?.requestId).toBe(created.requestId);

    const replay = await createRequest(fixture);
    expect(replay).toMatchObject({
      requestId: created.requestId,
      state: "superseded",
      requestRevision: 2,
      bookingRevision: canceled.bookingVersion,
      replayed: true,
      resolution: { outcome: "superseded" },
    });
    const [stored] = await getDb()
      .select()
      .from(partnerJobChangeRequests)
      .where(eq(partnerJobChangeRequests.id, created.requestId));
    expect(stored).toMatchObject({
      state: "superseded",
      revision: 2,
      resolvedByTeamMemberId: null,
      resolutionSnapshot: {
        version: 1,
        outcome: "superseded",
        actorType: "system",
        trigger: "partner_direct_cancellation",
        triggeringMembershipId: fixture.membershipId,
      },
    });
  });

  it("serializes direct cancellation against Staff resolution without stranding pending state", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const request = await createRequest(fixture, {
      ifMatch: await currentJobEtag(fixture),
    });
    const outcomes = await Promise.allSettled([
      cancelFixtureDirectly(fixture),
      getDb().transaction((tx) =>
        decidePartnerJobChangeRequestAsStaff(tx, {
          requestId: request.requestId,
          decision: "declined",
          reason:
            "The concurrent review could not validate the requested details.",
          expectedVersion: "1",
          teamMemberId: fixture.teamMemberId,
          correlationId: `cancel-race-decision-${randomUUID()}`,
        }),
      ),
    ]);
    expect(outcomes[0]?.status).toBe("fulfilled");

    const [storedRequest, storedBooking, storedAppointment] = await Promise.all(
      [
        getDb()
          .select()
          .from(partnerJobChangeRequests)
          .where(eq(partnerJobChangeRequests.id, request.requestId))
          .then((rows) => rows[0]),
        getDb()
          .select({ status: partnerBookings.publicStatus })
          .from(partnerBookings)
          .where(eq(partnerBookings.id, fixture.bookingId))
          .then((rows) => rows[0]),
        getDb()
          .select({ status: appointments.status })
          .from(appointments)
          .where(eq(appointments.id, fixture.appointmentId))
          .then((rows) => rows[0]),
      ],
    );
    expect(storedRequest?.state).toMatch(/^(declined|superseded)$/u);
    expect(storedRequest?.revision).toBe(2);
    expect(storedRequest?.resolvedAt).not.toBeNull();
    expect(storedBooking?.status).toBe("canceled");
    expect(storedAppointment?.status).toBe("canceled");

    const resolutionEvents = await getDb()
      .select({ type: partnerJobEvents.eventType })
      .from(partnerJobEvents)
      .where(
        and(
          eq(partnerJobEvents.partnerAccountId, fixture.accountId),
          eq(partnerJobEvents.partnerBookingId, fixture.bookingId),
          sql`${partnerJobEvents.eventType} in ('job.change_request_declined', 'job.change_request_superseded')`,
        ),
      );
    expect(resolutionEvents).toHaveLength(1);
  });

  it("allows Staff to decline a legacy pending request after the job became terminal", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const request = await createRequest(fixture, {
      ifMatch: await currentJobEtag(fixture),
    });
    await getDb().transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(appointments)
        .set({ status: "canceled", updatedAt: now })
        .where(eq(appointments.id, fixture.appointmentId));
      await tx
        .update(partnerBookings)
        .set({
          publicStatus: "canceled",
          canceledAt: now,
          version: request.bookingRevision + 1,
          updatedAt: now,
        })
        .where(eq(partnerBookings.id, fixture.bookingId));
    });

    const resolved = await getDb().transaction((tx) =>
      decidePartnerJobChangeRequestAsStaff(tx, {
        requestId: request.requestId,
        decision: "declined",
        reason:
          "The closed job requires an explicit non-actionable review outcome.",
        expectedVersion: "1",
        teamMemberId: fixture.teamMemberId,
        correlationId: `terminal-declined-${randomUUID()}`,
      }),
    );
    expect(resolved.state).toBe("declined");
    expect(resolved.publicStatus).toBe("canceled");
    expect(resolved.appliedFields).toEqual([]);
  });

  it("serializes direct reference edits and rejects stale and cross-account revisions", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    fixtures.push(fixture, foreign);
    const etag = await currentJobEtag(fixture);
    const updates = await Promise.allSettled([
      getDb().transaction((tx) =>
        updatePartnerJobReferences(tx, {
          principal: fixture.principal,
          jobId: fixture.bookingId,
          payload: { poNumber: "PO-100" },
          operationKeyHash: digest(`po-one:${fixture.bookingId}`),
          ifMatch: etag,
          correlationId: `po-one-${randomUUID()}`,
        }),
      ),
      getDb().transaction((tx) =>
        updatePartnerJobReferences(tx, {
          principal: fixture.principal,
          jobId: fixture.bookingId,
          payload: { costCenter: "COST-200" },
          operationKeyHash: digest(`po-two:${fixture.bookingId}`),
          ifMatch: etag,
          correlationId: `po-two-${randomUUID()}`,
        }),
      ),
    ]);
    expect(
      updates.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      updates.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejected = updates.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "revision_mismatch", status: 412 },
    });

    const currentEtag = await currentJobEtag(fixture);
    await expect(
      getDb().transaction((tx) =>
        updatePartnerJobReferences(tx, {
          principal: foreign.principal,
          jobId: fixture.bookingId,
          payload: { projectReference: "FOREIGN" },
          operationKeyHash: digest(`foreign-ref:${fixture.bookingId}`),
          ifMatch: currentEtag,
          correlationId: `foreign-ref-${randomUUID()}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });

    const records = await getDb()
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, fixture.bookingId));
    expect(
      records.filter((row) => row.action === "partner.job.references_updated"),
    ).toHaveLength(1);
  });
});
