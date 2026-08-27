import { eq } from "drizzle-orm";
import {
  closeDbForTests,
  expenseReceiptCaptures,
  expenses,
  getDb,
  teamMembers,
} from "@/db";
import {
  confirmExpenseReceiptInTransaction,
  parseExpenseReceiptConfirmation,
} from "@/lib/expense-receipt-confirmation";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

describeOrSkip("expense receipt human confirmation integration", () => {
  const ROLLBACK = new Error("expense_receipt_confirmation_test_rollback");

  afterAll(async () => {
    await closeDbForTests();
  });

  it("blocks crew exact duplicates and posts only owner-confirmed values with a recorded override", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner, crew] = await tx
          .insert(teamMembers)
          .values([
            { name: "Receipt confirmation owner", active: true },
            { name: "Receipt confirmation crew", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !crew) throw new Error("test_members_missing");

        const [original] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: crew.id,
            status: "ready",
            storageProvider: "r2",
            originalObjectKey: `expense-test/${crew.id}/original.jpg`,
            filename: "original.jpg",
            declaredContentType: "image/jpeg",
            uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
            uploadedAt: now,
            version: 3,
            extraction: {
              schemaVersion: 1,
              raw: { totalCents: 99_999, vendor: "Untrusted AI value" },
            },
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: expenseReceiptCaptures.id });
        if (!original) throw new Error("original_capture_missing");

        const [duplicate] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: crew.id,
            status: "ready",
            storageProvider: "r2",
            originalObjectKey: `expense-test/${crew.id}/duplicate.jpg`,
            filename: "duplicate.jpg",
            declaredContentType: "image/jpeg",
            uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
            uploadedAt: now,
            exactDuplicateOfCaptureId: original.id,
            version: 5,
            extraction: {
              schemaVersion: 1,
              raw: { totalCents: 99_999, vendor: "Untrusted AI value" },
            },
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: expenseReceiptCaptures.id });
        if (!duplicate) throw new Error("duplicate_capture_missing");

        const humanConfirmation = parseExpenseReceiptConfirmation({
          amountCents: 2_500,
          purchaseDate: "2026-08-26",
          categoryId: "fuel",
          vendor: "Human Confirmed Fuel Stop",
          payerType: "company",
          paidByMemberId: null,
        });
        await expect(
          confirmExpenseReceiptInTransaction(tx, {
            captureId: duplicate.id,
            expectedVersion: 5,
            actorId: crew.id,
            canApprove: false,
            confirmation: humanConfirmation,
            now,
          }),
        ).rejects.toMatchObject({
          code: "conflict",
          fieldErrors: {
            exactDuplicateOverrideReason: "Owner approval is required.",
          },
        });
        expect(
          await tx
            .select({ id: expenses.id })
            .from(expenses)
            .where(eq(expenses.receiptCaptureId, duplicate.id)),
        ).toHaveLength(0);

        const confirmed = await confirmExpenseReceiptInTransaction(tx, {
          captureId: duplicate.id,
          expectedVersion: 5,
          actorId: owner.id,
          canApprove: true,
          confirmation: parseExpenseReceiptConfirmation({
            ...humanConfirmation.submission,
            exactDuplicateOverrideReason:
              "Separate purchase with an accidentally reused image export",
          }),
          now,
        });
        expect(confirmed).toEqual(
          expect.objectContaining({
            lifecycleStatus: "posted",
            reviewStatus: "approved",
            captureStatus: "confirmed",
            captureVersion: 6,
            captureSubmittedBy: crew.id,
            duplicateOverrideRecorded: true,
          }),
        );

        const [posted] = await tx
          .select({
            amountCents: expenses.amount,
            vendor: expenses.vendor,
            submittedBy: expenses.submittedBy,
            reviewedBy: expenses.reviewedBy,
            receiptCaptureId: expenses.receiptCaptureId,
          })
          .from(expenses)
          .where(eq(expenses.receiptCaptureId, duplicate.id));
        expect(posted).toEqual({
          amountCents: 2_500,
          vendor: "Human Confirmed Fuel Stop",
          submittedBy: crew.id,
          reviewedBy: owner.id,
          receiptCaptureId: duplicate.id,
        });
        const [capture] = await tx
          .select({
            status: expenseReceiptCaptures.status,
            duplicateOverrideReason:
              expenseReceiptCaptures.duplicateOverrideReason,
            duplicateOverrideBy: expenseReceiptCaptures.duplicateOverrideBy,
          })
          .from(expenseReceiptCaptures)
          .where(eq(expenseReceiptCaptures.id, duplicate.id));
        expect(capture).toEqual({
          status: "confirmed",
          duplicateOverrideReason:
            "Separate purchase with an accidentally reused image export",
          duplicateOverrideBy: owner.id,
        });

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });
});
