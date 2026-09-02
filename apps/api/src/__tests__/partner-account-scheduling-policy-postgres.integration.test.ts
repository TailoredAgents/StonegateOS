import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccountSchedulingPolicies,
  partnerAccounts,
  teamMembers,
} from "@/db";
import { updatePartnerAccountSchedulingPolicyAsStaff } from "@/lib/partner-account-scheduling-policy-administration";

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
      name: `Scheduling policy operator ${suffix}`,
    });
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: `Scheduling policy account ${suffix}`,
      normalizedName: `scheduling policy account ${suffix}`,
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
  "Partner account scheduling policy PostgreSQL integrity",
  () => {
    const fixtures: Array<{ accountId: string; teamMemberId: string }> = [];

    afterEach(async () => {
      const pending = fixtures.splice(0);
      await Promise.all(pending.map((fixture) => deleteFixture(fixture)));
    });

    afterAll(async () => {
      await closeDbForTests();
    });

    it("trigger-seeds every new account with a persisted fail-closed policy", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const [policy] = await getDb()
        .select()
        .from(partnerAccountSchedulingPolicies)
        .where(
          eq(
            partnerAccountSchedulingPolicies.partnerAccountId,
            fixture.accountId,
          ),
        )
        .limit(1);
      expect(policy).toMatchObject({
        partnerAccountId: fixture.accountId,
        minimumNoticeMinutes: 0,
        minimumCalendarLeadDays: 1,
        maximumBookingHorizonDays: 30,
        instantConfirmationEnabled: false,
        revision: 1,
      });
    });

    it("enforces narrowing bounds in PostgreSQL independently of the route", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      let error: DatabaseError = {};
      try {
        await getDb()
          .update(partnerAccountSchedulingPolicies)
          .set({ maximumBookingHorizonDays: 31 })
          .where(
            eq(
              partnerAccountSchedulingPolicies.partnerAccountId,
              fixture.accountId,
            ),
          );
      } catch (caught) {
        error = deepestDatabaseError(caught);
      }
      expect(error.code).toBe("23514");
      expect(error.constraint_name).toBe(
        "partner_account_scheduling_policies_horizon_check",
      );
    });

    it("serializes policy changes with the global schedule lock and rejects one stale writer", async () => {
      const fixture = await createFixture();
      fixtures.push(fixture);
      const db = getDb();
      const attempts = await Promise.allSettled([
        db.transaction((tx) =>
          updatePartnerAccountSchedulingPolicyAsStaff(tx, {
            partnerAccountId: fixture.accountId,
            values: {
              minimumNoticeMinutes: 120,
              minimumCalendarLeadDays: 2,
              maximumBookingHorizonDays: 14,
              instantConfirmationEnabled: true,
            },
            expectedVersion: "1",
            changedByTeamMemberId: fixture.teamMemberId,
          }),
        ),
        db.transaction((tx) =>
          updatePartnerAccountSchedulingPolicyAsStaff(tx, {
            partnerAccountId: fixture.accountId,
            values: {
              minimumNoticeMinutes: 1_440,
              minimumCalendarLeadDays: 5,
              maximumBookingHorizonDays: 7,
              instantConfirmationEnabled: false,
            },
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
        .from(partnerAccountSchedulingPolicies)
        .where(
          eq(
            partnerAccountSchedulingPolicies.partnerAccountId,
            fixture.accountId,
          ),
        )
        .limit(1);
      expect(policy?.revision).toBe(2);
      expect(policy?.lastChangedByTeamMemberId).toBe(fixture.teamMemberId);
      expect([
        [120, 2, 14, true],
        [1_440, 5, 7, false],
      ]).toContainEqual([
        policy?.minimumNoticeMinutes,
        policy?.minimumCalendarLeadDays,
        policy?.maximumBookingHorizonDays,
        policy?.instantConfirmationEnabled,
      ]);
    });
  },
);
