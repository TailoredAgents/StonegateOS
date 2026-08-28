import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closeDbForTests, expenseDumpDetails, expenses, getDb } from "@/db";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

function isolatedSchemaName(): string {
  return `expense_dump_concurrency_${randomUUID().replaceAll("-", "")}`;
}

function quoted(identifier: string): string {
  if (!/^[a-z0-9_]+$/u.test(identifier)) {
    throw new Error("unsafe_test_schema_identifier");
  }
  return `"${identifier}"`;
}

async function setSearchPath(
  executor: { execute(query: ReturnType<typeof sql.raw>): Promise<unknown> },
  schemaName: string,
): Promise<void> {
  await executor.execute(
    sql.raw(`set local search_path to ${quoted(schemaName)}, public`),
  );
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0] as unknown;
  return typeof first === "object" && first !== null
    ? (first as Record<string, unknown>)
    : null;
}

function databaseErrorText(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error) messages.push(current.message);
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return messages.join("\n");
}

describeOrSkip("expense dump-ticket parent/child concurrency guard", () => {
  jest.setTimeout(15_000);

  afterAll(async () => {
    await closeDbForTests();
  });

  it("blocks a late detail writer until posting commits, then rejects it", async () => {
    const db = getDb();
    const schemaName = isolatedSchemaName();
    const schema = quoted(schemaName);
    const expenseId = randomUUID();
    const actorId = randomUUID();
    const now = new Date("2026-08-27T15:00:00.000Z");
    let schemaCreated = false;
    let parentAttempt: Promise<void> | null = null;
    let childAttempt: Promise<
      { ok: true } | { ok: false; error: unknown }
    > | null = null;
    let releaseParentCommit: (() => void) | null = null;

    try {
      await db.execute(sql.raw(`create schema ${schema}`));
      schemaCreated = true;
      await db.execute(
        sql.raw(
          `create table ${schema}."expenses" (like public."expenses" including all)`,
        ),
      );
      await db.execute(
        sql.raw(
          `create table ${schema}."expense_dump_details" (like public."expense_dump_details" including all)`,
        ),
      );
      await db.execute(
        sql.raw(
          `create trigger "expense_dump_details_draft_guard" before insert or update or delete on ${schema}."expense_dump_details" for each row execute function public.enforce_expense_dump_details_draft_only()`,
        ),
      );

      await db.transaction(async (tx) => {
        await setSearchPath(tx, schemaName);
        await tx.insert(expenses).values({
          id: expenseId,
          amount: 9_141,
          currency: "USD",
          category: "Dump Fees",
          categoryId: "dump_fees",
          categoryNeedsReview: false,
          vendor: "Capital Waste Services",
          source: "receipt_scan",
          submittedBy: actorId,
          payerType: "company",
          paidByMemberId: null,
          reviewStatus: "pending",
          reviewedBy: null,
          reviewedAt: null,
          paidAt: now,
          lifecycleStatus: "draft",
          version: 1,
          postedAt: null,
          postedBy: null,
          createdAt: now,
          updatedAt: now,
        });
      });

      let signalParentUpdated: (() => void) | null = null;
      const parentUpdated = new Promise<void>((resolve) => {
        signalParentUpdated = resolve;
      });
      const allowParentCommit = new Promise<void>((resolve) => {
        releaseParentCommit = resolve;
      });
      parentAttempt = db.transaction(async (tx) => {
        await setSearchPath(tx, schemaName);
        await tx
          .update(expenses)
          .set({
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            reviewedBy: actorId,
            reviewedAt: now,
            postedAt: now,
            postedBy: actorId,
            version: 2,
            updatedAt: now,
          })
          .where(eq(expenses.id, expenseId));
        signalParentUpdated?.();
        await allowParentCommit;
      });
      await parentUpdated;

      let signalChildPid: ((pid: number) => void) | null = null;
      const childPid = new Promise<number>((resolve) => {
        signalChildPid = resolve;
      });
      childAttempt = db
        .transaction(async (tx) => {
          await setSearchPath(tx, schemaName);
          const pidRows = await tx.execute(
            sql`select pg_backend_pid()::integer as pid`,
          );
          const pid = Number(firstRecord(pidRows)?.["pid"] ?? NaN);
          if (!Number.isSafeInteger(pid)) throw new Error("child_pid_missing");
          signalChildPid?.(pid);
          await tx.insert(expenseDumpDetails).values({
            expenseId,
            weightStatus: "confirmed",
            facilityName: "Speedway Transfer Station",
            ticketNumber: "697723",
            material: "Const & Demo",
            grossWeightPounds: 15_780,
            tareWeightPounds: 12_880,
            netWeightPounds: 2_900,
            billedWeightMilliTons: 1_450,
            unitRateCentsPerTon: 5_000,
            confirmedBy: actorId,
            confirmedAt: now,
            createdAt: now,
          });
        })
        .then(
          () => ({ ok: true }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );

      const waitingPid = await childPid;
      let observedLockWait = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const activityRows = await db.execute(sql`
          select wait_event_type as "waitEventType"
          from pg_stat_activity
          where pid = ${waitingPid}
        `);
        if (firstRecord(activityRows)?.["waitEventType"] === "Lock") {
          observedLockWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedLockWait).toBe(true);

      releaseParentCommit?.();
      await parentAttempt;
      const childOutcome = await childAttempt;
      expect(childOutcome.ok).toBe(false);
      if (childOutcome.ok) {
        throw new Error("late_dump_detail_was_inserted");
      }
      expect(databaseErrorText(childOutcome.error)).toContain(
        "posted dump-ticket facts are immutable",
      );

      const persisted = await db.transaction(async (tx) => {
        await setSearchPath(tx, schemaName);
        return tx.select().from(expenseDumpDetails);
      });
      expect(persisted).toEqual([]);
    } finally {
      releaseParentCommit?.();
      const pendingAttempts: Promise<unknown>[] = [];
      if (parentAttempt !== null) pendingAttempts.push(parentAttempt);
      if (childAttempt !== null) pendingAttempts.push(childAttempt);
      await Promise.allSettled(pendingAttempts);
      if (schemaCreated) {
        await db.execute(
          sql.raw(`drop table ${schema}."expense_dump_details"`),
        );
        await db.execute(sql.raw(`drop table ${schema}."expenses"`));
        await db.execute(sql.raw(`drop schema ${schema}`));
      }
    }
  });
});
