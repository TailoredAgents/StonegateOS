import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  closeDbForTests,
  appointments,
  contacts,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  getDb,
  outboxEvents,
  partnerAccountMemberships,
  partnerAccounts,
  partnerBillingDisputeRequests,
  partnerBookings,
  partnerInvoices,
  partnerNotificationDeliveries,
  partnerNotifications,
  partnerUsers,
  properties,
  staffNotificationOperations,
  teamMembers,
  type PartnerBillingDisputeRequestSnapshot,
  type PartnerBillingDisputeResolutionSnapshot,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  createPartnerBillingDisputeRequest,
  decidePartnerBillingDisputeAsStaff,
  partnerInvoiceEtag,
  type PartnerBillingDisputeError,
} from "@/lib/partner-billing-dispute-requests";
import { processOutboxBatch } from "@/lib/outbox-processor";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const jest = import.meta.jest;
const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type Fixture = {
  accountId: string;
  invoiceId: string;
  membershipId: string;
  partnerUserId: string;
  teamMemberId: string;
  principal: PartnerPrincipal;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function expectDatabaseConstraint(
  operation: Promise<unknown>,
  constraint: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`expected_database_constraint:${constraint}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `expected_database_constraint:${constraint}`
    ) {
      throw error;
    }
    const cause =
      typeof error === "object" && error !== null && "cause" in error
        ? error.cause
        : null;
    expect(String(cause)).toContain(constraint);
  }
}

async function createFixture(label: string): Promise<Fixture> {
  const now = new Date();
  const accountId = randomUUID();
  const invoiceId = randomUUID();
  const membershipId = randomUUID();
  const partnerUserId = randomUUID();
  const teamMemberId = randomUUID();
  const suffix = accountId.replaceAll("-", "").slice(0, 12);
  const accountName = `${label} ${suffix}`;
  const email = `billing-${suffix}@example.test`;
  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({ id: teamMemberId, name: "Reviewer" });
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: accountName,
      normalizedName: accountName.toLowerCase(),
      status: "active_partner",
      portalAccessEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(partnerUsers).values({
      id: partnerUserId,
      email,
      normalizedEmail: email,
      name: "Billing Requester",
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
      roleKey: "billing_approver",
      status: "active",
      accessLevel: "account",
      acceptedAt: now,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(partnerInvoices).values({
      id: invoiceId,
      partnerAccountId: accountId,
      invoiceNumber: `INV-${suffix}`,
      status: "issued",
      currency: "USD",
      subtotalCents: 25_000,
      totalCents: 25_000,
      paidCents: 5_000,
      balanceCents: 20_000,
      billingContact: { name: "Billing Requester", email },
      issuedAt: now,
      version: 3,
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
    roleKey: "billing_approver",
    persona: "commercial_client" as const,
    accessLevel: "account" as const,
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    capabilities: Object.freeze([
      "invoices.read" as const,
      "invoices.disputes.request" as const,
    ]),
    isDefault: true,
    legacyOrgContactId: null,
    source: "membership" as const,
  });
  const principal: PartnerPrincipal = Object.freeze({
    type: "partner",
    partnerUserId,
    email,
    name: "Billing Requester",
    passwordSet: true,
    accountId,
    accountName,
    membershipId,
    roleKey: "billing_approver",
    persona: "commercial_client",
    accessLevel: "account",
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    legacyOrgContactId: null,
    capabilities: ["invoices.read", "invoices.disputes.request"],
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
    invoiceId,
    membershipId,
    partnerUserId,
    teamMemberId,
    principal,
  };
}

async function createRequest(
  fixture: Fixture,
  operation: string,
  reason = "Please review the amount shown on this issued invoice.",
  invoiceId = fixture.invoiceId,
) {
  const [invoice] = await getDb()
    .select()
    .from(partnerInvoices)
    .where(eq(partnerInvoices.id, invoiceId));
  if (!invoice) throw new Error("billing_dispute_invoice_fixture_missing");
  return getDb().transaction((tx) =>
    createPartnerBillingDisputeRequest(tx, {
      principal: fixture.principal,
      invoiceId,
      payload: {
        category: "invoice_amount",
        reason,
        evidence: {
          disputedAmountMinor: 2_500,
          reference: "AP-100",
          details: null,
        },
      },
      operationKeyHash: digest(operation),
      requestHash: digest(`${operation}:${reason}`),
      ifMatch: partnerInvoiceEtag({
        invoiceId: invoice.id,
        revision: invoice.version,
        updatedAt: invoice.updatedAt,
      }),
      correlationId: `billing-${randomUUID()}`,
    }),
  );
}

async function createFixtureBooking(
  tx: TeamMutationTransaction,
  fixture: Fixture,
): Promise<string> {
  const contactId = randomUUID();
  const propertyId = randomUUID();
  const appointmentId = randomUUID();
  const bookingId = randomUUID();
  const suffix = bookingId.slice(0, 8);
  await tx.insert(contacts).values({
    id: contactId,
    firstName: "Invoice",
    lastName: "Job",
    email: `invoice-job-${suffix}@example.test`,
  });
  await tx.insert(properties).values({
    id: propertyId,
    contactId,
    addressLine1: "100 Invoice Job Way",
    city: "Raleigh",
    state: "NC",
    postalCode: "27601",
  });
  await tx.insert(appointments).values({
    id: appointmentId,
    contactId,
    propertyId,
    status: "confirmed",
    rescheduleToken: digest(`reschedule:${bookingId}`),
    partnerAccountId: fixture.accountId,
  });
  await tx.insert(partnerBookings).values({
    id: bookingId,
    orgContactId: contactId,
    partnerAccountId: fixture.accountId,
    requestedByMembershipId: fixture.membershipId,
    partnerUserId: fixture.partnerUserId,
    propertyId,
    appointmentId,
    publicStatus: "confirmed",
  });
  return bookingId;
}

async function createFixtureFinancialThread(
  tx: TeamMutationTransaction,
  fixture: Fixture,
): Promise<string> {
  const [thread] = await tx
    .insert(conversationThreads)
    .values({
      partnerAccountId: fixture.accountId,
      partnerBookingId: null,
      staffScope: "partner_billing",
      portalVisible: true,
      status: "open",
      state: "review",
      channel: "web",
    })
    .returning({ id: conversationThreads.id });
  if (!thread) throw new Error("fixture_financial_thread_missing");
  return thread.id;
}

function fixtureRequestSnapshot(
  fixture: Fixture,
  bookingId: string | null,
): PartnerBillingDisputeRequestSnapshot {
  return {
    version: 1,
    requestedAt: new Date().toISOString(),
    invoice: {
      id: fixture.invoiceId,
      invoiceNumber: "INV-DB-BOUNDARY",
      version: 3,
      status: "issued",
      currency: "USD",
      totalMinor: 25_000,
      paidMinor: 5_000,
      balanceMinor: 20_000,
      bookingId,
    },
    evidence: {
      disputedAmountMinor: null,
      reference: null,
      details: null,
    },
    replayReceipt: {
      version: 1,
      status: 201,
      correlationId: `fixture-receipt:${fixture.invoiceId}`,
      etag: `"${createHash("sha256")
        .update(`fixture-receipt:${fixture.invoiceId}`)
        .digest("base64url")}"`,
      message: "Your billing request was received.",
    },
  };
}

async function insertFixtureDispute(
  tx: TeamMutationTransaction,
  fixture: Fixture,
  input: {
    threadId: string;
    bookingId: string | null;
    requestSnapshot?: PartnerBillingDisputeRequestSnapshot;
  },
): Promise<void> {
  const nonce = randomUUID();
  await tx.insert(partnerBillingDisputeRequests).values({
    partnerAccountId: fixture.accountId,
    partnerInvoiceId: fixture.invoiceId,
    partnerBookingId: input.bookingId,
    requestedByMembershipId: fixture.membershipId,
    conversationThreadId: input.threadId,
    threadScope: "account_billing",
    category: "invoice_amount",
    reason: "Please verify this database-bound invoice request.",
    requestSnapshot:
      input.requestSnapshot ?? fixtureRequestSnapshot(fixture, input.bookingId),
    operationKeyHash: digest(`operation:${nonce}`),
    requestHash: digest(`request:${nonce}`),
    state: "pending",
    revision: 1,
  });
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  await getDb().transaction(async (tx) => {
    const requests = await tx
      .select({
        id: partnerBillingDisputeRequests.id,
        threadId: partnerBillingDisputeRequests.conversationThreadId,
      })
      .from(partnerBillingDisputeRequests)
      .where(
        eq(partnerBillingDisputeRequests.partnerAccountId, fixture.accountId),
      );
    const requestIds = requests.map((request) => request.id);
    const operationIds =
      requestIds.length > 0
        ? await tx
            .select({ id: staffNotificationOperations.id })
            .from(staffNotificationOperations)
            .where(
              inArray(staffNotificationOperations.appointmentId, requestIds),
            )
        : [];
    const deliveryRows = await tx
      .select({
        outboxEventId: partnerNotificationDeliveries.outboxEventId,
      })
      .from(partnerNotificationDeliveries)
      .where(
        eq(partnerNotificationDeliveries.partnerAccountId, fixture.accountId),
      );
    await tx
      .delete(partnerNotificationDeliveries)
      .where(
        eq(partnerNotificationDeliveries.partnerAccountId, fixture.accountId),
      );
    const deliveryEventIds = deliveryRows
      .map((row) => row.outboxEventId)
      .filter((id): id is string => id !== null);
    if (deliveryEventIds.length > 0) {
      await tx
        .delete(outboxEvents)
        .where(inArray(outboxEvents.id, deliveryEventIds));
    }
    await tx
      .delete(partnerNotifications)
      .where(eq(partnerNotifications.partnerAccountId, fixture.accountId));
    await tx.execute(
      sql`delete from outbox_events where payload->>'partnerAccountId' = ${fixture.accountId}`,
    );
    for (const operation of operationIds) {
      await tx.execute(
        sql`delete from outbox_events where payload->>'operationId' = ${operation.id}`,
      );
    }
    if (operationIds.length > 0) {
      await tx.delete(staffNotificationOperations).where(
        inArray(
          staffNotificationOperations.id,
          operationIds.map((operation) => operation.id),
        ),
      );
    }
    await tx
      .delete(partnerBillingDisputeRequests)
      .where(
        eq(partnerBillingDisputeRequests.partnerAccountId, fixture.accountId),
      );
    for (const request of requests) {
      await tx
        .delete(conversationMessages)
        .where(eq(conversationMessages.threadId, request.threadId));
      await tx
        .delete(conversationParticipants)
        .where(eq(conversationParticipants.threadId, request.threadId));
      await tx
        .delete(conversationThreads)
        .where(eq(conversationThreads.id, request.threadId));
    }
    await tx
      .delete(partnerInvoices)
      .where(eq(partnerInvoices.partnerAccountId, fixture.accountId));
    await tx
      .delete(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    await tx
      .delete(partnerUsers)
      .where(eq(partnerUsers.id, fixture.partnerUserId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.accountId));
    await tx
      .delete(teamMembers)
      .where(eq(teamMembers.id, fixture.teamMemberId));
  });
}

describeWithDatabase("Partner billing-dispute PostgreSQL lifecycle", () => {
  jest.setTimeout(60_000);
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await deleteFixture(fixture);
  });
  afterAll(async () => closeDbForTests());

  it("replays one operation, prevents a second pending request, and isolates tenants", async () => {
    const fixture = await createFixture("Billing lifecycle");
    const foreign = await createFixture("Foreign billing lifecycle");
    fixtures.push(fixture, foreign);
    const [first, replay] = await Promise.all([
      createRequest(fixture, "same-operation"),
      createRequest(fixture, "same-operation"),
    ]);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(first.item.id).toBe(replay.item.id);
    expect(first.item.thread).toMatchObject({
      id: first.item.id,
      scope: "account_billing",
    });
    const [financialThread] = await getDb()
      .select({
        staffScope: conversationThreads.staffScope,
        bookingId: conversationThreads.partnerBookingId,
      })
      .from(conversationThreads)
      .where(eq(conversationThreads.id, first.item.thread.id));
    expect(financialThread).toEqual({
      staffScope: "partner_billing",
      bookingId: null,
    });
    expect(first.item.relatedJobId).toBeNull();
    await expect(
      createRequest(fixture, "other-operation"),
    ).rejects.toMatchObject({
      code: "billing_request_pending",
      status: 409,
    } satisfies Partial<PartnerBillingDisputeError>);
    const crossTenantPrincipal = {
      ...foreign.principal,
      accountId: fixture.accountId,
      membershipId: foreign.membershipId,
    };
    await expect(
      getDb().transaction((tx) =>
        createPartnerBillingDisputeRequest(tx, {
          principal: crossTenantPrincipal,
          invoiceId: fixture.invoiceId,
          payload: {
            category: "other",
            reason: "Attempting a cross-account invoice request should fail.",
            evidence: {
              disputedAmountMinor: null,
              reference: null,
              details: null,
            },
          },
          operationKeyHash: digest("foreign-operation"),
          requestHash: digest("foreign-request"),
          ifMatch: "invalid",
          correlationId: `foreign-${randomUUID()}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("serializes an account-wide idempotency key used concurrently across invoices", async () => {
    const fixture = await createFixture("Billing idempotency scope");
    fixtures.push(fixture);
    const secondInvoiceId = randomUUID();
    const now = new Date();
    await getDb()
      .insert(partnerInvoices)
      .values({
        id: secondInvoiceId,
        partnerAccountId: fixture.accountId,
        invoiceNumber: `INV-${secondInvoiceId.slice(0, 8)}`,
        status: "issued",
        currency: "USD",
        subtotalCents: 18_000,
        totalCents: 18_000,
        paidCents: 0,
        balanceCents: 18_000,
        billingContact: { name: "Billing Requester" },
        issuedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    const outcomes = await Promise.allSettled([
      createRequest(
        fixture,
        "cross-invoice-operation",
        "Please review the first invoice under this operation key.",
      ),
      createRequest(
        fixture,
        "cross-invoice-operation",
        "Please review the first invoice under this operation key.",
        secondInvoiceId,
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      code: "idempotency_conflict",
      status: 409,
    } satisfies Partial<PartnerBillingDisputeError>);
  });

  it("turns the opaque requested event into private account billing deliveries", async () => {
    const fixture = await createFixture("Billing notification");
    fixtures.push(fixture);
    const created = await createRequest(fixture, "notification-operation");
    const stats = await processOutboxBatch({
      limit: 1,
      eventTypes: ["partner.billing_dispute.requested"],
    });
    expect(stats.processed).toBe(1);
    const deliveries = await getDb()
      .select({
        eventType: partnerNotificationDeliveries.eventType,
        channel: partnerNotificationDeliveries.channel,
        bookingId: partnerNotificationDeliveries.partnerBookingId,
        title: partnerNotificationDeliveries.title,
        body: partnerNotificationDeliveries.body,
        actionPath: partnerNotificationDeliveries.actionPath,
      })
      .from(partnerNotificationDeliveries)
      .where(
        eq(partnerNotificationDeliveries.partnerAccountId, fixture.accountId),
      );
    expect(deliveries).toHaveLength(3);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "billing.dispute_requested",
          channel: "in_app",
          bookingId: null,
          actionPath: "/partners/billing",
        }),
        expect.objectContaining({
          eventType: "billing.dispute_requested",
          channel: "email",
          bookingId: null,
          actionPath: "/partners/billing",
        }),
        expect.objectContaining({
          eventType: "billing.dispute_requested",
          channel: "sms",
          bookingId: null,
          actionPath: "/partners/billing",
        }),
      ]),
    );
    for (const delivery of deliveries) {
      expect(`${delivery.title}\n${delivery.body}`).not.toContain(
        created.item.reason,
      );
      expect(delivery.body).not.toContain("AP-100");
    }
  });

  it("suppresses a delayed requested event after the dispute is resolved", async () => {
    const fixture = await createFixture("Stale billing notification");
    fixtures.push(fixture);
    const created = await createRequest(
      fixture,
      "stale-notification-operation",
    );
    await getDb().transaction((tx) =>
      decidePartnerBillingDisputeAsStaff(tx, {
        requestId: created.item.id,
        decision: "information_provided",
        reason: "The requested invoice detail is now available for review.",
        expectedVersion: "1",
        teamMemberId: fixture.teamMemberId,
        correlationId: `stale-notification-${randomUUID()}`,
      }),
    );

    const stats = await processOutboxBatch({
      limit: 1,
      eventTypes: ["partner.billing_dispute.requested"],
    });
    expect(stats).toEqual({ total: 1, processed: 0, skipped: 1, errors: 0 });
    const deliveries = await getDb()
      .select({ id: partnerNotificationDeliveries.id })
      .from(partnerNotificationDeliveries)
      .where(
        eq(partnerNotificationDeliveries.partnerAccountId, fixture.accountId),
      );
    expect(deliveries).toEqual([]);
  });

  it("rejects cross-account invoice and conversation bindings at the database boundary", async () => {
    const fixture = await createFixture("Billing binding owner");
    const foreign = await createFixture("Billing binding foreign");
    fixtures.push(fixture, foreign);
    const contactId = randomUUID();
    const propertyId = randomUUID();
    const appointmentId = randomUUID();
    const bookingId = randomUUID();
    const suffix = bookingId.slice(0, 8);
    await getDb().transaction(async (tx) => {
      await tx.insert(contacts).values({
        id: contactId,
        firstName: "Foreign",
        lastName: "Booking",
        email: `foreign-booking-${suffix}@example.test`,
      });
      await tx.insert(properties).values({
        id: propertyId,
        contactId,
        addressLine1: "100 Foreign Account Way",
        city: "Raleigh",
        state: "NC",
        postalCode: "27601",
      });
      await tx.insert(appointments).values({
        id: appointmentId,
        contactId,
        propertyId,
        status: "confirmed",
        rescheduleToken: digest(`reschedule:${bookingId}`),
        partnerAccountId: foreign.accountId,
      });
      await tx.insert(partnerBookings).values({
        id: bookingId,
        orgContactId: contactId,
        partnerAccountId: foreign.accountId,
        requestedByMembershipId: foreign.membershipId,
        partnerUserId: foreign.partnerUserId,
        propertyId,
        appointmentId,
        publicStatus: "confirmed",
      });
    });
    await expectDatabaseConstraint(
      getDb()
        .update(partnerInvoices)
        .set({ partnerBookingId: bookingId })
        .where(eq(partnerInvoices.id, fixture.invoiceId)),
      "partner_invoices_account_booking_fk",
    );
    await expectDatabaseConstraint(
      getDb().insert(conversationThreads).values({
        partnerAccountId: fixture.accountId,
        partnerBookingId: bookingId,
        portalVisible: true,
        status: "open",
        state: "review",
        channel: "web",
      }),
      "conversation_thread_account_booking_mismatch",
    );
    await getDb().transaction(async (tx) => {
      await tx.delete(partnerBookings).where(eq(partnerBookings.id, bookingId));
      await tx.delete(appointments).where(eq(appointments.id, appointmentId));
      await tx.delete(properties).where(eq(properties.id, propertyId));
    });
  });

  it("fully validates the legacy invoice-to-account-booking tenant constraint", async () => {
    const result = await getDb().execute(sql`
      SELECT catalog_constraint.convalidated
      FROM pg_constraint AS catalog_constraint
      WHERE catalog_constraint.conname = 'partner_invoices_account_booking_fk'
        AND catalog_constraint.conrelid = 'partner_invoices'::regclass
    `);
    expect(resultRows(result)).toEqual([{ convalidated: true }]);
  });

  it("rejects snapshots when required JSON keys are absent instead of accepting CHECK UNKNOWN", async () => {
    const fixture = await createFixture("Billing snapshot constraints");
    fixtures.push(fixture);
    await expectDatabaseConstraint(
      getDb().transaction(async (tx) => {
        const threadId = await createFixtureFinancialThread(tx, fixture);
        await insertFixtureDispute(tx, fixture, {
          threadId,
          bookingId: null,
          requestSnapshot:
            {} as unknown as PartnerBillingDisputeRequestSnapshot,
        });
      }),
      "partner_billing_disputes_snapshot_check",
    );
    await expectDatabaseConstraint(
      getDb().transaction(async (tx) => {
        const threadId = await createFixtureFinancialThread(tx, fixture);
        await insertFixtureDispute(tx, fixture, {
          threadId,
          bookingId: null,
          requestSnapshot: {
            ...fixtureRequestSnapshot(fixture, null),
            replayReceipt: {
              version: 1,
              status: 201,
              correlationId: "fixture-receipt-incomplete",
            },
          } as unknown as PartnerBillingDisputeRequestSnapshot,
        });
      }),
      "partner_billing_disputes_snapshot_check",
    );

    const created = await createRequest(fixture, "snapshot-resolution-keys");
    const now = new Date();
    const incompleteSnapshots = [
      {
        version: 1,
        outcome: "declined",
        resolvedAt: now.toISOString(),
        invoiceVersion: 3,
        invoiceStatus: "issued",
        providerActionPerformed: false,
      },
      {
        version: 1,
        outcome: "declined",
        resolvedAt: now.toISOString(),
        invoiceVersion: 3,
        invoiceStatus: "issued",
        monetaryMutationPerformed: false,
      },
    ];
    for (const snapshot of incompleteSnapshots) {
      await expectDatabaseConstraint(
        getDb()
          .update(partnerBillingDisputeRequests)
          .set({
            state: "declined",
            revision: 2,
            resolvedByTeamMemberId: fixture.teamMemberId,
            resolutionReason:
              "This deliberately incomplete classification must be rejected.",
            resolutionSnapshot:
              snapshot as unknown as PartnerBillingDisputeResolutionSnapshot,
            resolvedAt: now,
          })
          .where(eq(partnerBillingDisputeRequests.id, created.item.id)),
        "partner_billing_disputes_resolution_check",
      );
    }
  });

  it("rejects a same-account job thread and a different invoice job at dispute creation", async () => {
    const jobThreadFixture = await createFixture("Billing job-thread guard");
    const jobMismatchFixture = await createFixture("Billing invoice-job guard");
    fixtures.push(jobThreadFixture, jobMismatchFixture);

    await expectDatabaseConstraint(
      getDb().transaction(async (tx) => {
        const bookingId = await createFixtureBooking(tx, jobThreadFixture);
        await tx
          .update(partnerInvoices)
          .set({ partnerBookingId: bookingId })
          .where(eq(partnerInvoices.id, jobThreadFixture.invoiceId));
        const [jobThread] = await tx
          .insert(conversationThreads)
          .values({
            partnerAccountId: jobThreadFixture.accountId,
            partnerBookingId: bookingId,
            staffScope: "general",
            portalVisible: true,
            status: "open",
            state: "review",
            channel: "web",
          })
          .returning({ id: conversationThreads.id });
        if (!jobThread) throw new Error("fixture_job_thread_missing");
        await insertFixtureDispute(tx, jobThreadFixture, {
          threadId: jobThread.id,
          bookingId,
        });
      }),
      "partner_billing_dispute_thread_not_financial",
    );

    await expectDatabaseConstraint(
      getDb().transaction(async (tx) => {
        const differentBookingId = await createFixtureBooking(
          tx,
          jobMismatchFixture,
        );
        const threadId = await createFixtureFinancialThread(
          tx,
          jobMismatchFixture,
        );
        await insertFixtureDispute(tx, jobMismatchFixture, {
          threadId,
          bookingId: differentBookingId,
        });
      }),
      "partner_billing_dispute_invoice_booking_mismatch",
    );
  });

  it("prevents invoice and financial-thread rebinding after immutable dispute evidence exists", async () => {
    const fixture = await createFixture("Billing reverse binding guards");
    fixtures.push(fixture);
    const created = await createRequest(fixture, "reverse-binding-guards");

    await expectDatabaseConstraint(
      getDb().transaction(async (tx) => {
        const bookingId = await createFixtureBooking(tx, fixture);
        await tx
          .update(partnerInvoices)
          .set({ partnerBookingId: bookingId })
          .where(eq(partnerInvoices.id, fixture.invoiceId));
      }),
      "partner_invoice_has_billing_dispute_booking_conflict",
    );
    await expectDatabaseConstraint(
      getDb().transaction(async (tx) => {
        const bookingId = await createFixtureBooking(tx, fixture);
        await tx
          .update(conversationThreads)
          .set({ partnerBookingId: bookingId })
          .where(eq(conversationThreads.id, created.item.thread.id));
      }),
      "conversation_thread_has_billing_dispute_conflict",
    );
    await expectDatabaseConstraint(
      getDb()
        .update(conversationThreads)
        .set({ staffScope: "general" })
        .where(eq(conversationThreads.id, created.item.thread.id)),
      "conversation_thread_staff_scope_immutable",
    );
  });

  it("allows one immutable concurrent classification without changing invoice money/provider state", async () => {
    const fixture = await createFixture("Billing decision");
    fixtures.push(fixture);
    const created = await createRequest(fixture, "decision-operation");
    const before = await getDb()
      .select()
      .from(partnerInvoices)
      .where(eq(partnerInvoices.id, fixture.invoiceId))
      .then((rows) => rows[0]);
    const outcomes = await Promise.allSettled([
      getDb().transaction((tx) =>
        decidePartnerBillingDisputeAsStaff(tx, {
          requestId: created.item.id,
          decision: "refund_review",
          reason: "Escalate for a separate controlled refund review workflow.",
          expectedVersion: "1",
          teamMemberId: fixture.teamMemberId,
          correlationId: `refund-review-${randomUUID()}`,
        }),
      ),
      getDb().transaction((tx) =>
        decidePartnerBillingDisputeAsStaff(tx, {
          requestId: created.item.id,
          decision: "declined",
          reason: "The issued invoice agrees with the accepted service record.",
          expectedVersion: "1",
          teamMemberId: fixture.teamMemberId,
          correlationId: `decline-${randomUUID()}`,
        }),
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const [stored, after] = await Promise.all([
      getDb()
        .select()
        .from(partnerBillingDisputeRequests)
        .where(eq(partnerBillingDisputeRequests.id, created.item.id))
        .then((rows) => rows[0]),
      getDb()
        .select()
        .from(partnerInvoices)
        .where(eq(partnerInvoices.id, fixture.invoiceId))
        .then((rows) => rows[0]),
    ]);
    expect(stored?.revision).toBe(2);
    expect(["refund_review", "declined"]).toContain(stored?.state);
    expect(after).toMatchObject({
      status: before?.status,
      subtotalCents: before?.subtotalCents,
      totalCents: before?.totalCents,
      paidCents: before?.paidCents,
      balanceCents: before?.balanceCents,
      provider: before?.provider,
      providerInvoiceId: before?.providerInvoiceId,
      providerOrderId: before?.providerOrderId,
      version: before?.version,
    });
    await expect(
      getDb().transaction((tx) =>
        decidePartnerBillingDisputeAsStaff(tx, {
          requestId: created.item.id,
          decision: "information_provided",
          reason: "A terminal classification must remain immutable forever.",
          expectedVersion: "2",
          teamMemberId: fixture.teamMemberId,
          correlationId: `rewrite-${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow("already resolved");
    const outbox = await getDb()
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "partner.billing_dispute.resolved"));
    expect(
      outbox.some(
        (item) => item.payload["billingDisputeRequestId"] === created.item.id,
      ),
    ).toBe(true);
    expect(
      outbox.some(
        (item) => "reason" in item.payload || "evidence" in item.payload,
      ),
    ).toBe(false);
  });

  it("waits for a concurrent invoice update and snapshots the locked current revision", async () => {
    const fixture = await createFixture("Billing invoice snapshot race");
    fixtures.push(fixture);
    const created = await createRequest(fixture, "invoice-snapshot-race");
    let announceLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      announceLocked = resolve;
    });
    let releaseInvoice: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseInvoice = resolve;
    });
    const invoiceMutation = getDb().transaction(async (tx) => {
      await tx
        .select({ id: partnerInvoices.id })
        .from(partnerInvoices)
        .where(eq(partnerInvoices.id, fixture.invoiceId))
        .for("update");
      announceLocked?.();
      await release;
      await tx
        .update(partnerInvoices)
        .set({ status: "overdue", version: 4, updatedAt: new Date() })
        .where(eq(partnerInvoices.id, fixture.invoiceId));
    });
    await locked;
    const decision = getDb().transaction((tx) =>
      decidePartnerBillingDisputeAsStaff(tx, {
        requestId: created.item.id,
        decision: "information_provided",
        reason: "The current invoice record now contains the requested detail.",
        expectedVersion: "1",
        teamMemberId: fixture.teamMemberId,
        correlationId: `invoice-race-${randomUUID()}`,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    releaseInvoice?.();
    await invoiceMutation;
    await decision;
    const [stored] = await getDb()
      .select({
        snapshot: partnerBillingDisputeRequests.resolutionSnapshot,
      })
      .from(partnerBillingDisputeRequests)
      .where(eq(partnerBillingDisputeRequests.id, created.item.id));
    expect(stored?.snapshot).toMatchObject({
      invoiceVersion: 4,
      invoiceStatus: "overdue",
      monetaryMutationPerformed: false,
      providerActionPerformed: false,
    });
  });
});
