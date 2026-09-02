import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  appointments,
  closeDbForTests,
  contacts,
  getDb,
  outboxEvents,
  partnerAccountMemberships,
  partnerAccounts,
  partnerBookings,
  partnerCancellationRequests,
  partnerJobChangeRequests,
  partnerJobEvents,
  partnerNotifications,
  partnerUsers,
  properties,
  teamMembers,
} from "@/db";
import {
  createPartnerCancellationRequestSnapshot,
  decidePartnerCancellationRequestAsStaff,
} from "@/lib/partner-cancellation-request-lifecycle";

const jest = import.meta.jest;
const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type Fixture = Readonly<{
  accountId: string;
  bookingId: string;
  appointmentId: string;
  membershipId: string;
  partnerUserId: string;
  contactId: string;
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
  const accountId = randomUUID();
  const bookingId = randomUUID();
  const appointmentId = randomUUID();
  const membershipId = randomUUID();
  const partnerUserId = randomUUID();
  const contactId = randomUUID();
  const propertyId = randomUUID();
  const teamMemberId = randomUUID();
  const suffix = accountId.replaceAll("-", "").slice(0, 12);
  const now = new Date();
  const serviceAt = new Date(now.getTime() + 2 * 60 * 60_000);
  const arrivalEndAt = new Date(serviceAt.getTime() + 2 * 60 * 60_000);

  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({
      id: teamMemberId,
      name: `Cancellation reviewer ${suffix}`,
    });
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: `Cancellation lifecycle ${suffix}`,
      normalizedName: `cancellation lifecycle ${suffix}`,
      status: "active_partner",
      portalAccessEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Cancellation",
      lastName: "Lifecycle",
      company: `Cancellation lifecycle ${suffix}`,
      partnerAccountId: accountId,
      partnerStatus: "partner",
      source: "partner_cancellation_lifecycle_integration",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressKey: `partner-cancellation-lifecycle:${suffix}`,
      addressLine1: "1 Cancellation Test Way",
      city: "Baltimore",
      state: "MD",
      postalCode: "21201",
      createdAt: now,
      updatedAt: now,
    });
    const email = `cancellation-${suffix}@example.test`;
    await tx.insert(partnerUsers).values({
      id: partnerUserId,
      email,
      normalizedEmail: email,
      name: "Cancellation Requester",
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
      roleKey: "operations",
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
      promisedArrivalEndAt: arrivalEndAt,
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
      arrivalWindowEndAt: arrivalEndAt,
      requestedReviewReasons: ["cancellation_review_requested"],
      cancelOperationKeyHash: digest(`operation:${bookingId}`),
      cancelRequestHash: digest(`request:${bookingId}`),
      version: 2,
      createdAt: now,
      updatedAt: now,
    });
  });
  return {
    accountId,
    bookingId,
    appointmentId,
    membershipId,
    partnerUserId,
    contactId,
    propertyId,
    teamMemberId,
  };
}

async function createRequest(
  fixture: Fixture,
  suffix = "primary",
  requestedByMembershipId = fixture.membershipId,
) {
  const now = new Date();
  const [booking] = await getDb()
    .select({
      publicStatus: partnerBookings.publicStatus,
      version: partnerBookings.version,
      startAt: partnerBookings.arrivalWindowStartAt,
      endAt: partnerBookings.arrivalWindowEndAt,
      appointmentStatus: appointments.status,
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(eq(partnerBookings.id, fixture.bookingId));
  if (!booking) throw new Error("cancellation_lifecycle_booking_missing");
  const [request] = await getDb()
    .insert(partnerCancellationRequests)
    .values({
      partnerAccountId: fixture.accountId,
      partnerBookingId: fixture.bookingId,
      requestedByMembershipId,
      reason: "The site no longer requires this scheduled service.",
      requestSnapshot: createPartnerCancellationRequestSnapshot({
        requestedAt: now,
        publicStatus: booking.publicStatus,
        appointmentStatus: booking.appointmentStatus,
        bookingVersion: booking.version,
        promisedArrivalStartAt: booking.startAt,
        promisedArrivalEndAt: booking.endAt,
        timezone: "America/New_York",
        cutoffMinutes: 1_440,
        directCancellationEnabled: true,
        policySource: "configured",
        policyRevision: 1,
        deadlineAt: now.toISOString(),
        decisionReasonCode: "cutoff_elapsed",
      }),
      operationKeyHash: digest(`operation:${fixture.bookingId}:${suffix}`),
      requestHash: digest(`request:${fixture.bookingId}:${suffix}`),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!request) throw new Error("cancellation_lifecycle_request_missing");
  return request;
}

async function createPendingJobChangeRequest(fixture: Fixture) {
  const now = new Date();
  const [request] = await getDb()
    .insert(partnerJobChangeRequests)
    .values({
      partnerAccountId: fixture.accountId,
      partnerBookingId: fixture.bookingId,
      requestedByMembershipId: fixture.membershipId,
      reason: "Use the rear loading entrance if the service remains scheduled.",
      proposedChanges: {
        version: 1,
        accessDetails: "Use the rear loading entrance.",
        materiality: {
          price: false,
          schedule: false,
          service: false,
          quantity: false,
          hazards: false,
          proof: false,
        },
      },
      requestSnapshot: {
        version: 1,
        requestedAt: now.toISOString(),
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
          accessDetails: "Use the rear loading entrance.",
          materiality: {
            price: false,
            schedule: false,
            service: false,
            quantity: false,
            hazards: false,
            proof: false,
          },
        },
      },
      baseBookingRevision: 2,
      operationKeyHash: digest(`job-change-operation:${fixture.bookingId}`),
      requestHash: digest(`job-change-request:${fixture.bookingId}`),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!request) throw new Error("pending_job_change_fixture_missing");
  return request;
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
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
      .delete(partnerCancellationRequests)
      .where(
        eq(partnerCancellationRequests.partnerAccountId, fixture.accountId),
      );
    await tx
      .delete(partnerJobChangeRequests)
      .where(eq(partnerJobChangeRequests.partnerAccountId, fixture.accountId));
    await tx.execute(
      sql`delete from outbox_events where payload->>'partnerAccountId' = ${fixture.accountId} or payload->>'appointmentId' = ${fixture.appointmentId}`,
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
      .delete(partnerUsers)
      .where(eq(partnerUsers.id, fixture.partnerUserId));
    await tx.delete(properties).where(eq(properties.id, fixture.propertyId));
    await tx
      .update(contacts)
      .set({
        firstName: "Retained",
        lastName: "Cancellation fixture",
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

describeWithDatabase(
  "Partner cancellation request PostgreSQL lifecycle",
  () => {
    jest.setTimeout(60_000);
    const fixtures: Fixture[] = [];

    afterEach(async () => {
      const pending = fixtures.splice(0);
      for (const fixture of pending) await deleteFixture(fixture);
    });

    afterAll(async () => {
      await closeDbForTests();
    });

    it("enforces paired idempotency, one pending request per job, and immutable evidence", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const foreignAccountId = randomUUID();
      const foreignUserId = randomUUID();
      const foreignMembershipId = randomUUID();
      const foreignEmail = `foreign-${foreignUserId}@example.test`;
      await getDb().transaction(async (tx) => {
        await tx.insert(partnerAccounts).values({
          id: foreignAccountId,
          name: `Foreign cancellation account ${foreignAccountId.slice(0, 8)}`,
          normalizedName: `foreign cancellation account ${foreignAccountId.slice(0, 8)}`,
        });
        await tx.insert(partnerUsers).values({
          id: foreignUserId,
          email: foreignEmail,
          normalizedEmail: foreignEmail,
          name: "Foreign requester",
          active: true,
          identityStatus: "active",
          emailVerifiedAt: new Date(),
        });
        await tx.insert(partnerAccountMemberships).values({
          id: foreignMembershipId,
          partnerAccountId: foreignAccountId,
          partnerUserId: foreignUserId,
          roleKey: "operations",
          status: "active",
          accessLevel: "account",
          acceptedAt: new Date(),
        });
      });
      let tenantError: DatabaseError = {};
      try {
        await createRequest(fixture, "foreign-member", foreignMembershipId);
      } catch (error) {
        tenantError = deepestDatabaseError(error);
      }
      expect(tenantError.code).toBe("23503");
      expect(tenantError.constraint_name).toBe(
        "partner_cancellation_requests_requester_account_fk",
      );
      await getDb().transaction(async (tx) => {
        await tx
          .delete(partnerAccountMemberships)
          .where(eq(partnerAccountMemberships.id, foreignMembershipId));
        await tx.delete(partnerUsers).where(eq(partnerUsers.id, foreignUserId));
        await tx
          .delete(partnerAccounts)
          .where(eq(partnerAccounts.id, foreignAccountId));
      });
      const request = await createRequest(fixture);

      let pendingError: DatabaseError = {};
      try {
        await createRequest(fixture, "second");
      } catch (error) {
        pendingError = deepestDatabaseError(error);
      }
      expect(pendingError.code).toBe("23505");
      expect(pendingError.constraint_name).toBe(
        "partner_cancellation_requests_pending_booking_key",
      );

      let immutableError: DatabaseError = {};
      try {
        await getDb()
          .update(partnerCancellationRequests)
          .set({ reason: "A changed request reason is not permitted." })
          .where(eq(partnerCancellationRequests.id, request.id));
      } catch (error) {
        immutableError = deepestDatabaseError(error);
      }
      expect(immutableError.code).toBe("23514");
      expect(String(immutableError.message)).toContain(
        "partner_cancellation_request_evidence_immutable",
      );
    });

    it("allows exactly one concurrent Staff decision and keeps it irreversible", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const request = await createRequest(fixture);
      const db = getDb();
      const decisions = await Promise.allSettled([
        db.transaction((tx) =>
          decidePartnerCancellationRequestAsStaff(tx, {
            requestId: request.id,
            decision: "approved",
            reason: "Verified with the Partner and approved for cancellation.",
            expectedVersion: "1",
            teamMemberId: fixture.teamMemberId,
            correlationId: `cancel-approve-${randomUUID()}`,
          }),
        ),
        db.transaction((tx) =>
          decidePartnerCancellationRequestAsStaff(tx, {
            requestId: request.id,
            decision: "declined",
            reason:
              "The assigned crew is already committed, so retain service.",
            expectedVersion: "1",
            teamMemberId: fixture.teamMemberId,
            correlationId: `cancel-decline-${randomUUID()}`,
          }),
        ),
      ]);
      expect(
        decisions.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        decisions.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);

      const [storedRequest, storedBooking, storedAppointment] =
        await Promise.all([
          db
            .select()
            .from(partnerCancellationRequests)
            .where(eq(partnerCancellationRequests.id, request.id))
            .then((rows) => rows[0]),
          db
            .select()
            .from(partnerBookings)
            .where(eq(partnerBookings.id, fixture.bookingId))
            .then((rows) => rows[0]),
          db
            .select()
            .from(appointments)
            .where(eq(appointments.id, fixture.appointmentId))
            .then((rows) => rows[0]),
        ]);
      expect(storedRequest).toMatchObject({ revision: 2 });
      expect(["approved", "declined"]).toContain(storedRequest?.state);
      if (storedRequest?.state === "approved") {
        expect([
          storedBooking?.publicStatus,
          storedAppointment?.status,
        ]).toEqual(["canceled", "canceled"]);
      } else {
        expect([
          storedBooking?.publicStatus,
          storedAppointment?.status,
        ]).toEqual(["confirmed", "confirmed"]);
        expect(storedBooking?.cancelOperationKeyHash).toBeNull();
        expect(storedBooking?.cancelRequestHash).toBeNull();
      }

      await expect(
        db.transaction((tx) =>
          decidePartnerCancellationRequestAsStaff(tx, {
            requestId: request.id,
            decision:
              storedRequest?.state === "approved" ? "declined" : "approved",
            reason: "A later attempt must never rewrite the recorded decision.",
            expectedVersion: "2",
            teamMemberId: fixture.teamMemberId,
            correlationId: `cancel-rewrite-${randomUUID()}`,
          }),
        ),
      ).rejects.toThrow("already resolved");
      const publicEvents = await db
        .select({ type: partnerJobEvents.eventType })
        .from(partnerJobEvents)
        .where(
          and(
            eq(partnerJobEvents.partnerAccountId, fixture.accountId),
            eq(partnerJobEvents.partnerBookingId, fixture.bookingId),
          ),
        );
      expect(publicEvents).toHaveLength(1);
      expect(publicEvents[0]?.type).toBe(
        storedRequest?.state === "approved"
          ? "job.cancellation_request_approved"
          : "job.cancellation_request_declined",
      );
      const resolutionOutbox = await db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "partner.cancellation_request.resolved"),
            sql`${outboxEvents.payload}->>'cancellationRequestId' = ${request.id}`,
          ),
        );
      expect(resolutionOutbox).toHaveLength(1);
    });

    it("atomically supersedes a pending job change when Staff approves cancellation", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const [cancellationRequest, changeRequest] = await Promise.all([
        createRequest(fixture),
        createPendingJobChangeRequest(fixture),
      ]);
      const result = await getDb().transaction((tx) =>
        decidePartnerCancellationRequestAsStaff(tx, {
          requestId: cancellationRequest.id,
          decision: "approved",
          reason: "Verified with the Partner and approved for cancellation.",
          expectedVersion: "1",
          teamMemberId: fixture.teamMemberId,
          correlationId: `cancel-with-change-${randomUUID()}`,
        }),
      );
      expect(result.supersededChangeRequestId).toBe(changeRequest.id);

      const [stored] = await getDb()
        .select()
        .from(partnerJobChangeRequests)
        .where(eq(partnerJobChangeRequests.id, changeRequest.id));
      expect(stored).toMatchObject({
        state: "superseded",
        revision: 2,
        resolvedByTeamMemberId: fixture.teamMemberId,
        resolutionSnapshot: {
          version: 1,
          outcome: "superseded",
          actorType: "staff",
          trigger: "staff_approved_cancellation",
          bookingRevisionBefore: 2,
          bookingRevisionAfter: 3,
        },
      });
      expect(stored?.resolvedAt).not.toBeNull();
    });
  },
);
