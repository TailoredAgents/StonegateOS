import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  appointmentHolds,
  appointments,
  auditLogs,
  closeDbForTests,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerCancellationRequests,
  partnerRecurringOccurrences,
  partnerRecurringSeries,
  partnerUsers,
  teamMutationIdempotency,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import { evaluateDuePartnerRecurringOccurrences } from "@/lib/partner-recurring-horizon-scheduler";
import {
  mutatePartnerRecurringSeriesLifecycle,
  type RecurringSeriesLifecycleAction,
} from "@/lib/partner-repeat-work";
import {
  PartnerPortalSchedulingError,
  type PartnerSchedulingActor,
} from "@/lib/partner-portal-v2-scheduling";
import { createPortalV2StrongEtag } from "@/lib/portal-v2-contract";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;
const NOW = new Date("2035-06-01T12:00:00.000Z");
const NEAR_DATE = "2035-06-02";
const OUTSIDE_HORIZON_DATE = "2035-08-15";
const RECEIPT_ACTION = "partner.portal.v2.recurring_series.lifecycle";
const AUDIT_ACTION = "partner.portal.v2.recurring_series.lifecycle_changed";
const ENVIRONMENT_KEYS = [
  "PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED",
  "PARTNER_PORTAL_V2_READS_ENABLED",
  "PARTNER_PORTAL_V2_WRITES_ENABLED",
  "PARTNER_PORTAL_INTERNAL_TEST_MODE",
  "PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS",
] as const;

type OccurrenceSeed = Readonly<{
  localDate: string;
  state?: "tentative" | "evaluating";
  failureCode?: string | null;
  evaluatedAt?: Date | null;
  evaluation?: Record<string, unknown>;
}>;

type Fixture = Readonly<{
  accountId: string;
  userId: string;
  membershipId: string;
  seriesId: string;
  occurrenceIds: readonly string[];
  actor: PartnerSchedulingActor;
  principal: PartnerPrincipal;
  principalHash: string;
}>;

const fixtures: Fixture[] = [];
const originalEnvironment = new Map<string, string | undefined>();

function sha256WithNullSeparators(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\u0000", "utf8");
  return hash.digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function etag(seriesId: string, revision: number): string {
  return createPortalV2StrongEtag(
    `partner-recurring-series:${seriesId}:${revision}`,
  );
}

function lifecycleError(error: unknown): PartnerPortalSchedulingError {
  expect(error).toBeInstanceOf(PartnerPortalSchedulingError);
  return error as PartnerPortalSchedulingError;
}

async function createFixture(
  occurrences: readonly OccurrenceSeed[] = [
    { localDate: NEAR_DATE },
    { localDate: OUTSIDE_HORIZON_DATE },
  ],
): Promise<Fixture> {
  const accountId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const seriesId = randomUUID();
  const occurrenceIds = occurrences.map(() => randomUUID());
  const email = `recurring-lifecycle-${userId}@example.test`;
  const actor: PartnerSchedulingActor = Object.freeze({
    accountId,
    membershipId,
    partnerUserId: userId,
    email,
    sessionId: randomUUID(),
    accessLevel: "account",
    canReadRates: false,
    locationIds: Object.freeze([]),
    propertyIds: Object.freeze([]),
  });
  const accountAccess = Object.freeze({
    accountId,
    accountName: `Recurring lifecycle ${accountId.slice(0, 8)}`,
    accountStatus: "active_partner",
    membershipId,
    membershipStatus: "active" as const,
    roleKey: "operations",
    persona: "commercial_client" as const,
    accessLevel: "account" as const,
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    capabilities: Object.freeze([
      "bookings.read" as const,
      "bookings.update" as const,
    ]),
    isDefault: true,
    legacyOrgContactId: null,
    source: "membership" as const,
  });
  const principal: PartnerPrincipal = Object.freeze({
    type: "partner",
    partnerUserId: userId,
    email,
    name: "Recurring lifecycle partner",
    passwordSet: true,
    accountId,
    accountName: accountAccess.accountName,
    membershipId,
    roleKey: "operations",
    persona: "commercial_client",
    accessLevel: "account",
    accessScope: Object.freeze({}),
    preferences: Object.freeze({}),
    legacyOrgContactId: null,
    capabilities: ["bookings.read", "bookings.update"],
    accessSource: "membership",
    session: Object.freeze({
      id: actor.sessionId!,
      authMethod: "password",
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
      deviceName: "PostgreSQL integration",
      createdAt: NOW,
      lastSeenAt: NOW,
      expiresAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1_000),
    }),
    security: Object.freeze({
      mfaRequired: false,
      mfaEnrolled: false,
      mfaSatisfied: true,
    }),
    availableAccounts: [accountAccess],
  });

  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: accountAccess.accountName,
      normalizedName: accountAccess.accountName.toLowerCase(),
      status: "active_partner",
      segment: "commercial_client",
      portalAccessEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email,
      normalizedEmail: email,
      name: principal.name,
      active: true,
      identityStatus: "active",
      emailVerifiedAt: NOW,
      passwordHash: "postgres-integration-password-hash",
      passwordHashVersion: 2,
      passwordSetAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "operations",
      status: "active",
      persona: "commercial_client",
      accessLevel: "account",
      isDefault: true,
      acceptedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await tx.insert(partnerRecurringSeries).values({
      id: seriesId,
      partnerAccountId: accountId,
      templateId: null,
      name: "PostgreSQL lifecycle race",
      recurrenceRule: JSON.stringify({
        frequency: "monthly",
        occurrenceCount: occurrences.length,
      }),
      timezone: "America/New_York",
      startsOn: occurrences[0]?.localDate ?? NEAR_DATE,
      endsOn:
        occurrences.at(-1)?.localDate ?? occurrences[0]?.localDate ?? NEAR_DATE,
      state: "active",
      revision: 1,
      createdByMembershipId: membershipId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await tx.insert(partnerRecurringOccurrences).values(
      occurrences.map((occurrence, index) => ({
        id: occurrenceIds[index]!,
        partnerAccountId: accountId,
        recurringSeriesId: seriesId,
        localDate: occurrence.localDate,
        state: occurrence.state ?? "tentative",
        failureCode: occurrence.failureCode ?? null,
        evaluation: occurrence.evaluation ?? { reservationCreated: false },
        evaluatedAt: occurrence.evaluatedAt ?? null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
  });

  const fixture = Object.freeze({
    accountId,
    userId,
    membershipId,
    seriesId,
    occurrenceIds: Object.freeze(occurrenceIds),
    actor,
    principal,
    principalHash: sha256WithNullSeparators(
      "partner-portal-v2-recurring-lifecycle",
      userId,
    ),
  });
  fixtures.push(fixture);
  return fixture;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(teamMutationIdempotency)
      .where(eq(teamMutationIdempotency.principalHash, fixture.principalHash));
    await tx
      .delete(partnerRecurringSeries)
      .where(eq(partnerRecurringSeries.id, fixture.seriesId));
    await tx
      .delete(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, fixture.membershipId));
    await tx.delete(partnerUsers).where(eq(partnerUsers.id, fixture.userId));
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, fixture.accountId));
  });
}

async function lifecycleMutation(input: {
  fixture: Fixture;
  action: RecurringSeriesLifecycleAction;
  key: string;
  ifMatch?: string;
  reason?: string;
}) {
  return mutatePartnerRecurringSeriesLifecycle({
    actor: input.fixture.actor,
    principal: input.fixture.principal,
    seriesId: input.fixture.seriesId,
    mutation: {
      action: input.action,
      reason: input.reason ?? `${input.action} integration reason`,
    },
    idempotencyKeyHash: digest(input.key),
    ifMatch: input.ifMatch ?? etag(input.fixture.seriesId, 1),
    correlationId: `partner-recurring-postgres:${input.key}`,
    now: NOW,
  });
}

async function lifecycleEvidence(fixture: Fixture): Promise<{
  receiptCount: number;
  auditCount: number;
}> {
  const [receipts, audits] = await Promise.all([
    getDb()
      .select({ id: teamMutationIdempotency.id })
      .from(teamMutationIdempotency)
      .where(
        and(
          eq(teamMutationIdempotency.principalHash, fixture.principalHash),
          eq(teamMutationIdempotency.action, RECEIPT_ACTION),
        ),
      ),
    getDb()
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AUDIT_ACTION),
          eq(auditLogs.entityType, "partner_recurring_series"),
          eq(auditLogs.entityId, fixture.seriesId),
        ),
      ),
  ]);
  return { receiptCount: receipts.length, auditCount: audits.length };
}

describeWithDatabase(
  "Partner recurring-series lifecycle PostgreSQL concurrency",
  () => {
    beforeAll(async () => {
      for (const key of ENVIRONMENT_KEYS) {
        originalEnvironment.set(key, process.env[key]);
      }
      process.env["PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED"] = "1";
      process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = "1";
      process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "1";
      process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"] = "1";
      // A successful relation query makes migration 0149+ an executable test
      // precondition instead of an undocumented assumption.
      await getDb()
        .select({ id: partnerCancellationRequests.id })
        .from(partnerCancellationRequests)
        .limit(1);
    });

    afterEach(async () => {
      const pending = fixtures.splice(0);
      for (const fixture of pending) await cleanupFixture(fixture);
      process.env["PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS"] = "";
    });

    afterAll(async () => {
      for (const key of ENVIRONMENT_KEYS) {
        const value = originalEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeDbForTests();
    });

    it("replays one terminal post-state for simultaneous identical keys", async () => {
      const fixture = await createFixture();
      const [first, second] = await Promise.all([
        lifecycleMutation({ fixture, action: "pause", key: "same-key" }),
        lifecycleMutation({ fixture, action: "pause", key: "same-key" }),
      ]);

      expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      expect(second.series).toEqual(first.series);
      expect(second.transition).toEqual(first.transition);
      expect(first.series.revision).toBe(2);
      expect(first.series.state).toBe("paused");
      expect(
        first.series.occurrences.every(
          (occurrence) => occurrence.state === "skipped",
        ),
      ).toBe(true);
      expect(await lifecycleEvidence(fixture)).toEqual({
        receiptCount: 1,
        auditCount: 1,
      });
    });

    it("lets one different-key action win and rejects the stale concurrent action", async () => {
      const fixture = await createFixture();
      const attempts = await Promise.allSettled([
        lifecycleMutation({ fixture, action: "pause", key: "pause-key" }),
        lifecycleMutation({ fixture, action: "cancel", key: "cancel-key" }),
      ]);
      const fulfilled = attempts.filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<typeof lifecycleMutation>>
        > => attempt.status === "fulfilled",
      );
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === "rejected",
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(lifecycleError(rejected[0]!.reason).code).toBe(
        "revision_mismatch",
      );
      expect(fulfilled[0]!.value.series.revision).toBe(2);
      expect(["paused", "canceled"]).toContain(
        fulfilled[0]!.value.series.state,
      );
      expect(await lifecycleEvidence(fixture)).toEqual({
        receiptCount: 1,
        auditCount: 1,
      });
    });

    it("serializes with stale horizon recovery without leaking a lease or outside-horizon capacity", async () => {
      const staleLease = new Date(NOW.getTime() - 20 * 60 * 1_000);
      const fixture = await createFixture([
        {
          localDate: NEAR_DATE,
          state: "evaluating",
          evaluatedAt: staleLease,
          evaluation: {
            reservationCreated: false,
            maintenanceLeaseAt: staleLease.toISOString(),
          },
        },
        { localDate: OUTSIDE_HORIZON_DATE },
      ]);
      process.env["PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS"] = fixture.accountId;

      const [lifecycle, horizon] = await Promise.allSettled([
        lifecycleMutation({
          fixture,
          action: "pause",
          key: "horizon-race",
        }),
        evaluateDuePartnerRecurringOccurrences({ limit: 10, now: NOW }),
      ]);

      if (lifecycle.status === "rejected") {
        const error = lifecycleError(lifecycle.reason);
        expect(error.code).toBe("conflict");
        expect(error.retryable).toBe(true);
      } else {
        // The horizon worker can finish its claimed occurrence before the
        // lifecycle transaction reaches the series. In that valid serialized
        // order the subsequent pause succeeds; it is not a concurrency leak.
        expect(lifecycle.value.series).toMatchObject({
          state: "paused",
          revision: 2,
        });
      }
      expect(horizon.status).toBe("fulfilled");
      if (horizon.status === "fulfilled") {
        expect(horizon.value.claimed).toBe(1);
        expect(horizon.value.recoveredStale).toBe(1);
      }

      const occurrences = await getDb()
        .select()
        .from(partnerRecurringOccurrences)
        .where(
          eq(partnerRecurringOccurrences.recurringSeriesId, fixture.seriesId),
        );
      expect(
        occurrences.some((occurrence) => occurrence.state === "evaluating"),
      ).toBe(false);
      const outside = occurrences.find(
        (occurrence) => occurrence.localDate === OUTSIDE_HORIZON_DATE,
      );
      expect(outside).toMatchObject({
        state: "tentative",
        bookingDraftId: null,
        partnerBookingId: null,
        failureCode: null,
      });
      expect(outside?.evaluation["reservationCreated"]).toBe(false);
      const [holdCount, appointmentCount] = await Promise.all([
        getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.partnerAccountId, fixture.accountId)),
        getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(appointments)
          .where(eq(appointments.partnerAccountId, fixture.accountId)),
      ]);
      expect(holdCount[0]?.count).toBe(0);
      expect(appointmentCount[0]?.count).toBe(0);
      expect(await lifecycleEvidence(fixture)).toEqual(
        lifecycle.status === "fulfilled"
          ? { receiptCount: 1, auditCount: 1 }
          : { receiptCount: 0, auditCount: 0 },
      );
    });

    it("rejects stale If-Match without changing series, occurrences, audit, or receipt", async () => {
      const fixture = await createFixture();
      await getDb()
        .update(partnerRecurringSeries)
        .set({ revision: 2, updatedAt: new Date(NOW.getTime() + 1_000) })
        .where(eq(partnerRecurringSeries.id, fixture.seriesId));

      await expect(
        lifecycleMutation({
          fixture,
          action: "pause",
          key: "stale-etag",
          ifMatch: etag(fixture.seriesId, 1),
        }),
      ).rejects.toMatchObject({ code: "revision_mismatch", status: 412 });

      const [series] = await getDb()
        .select()
        .from(partnerRecurringSeries)
        .where(eq(partnerRecurringSeries.id, fixture.seriesId));
      const occurrences = await getDb()
        .select()
        .from(partnerRecurringOccurrences)
        .where(
          eq(partnerRecurringOccurrences.recurringSeriesId, fixture.seriesId),
        );
      expect(series).toMatchObject({ state: "active", revision: 2 });
      expect(
        occurrences.every((occurrence) => occurrence.state === "tentative"),
      ).toBe(true);
      expect(await lifecycleEvidence(fixture)).toEqual({
        receiptCount: 0,
        auditCount: 0,
      });
    });
  },
);
