import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccountCancellationPolicies,
  partnerAccounts,
  teamMembers,
} from "@/db";
import { updatePartnerAccountCancellationPolicyAsStaff } from "@/lib/partner-account-cancellation-policy-administration";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type DatabaseError = Readonly<{
  code?: unknown;
  constraint_name?: unknown;
}>;

function deepestDatabaseError(error: unknown): DatabaseError {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (!record["cause"]) return record;
    current = record["cause"];
  }
  return {};
}

async function createFixture(): Promise<{
  accountId: string;
  teamMemberId: string;
}> {
  const accountId = randomUUID();
  const teamMemberId = randomUUID();
  const suffix = accountId.slice(0, 8);
  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({
      id: teamMemberId,
      name: `Cancellation policy operator ${suffix}`,
    });
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: `Cancellation policy account ${suffix}`,
      normalizedName: `cancellation policy account ${suffix}`,
    });
  });
  return { accountId, teamMemberId };
}

async function deleteFixture(input: {
  accountId: string;
  teamMemberId: string;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(partnerAccounts)
      .where(eq(partnerAccounts.id, input.accountId));
    await tx.delete(teamMembers).where(eq(teamMembers.id, input.teamMemberId));
  });
}

describeWithDatabase(
  "Partner account cancellation policy PostgreSQL integrity",
  () => {
    const fixtures: Array<{ accountId: string; teamMemberId: string }> = [];

    afterEach(async () => {
      const pending = fixtures.splice(0);
      await Promise.all(pending.map((fixture) => deleteFixture(fixture)));
    });

    afterAll(async () => {
      await closeDbForTests();
    });

    it("trigger-seeds every new account with the safe 24-hour/no-fee policy", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const [policy] = await getDb()
        .select()
        .from(partnerAccountCancellationPolicies)
        .where(
          eq(
            partnerAccountCancellationPolicies.partnerAccountId,
            fixture.accountId,
          ),
        )
        .limit(1);
      expect(policy).toMatchObject({
        partnerAccountId: fixture.accountId,
        minimumNoticeMinutes: 1_440,
        directCancellationEnabled: true,
        lateCancellationDisposition: "staff_review",
        automaticFeeMinor: null,
        revision: 1,
      });
    });

    it("enforces notice and no-automatic-fee constraints in PostgreSQL", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);

      let noticeError: DatabaseError = {};
      try {
        await getDb()
          .update(partnerAccountCancellationPolicies)
          .set({ minimumNoticeMinutes: 1_439 })
          .where(
            eq(
              partnerAccountCancellationPolicies.partnerAccountId,
              fixture.accountId,
            ),
          );
      } catch (caught) {
        noticeError = deepestDatabaseError(caught);
      }
      expect(noticeError.code).toBe("23514");
      expect(noticeError.constraint_name).toBe(
        "partner_account_cancellation_policies_notice_check",
      );

      let feeError: DatabaseError = {};
      try {
        await getDb()
          .update(partnerAccountCancellationPolicies)
          .set({ automaticFeeMinor: 5_000 })
          .where(
            eq(
              partnerAccountCancellationPolicies.partnerAccountId,
              fixture.accountId,
            ),
          );
      } catch (caught) {
        feeError = deepestDatabaseError(caught);
      }
      expect(feeError.code).toBe("23514");
      expect(feeError.constraint_name).toBe(
        "partner_account_cancellation_policies_no_automatic_fee_check",
      );
    });

    it("serializes changes with the schedule lock and rejects one stale writer", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const db = getDb();
      const attempts = await Promise.allSettled([
        db.transaction((tx) =>
          updatePartnerAccountCancellationPolicyAsStaff(tx, {
            partnerAccountId: fixture.accountId,
            minimumNoticeMinutes: 2_880,
            directCancellationEnabled: true,
            expectedVersion: "1",
            changedByTeamMemberId: fixture.teamMemberId,
          }),
        ),
        db.transaction((tx) =>
          updatePartnerAccountCancellationPolicyAsStaff(tx, {
            partnerAccountId: fixture.accountId,
            minimumNoticeMinutes: 10_080,
            directCancellationEnabled: false,
            expectedVersion: "1",
            changedByTeamMemberId: fixture.teamMemberId,
          }),
        ),
      ]);
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);

      const [policy] = await db
        .select()
        .from(partnerAccountCancellationPolicies)
        .where(
          eq(
            partnerAccountCancellationPolicies.partnerAccountId,
            fixture.accountId,
          ),
        )
        .limit(1);
      expect(policy?.revision).toBe(2);
      expect(policy?.lastChangedByTeamMemberId).toBe(fixture.teamMemberId);
      expect([
        [2_880, true],
        [10_080, false],
      ]).toContainEqual([
        policy?.minimumNoticeMinutes,
        policy?.directCancellationEnabled,
      ]);
    });
  },
);
