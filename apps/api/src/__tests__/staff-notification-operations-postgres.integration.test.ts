import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  closeDbForTests,
  getDb,
  staffNotificationOperations,
  teamMembers,
} from "@/db";
import {
  finalizeStaffNotificationDispatch,
  prepareStaffNotificationDispatch,
} from "@/lib/staff-notification-operations";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type Fixture = {
  memberId: string;
  operationId: string;
  subjectId: string;
};

function uniqueTestPhone(): string {
  const subscriber = (
    BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) %
    10_000_000_000n
  )
    .toString()
    .padStart(10, "0");
  return `+1${subscriber}`;
}

async function createFixture(): Promise<Fixture> {
  const memberId = randomUUID();
  const operationId = randomUUID();
  const subjectId = randomUUID();
  const phoneE164 = uniqueTestPhone();
  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({
      id: memberId,
      name: "Billing notification recipient",
      phoneE164,
      active: true,
    });
    await tx.insert(staffNotificationOperations).values({
      id: operationId,
      appointmentId: subjectId,
      contactId: null,
      recipientTeamMemberId: memberId,
      kind: "partner_billing_dispute_requested",
      channel: "sms",
      recipientAddress: phoneE164,
      body: `Billing request ${subjectId.slice(0, 8)} needs review.`,
      state: "requested",
      providerRequestKey: `staff-alert:billing-test:${operationId}`,
    });
  });
  return { memberId, operationId, subjectId };
}

describeWithDatabase("Staff notification PostgreSQL dispatch safety", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    const pending = fixtures.splice(0);
    if (pending.length === 0) return;
    await getDb().transaction(async (tx) => {
      await tx
        .delete(staffNotificationOperations)
        .where(
          inArray(
            staffNotificationOperations.id,
            pending.map((item) => item.operationId),
          ),
        );
      await tx
        .delete(teamMembers)
        .where(inArray(teamMembers.id, pending.map((item) => item.memberId)));
      const [remainingOperations, remainingMembers] = await Promise.all([
        tx
          .select({ id: staffNotificationOperations.id })
          .from(staffNotificationOperations)
          .where(
            inArray(
              staffNotificationOperations.id,
              pending.map((item) => item.operationId),
            ),
          ),
        tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(
            inArray(
              teamMembers.id,
              pending.map((item) => item.memberId),
            ),
          ),
      ]);
      expect(remainingOperations).toEqual([]);
      expect(remainingMembers).toEqual([]);
    });
  });

  afterAll(async () => closeDbForTests());

  it("fails closed when the Staff recipient is disabled or no longer owns the queued phone", async () => {
    const changed = await createFixture();
    const disabled = await createFixture();
    const current = await createFixture();
    fixtures.push(changed, disabled, current);
    await getDb().transaction(async (tx) => {
      await tx
        .update(teamMembers)
        .set({ phoneE164: uniqueTestPhone() })
        .where(eq(teamMembers.id, changed.memberId));
      await tx
        .update(teamMembers)
        .set({ active: false })
        .where(eq(teamMembers.id, disabled.memberId));
    });

    const [changedResult, disabledResult, currentResult] = await Promise.all([
      getDb().transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId: changed.operationId,
          outboxEventId: randomUUID(),
        }),
      ),
      getDb().transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId: disabled.operationId,
          outboxEventId: randomUUID(),
        }),
      ),
      getDb().transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId: current.operationId,
          outboxEventId: randomUUID(),
        }),
      ),
    ]);

    expect(changedResult).toEqual({ kind: "terminal", state: "failed" });
    expect(disabledResult).toEqual({ kind: "terminal", state: "failed" });
    expect(currentResult.kind).toBe("dispatch");
    const stored = await getDb()
      .select({
        id: staffNotificationOperations.id,
        state: staffNotificationOperations.state,
        failureCode: staffNotificationOperations.failureCode,
        attemptCount: staffNotificationOperations.attemptCount,
      })
      .from(staffNotificationOperations)
      .where(
        inArray(staffNotificationOperations.id, [
          changed.operationId,
          disabled.operationId,
          current.operationId,
        ]),
      );
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: changed.operationId,
          state: "failed",
          failureCode: "recipient_address_changed",
          attemptCount: 0,
        }),
        expect.objectContaining({
          id: disabled.operationId,
          state: "failed",
          failureCode: "recipient_unavailable",
          attemptCount: 0,
        }),
        expect.objectContaining({
          id: current.operationId,
          state: "dispatched",
          failureCode: null,
          attemptCount: 1,
        }),
      ]),
    );
    const audits = await getDb()
      .select({
        surface: auditLogs.surface,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
      })
      .from(auditLogs)
      .where(
        inArray(auditLogs.entityId, [
          changed.subjectId,
          disabled.subjectId,
          current.subjectId,
        ]),
      );
    expect(audits).toHaveLength(3);
    expect(audits).toEqual(
      expect.arrayContaining(
        [changed, disabled, current].map((item) => ({
          surface: "/partners/billing",
          entityType: "partner_billing_dispute_request",
          entityId: item.subjectId,
        })),
      ),
    );
  });

  it.each([
    ["missing", undefined],
    ["uncertain", "uncertain" as const],
  ])(
    "routes an ok provider result with %s certainty to reconciliation",
    async (_label, deliveryCertainty) => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const prepared = await getDb().transaction((tx) =>
        prepareStaffNotificationDispatch(tx, {
          operationId: fixture.operationId,
          outboxEventId: randomUUID(),
        }),
      );
      expect(prepared.kind).toBe("dispatch");

      const result = await getDb().transaction((tx) =>
        finalizeStaffNotificationDispatch(tx, {
          operationId: fixture.operationId,
          outboxEventId: randomUUID(),
          result: {
            ok: true,
            provider: "test-provider",
            providerMessageId: `provider-${_label}`,
            ...(deliveryCertainty ? { deliveryCertainty } : {}),
          },
        }),
      );
      expect(result).toEqual({
        kind: "processed",
        state: "reconciliation_required",
      });
      const [stored] = await getDb()
        .select({
          state: staffNotificationOperations.state,
          certainty: staffNotificationOperations.deliveryCertainty,
          retryable: staffNotificationOperations.retryable,
        })
        .from(staffNotificationOperations)
        .where(eq(staffNotificationOperations.id, fixture.operationId));
      expect(stored).toEqual({
        state: "reconciliation_required",
        certainty: "uncertain",
        retryable: false,
      });
    },
  );
});
