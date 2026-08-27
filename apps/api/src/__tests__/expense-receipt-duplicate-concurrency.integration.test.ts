import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closeDbForTests, expenseReceiptCaptures, expenses, getDb } from "@/db";
import {
  confirmExpenseReceiptInTransaction,
  parseExpenseReceiptConfirmation,
} from "@/lib/expense-receipt-confirmation";
import { TeamMutationFailure } from "@/lib/team-mutation";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

function isolatedSchemaName(): string {
  return `expense_duplicate_concurrency_${randomUUID().replaceAll("-", "")}`;
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

describeOrSkip(
  "expense receipt exact-duplicate confirmation concurrency",
  () => {
    jest.setTimeout(15_000);

    afterAll(async () => {
      await closeDbForTests();
    });

    it("allows only one identical capture to post when neither owner records an override", async () => {
      const db = getDb();
      const schemaName = isolatedSchemaName();
      const schema = quoted(schemaName);
      let schemaCreated = false;
      const createdTables: string[] = [];

      try {
        await db.execute(sql.raw(`create schema ${schema}`));
        schemaCreated = true;
        for (const table of [
          "expense_categories",
          "expense_receipt_captures",
          "expenses",
          "expense_allocations",
        ]) {
          await db.execute(
            sql.raw(
              `create table ${schema}.${quoted(table)} (like public.${quoted(table)} including all)`,
            ),
          );
          createdTables.push(table);
        }
        await db.execute(
          sql.raw(
            `insert into ${schema}."expense_categories" ("id", "name", "sort_order", "is_active", "is_legacy") values ('fuel', 'Fuel', 20, true, false)`,
          ),
        );

        const sha256 = createHash("sha256").update(schemaName).digest("hex");
        const now = new Date("2026-08-27T15:00:00.000Z");
        const confirmation = parseExpenseReceiptConfirmation({
          amountCents: 2_500,
          purchaseDate: "2026-08-26",
          categoryId: "fuel",
          vendor: null,
          payerType: "company",
          paidByMemberId: null,
        });
        let arrivals = 0;
        let releaseBarrier: (() => void) | null = null;
        const bothCapturesInserted = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });

        const contend = (label: string) =>
          db.transaction(async (tx) => {
            await setSearchPath(tx, schemaName);
            const actorId = randomUUID();
            const captureId = randomUUID();
            await tx.insert(expenseReceiptCaptures).values({
              id: captureId,
              submittedBy: actorId,
              status: "ready",
              storageProvider: "r2",
              originalObjectKey: `${schemaName}/${label}.jpg`,
              filename: `${label}.jpg`,
              declaredContentType: "image/jpeg",
              verifiedContentType: "image/jpeg",
              byteLength: 128,
              sha256,
              uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
              uploadedAt: now,
              analysisCompletedAt: now,
              version: 1,
              createdAt: now,
              updatedAt: now,
            });
            arrivals += 1;
            if (arrivals === 2) releaseBarrier?.();
            await bothCapturesInserted;

            return confirmExpenseReceiptInTransaction(tx, {
              captureId,
              expectedVersion: 1,
              actorId,
              canApprove: true,
              confirmation,
              now,
            });
          });

        const outcomes = await Promise.allSettled([
          contend("capture-a"),
          contend("capture-b"),
        ]);
        const posted = outcomes.filter(
          (
            outcome,
          ): outcome is PromiseFulfilledResult<
            Awaited<ReturnType<typeof confirmExpenseReceiptInTransaction>>
          > => outcome.status === "fulfilled",
        );
        const refused = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );

        expect(posted).toHaveLength(1);
        expect(refused).toHaveLength(1);
        const refusal = refused[0]?.reason as unknown;
        expect(refusal).toBeInstanceOf(TeamMutationFailure);
        if (!(refusal instanceof TeamMutationFailure)) {
          throw new Error("expected_duplicate_confirmation_refusal");
        }
        expect(refusal.code).toBe("invalid");
        expect(refusal.fieldErrors?.["exactDuplicateOverrideReason"]).toContain(
          "at least 10 characters",
        );

        const persisted = await db.transaction(async (tx) => {
          await setSearchPath(tx, schemaName);
          return Promise.all([
            tx.select({ id: expenses.id }).from(expenses),
            tx
              .select({
                id: expenseReceiptCaptures.id,
                status: expenseReceiptCaptures.status,
                duplicateOverrideReason:
                  expenseReceiptCaptures.duplicateOverrideReason,
                duplicateOverrideBy: expenseReceiptCaptures.duplicateOverrideBy,
              })
              .from(expenseReceiptCaptures)
              .where(eq(expenseReceiptCaptures.status, "confirmed")),
          ]);
        });
        expect(persisted[0]).toHaveLength(1);
        expect(persisted[1]).toEqual([
          expect.objectContaining({
            status: "confirmed",
            duplicateOverrideReason: null,
            duplicateOverrideBy: null,
          }),
        ]);
      } finally {
        if (schemaCreated) {
          for (const table of createdTables.reverse()) {
            await db.execute(sql.raw(`drop table ${schema}.${quoted(table)}`));
          }
          await db.execute(sql.raw(`drop schema ${schema}`));
        }
      }
    });
  },
);
