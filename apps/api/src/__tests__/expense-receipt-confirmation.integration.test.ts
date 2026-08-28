import { eq } from "drizzle-orm";
import {
  closeDbForTests,
  expenseDumpDetails,
  expenseReceiptCaptures,
  expenses,
  getDb,
  teamMembers,
} from "@/db";
import {
  confirmExpenseReceiptInTransaction,
  parseExpenseReceiptConfirmation,
} from "@/lib/expense-receipt-confirmation";
import {
  createExpenseSubmissionInTransaction,
  parseExpenseSubmission,
  reviewExpenseSubmissionInTransaction,
} from "@/lib/expense-submissions";

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

  it("prevents stale clients from discarding extracted scale-ticket weight", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner] = await tx
          .insert(teamMembers)
          .values({ name: "Scale ticket owner", active: true })
          .returning({ id: teamMembers.id });
        if (!owner) throw new Error("test_owner_missing");

        const [capture] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: owner.id,
            status: "ready",
            storageProvider: "r2",
            originalObjectKey: `expense-test/${owner.id}/scale-ticket.jpg`,
            filename: "scale-ticket.jpg",
            declaredContentType: "image/jpeg",
            uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
            uploadedAt: now,
            version: 2,
            extraction: {
              schemaVersion: 2,
              raw: {
                documentType: "scale_ticket",
                dumpTicket: {
                  facilityName: "Speedway Transfer Station",
                  ticketNumber: "697723",
                  material: "Construction & Demo",
                  grossWeightPounds: 15_780,
                  tareWeightPounds: 12_880,
                  netWeightPounds: 2_900,
                  billedWeightMilliTons: 1_450,
                  unitRateCentsPerTon: 5_000,
                  fieldConfidence: {
                    facilityName: 0.99,
                    ticketNumber: 0.99,
                    material: 0.99,
                    grossWeightPounds: 0.99,
                    tareWeightPounds: 0.99,
                    netWeightPounds: 0.99,
                    billedWeightMilliTons: 0.99,
                    unitRateCentsPerTon: 0.99,
                  },
                },
                vendor: "Capital Waste Services",
                transactionDate: "2026-08-27",
                totalCents: 9_141,
                taxCents: 0,
                paymentLastFour: null,
                suggestedCategoryId: "dump_fees",
                lineItems: null,
                warnings: [],
                fieldConfidence: {
                  documentType: 0.99,
                  vendor: 0.99,
                  transactionDate: 0.99,
                  totalCents: 0.99,
                  taxCents: 0.99,
                  paymentLastFour: null,
                  suggestedCategoryId: 0.99,
                  lineItems: null,
                },
              },
            },
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: expenseReceiptCaptures.id });
        if (!capture) throw new Error("scale_capture_missing");

        await expect(
          confirmExpenseReceiptInTransaction(tx, {
            captureId: capture.id,
            expectedVersion: 2,
            actorId: owner.id,
            canApprove: true,
            confirmation: parseExpenseReceiptConfirmation({
              amountCents: 9_141,
              purchaseDate: "2026-08-27",
              categoryId: "dump_fees",
              vendor: "Capital Waste Services",
              payerType: "company",
              paidByMemberId: null,
            }),
            now,
          }),
        ).rejects.toMatchObject({
          code: "conflict",
          fieldErrors: {
            receiptReviewContractVersion:
              "Close and reopen or refresh StonegateOS, then review the receipt again.",
          },
        });
        await expect(
          confirmExpenseReceiptInTransaction(tx, {
            captureId: capture.id,
            expectedVersion: 2,
            actorId: owner.id,
            canApprove: true,
            confirmation: parseExpenseReceiptConfirmation({
              amountCents: 9_141,
              purchaseDate: "2026-08-27",
              categoryId: "dump_fees",
              vendor: "Capital Waste Services",
              payerType: "company",
              paidByMemberId: null,
              receiptReviewContractVersion: 2,
            }),
            now,
          }),
        ).rejects.toMatchObject({
          code: "invalid",
          fieldErrors: {
            dumpDetails:
              "Confirm the visible net weight or explicitly mark it unreadable.",
          },
        });

        const [storedScaleEvidence] = await tx
          .select({ extraction: expenseReceiptCaptures.extraction })
          .from(expenseReceiptCaptures)
          .where(eq(expenseReceiptCaptures.id, capture.id));
        const [oldClientCapture] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: owner.id,
            status: "ready",
            storageProvider: "r2",
            originalObjectKey: `expense-test/${owner.id}/old-client-scale.jpg`,
            filename: "old-client-scale.jpg",
            declaredContentType: "image/jpeg",
            uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
            uploadedAt: now,
            version: 1,
            extraction: storedScaleEvidence?.extraction,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: expenseReceiptCaptures.id });
        if (!oldClientCapture) throw new Error("old_client_capture_missing");
        const oldClientConfirmed = await confirmExpenseReceiptInTransaction(
          tx,
          {
            captureId: oldClientCapture.id,
            expectedVersion: 1,
            actorId: owner.id,
            canApprove: true,
            dumpTicketsEnabled: false,
            confirmation: parseExpenseReceiptConfirmation({
              amountCents: 9_141,
              purchaseDate: "2026-08-27",
              categoryId: "fuel",
              vendor: "Capital Waste Services",
              payerType: "company",
              paidByMemberId: null,
            }),
            now,
          },
        );
        expect(oldClientConfirmed).toMatchObject({
          lifecycleStatus: "posted",
          dumpDetailsRecorded: false,
        });

        const overridden = await confirmExpenseReceiptInTransaction(tx, {
          captureId: capture.id,
          expectedVersion: 2,
          actorId: owner.id,
          canApprove: true,
          confirmation: parseExpenseReceiptConfirmation({
            amountCents: 9_141,
            purchaseDate: "2026-08-27",
            categoryId: "fuel",
            vendor: "Capital Waste Services",
            payerType: "company",
            paidByMemberId: null,
            scaleTicketDisposition: "not_scale_ticket",
            receiptReviewContractVersion: 2,
          }),
          now,
        });
        expect(overridden).toMatchObject({
          lifecycleStatus: "posted",
          dumpDetailsRecorded: false,
        });

        const [ordinaryCapture] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: owner.id,
            status: "ready",
            storageProvider: "r2",
            originalObjectKey: `expense-test/${owner.id}/ordinary.jpg`,
            filename: "ordinary.jpg",
            declaredContentType: "image/jpeg",
            uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
            uploadedAt: now,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: expenseReceiptCaptures.id });
        if (!ordinaryCapture) throw new Error("ordinary_capture_missing");
        await expect(
          confirmExpenseReceiptInTransaction(tx, {
            captureId: ordinaryCapture.id,
            expectedVersion: 1,
            actorId: owner.id,
            canApprove: true,
            confirmation: parseExpenseReceiptConfirmation({
              amountCents: 5_000,
              purchaseDate: "2026-08-27",
              categoryId: "fuel",
              payerType: "company",
              paidByMemberId: null,
              scaleTicketDisposition: "not_scale_ticket",
            }),
            now,
          }),
        ).rejects.toMatchObject({
          code: "invalid",
          fieldErrors: {
            scaleTicketDisposition: "Remove the classification override.",
          },
        });

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });

  it("queues a crew ticket duplicate for reasoned owner approval and still guards direct owner posting", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const now = new Date("2026-08-27T15:00:00.000Z");
        const [owner, crew] = await tx
          .insert(teamMembers)
          .values([
            { name: "Ticket duplicate owner", active: true },
            { name: "Ticket duplicate crew", active: true },
          ])
          .returning({ id: teamMembers.id });
        if (!owner || !crew) throw new Error("duplicate_members_missing");

        const dumpDetails = {
          weightStatus: "confirmed" as const,
          facilityName: "Speedway Transfer Station",
          ticketNumber: "697723",
          material: "Const & Demo",
          grossWeightPounds: 15_780,
          tareWeightPounds: 12_880,
          netWeightPounds: 2_900,
          billedWeightMilliTons: 1_450,
          unitRateCentsPerTon: 5_000,
          reviewed: true as const,
        };
        const original = await createExpenseSubmissionInTransaction(tx, {
          submission: parseExpenseSubmission({
            amountCents: 9_141,
            purchaseDate: "2026-08-27",
            categoryId: "dump_fees",
            vendor: "Capital Waste Services",
            payerType: "company",
            paidByMemberId: null,
            dumpDetails,
          }),
          actorId: owner.id,
          canApprove: true,
          source: "receipt_scan",
          now,
        });
        expect(
          await tx
            .select({ expenseId: expenseDumpDetails.expenseId })
            .from(expenseDumpDetails)
            .where(eq(expenseDumpDetails.expenseId, original.expenseId)),
        ).toHaveLength(1);

        const [crewCapture] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: crew.id,
            status: "ready",
            storageProvider: "r2",
            originalObjectKey: `expense-test/${crew.id}/different-photo.jpg`,
            filename: "different-photo.jpg",
            declaredContentType: "image/jpeg",
            uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
            uploadedAt: now,
            version: 4,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: expenseReceiptCaptures.id });
        if (!crewCapture) throw new Error("duplicate_capture_missing");

        const submission = {
          amountCents: 9_141,
          purchaseDate: "2026-08-27",
          categoryId: "dump_fees",
          vendor: "Capital Waste Services",
          payerType: "company",
          paidByMemberId: null,
          dumpDetails: {
            ...dumpDetails,
            facilityName: " speedway transfer-station ",
          },
        };
        const pending = await confirmExpenseReceiptInTransaction(tx, {
          captureId: crewCapture.id,
          expectedVersion: 4,
          actorId: crew.id,
          canApprove: false,
          confirmation: parseExpenseReceiptConfirmation(submission),
          now,
        });
        expect(pending).toMatchObject({
          scaleTicketDuplicateOfExpenseId: original.expenseId,
          duplicateOverrideRecorded: false,
          lifecycleStatus: "draft",
          reviewStatus: "pending",
        });
        expect(
          await tx
            .select({
              lifecycleStatus: expenses.lifecycleStatus,
              reviewStatus: expenses.reviewStatus,
            })
            .from(expenses)
            .where(eq(expenses.id, pending.expenseId)),
        ).toEqual([{ lifecycleStatus: "draft", reviewStatus: "pending" }]);
        const [confirmedCrewCapture] = await tx
          .select({
            exactDuplicateOfCaptureId:
              expenseReceiptCaptures.exactDuplicateOfCaptureId,
            duplicateOverrideReason:
              expenseReceiptCaptures.duplicateOverrideReason,
          })
          .from(expenseReceiptCaptures)
          .where(eq(expenseReceiptCaptures.id, crewCapture.id));
        expect(confirmedCrewCapture).toEqual({
          exactDuplicateOfCaptureId: null,
          duplicateOverrideReason: null,
        });
        await expect(
          reviewExpenseSubmissionInTransaction(tx, {
            expenseId: pending.expenseId,
            reviewerId: owner.id,
            expectedVersion: 1,
            decision: { decision: "approve", reason: null },
            now: new Date(now.getTime() + 500),
          }),
        ).rejects.toMatchObject({
          code: "invalid",
          fieldErrors: {
            reason:
              "Enter at least 10 characters explaining why this is not a duplicate expense.",
          },
        });
        expect(
          await tx
            .select({ lifecycleStatus: expenses.lifecycleStatus })
            .from(expenses)
            .where(eq(expenses.id, pending.expenseId)),
        ).toEqual([{ lifecycleStatus: "draft" }]);
        const approved = await reviewExpenseSubmissionInTransaction(tx, {
          expenseId: pending.expenseId,
          reviewerId: owner.id,
          expectedVersion: 1,
          decision: {
            decision: "approve",
            reason: "Separate disposal charge verified against the ticket",
          },
          now: new Date(now.getTime() + 1_000),
        });
        expect(approved).toMatchObject({
          lifecycleStatus: "posted",
          reviewStatus: "approved",
          scaleTicketDuplicateOfExpenseId: original.expenseId,
        });
        expect(
          await tx
            .select({ id: expenses.id })
            .from(expenses)
            .where(eq(expenses.receiptCaptureId, crewCapture.id)),
        ).toHaveLength(1);

        const [ownerCapture] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: owner.id,
            status: "ready",
            storageProvider: "r2",
            originalObjectKey: `expense-test/${owner.id}/different-photo.jpg`,
            filename: "different-photo.jpg",
            declaredContentType: "image/jpeg",
            uploadExpiresAt: new Date("2026-08-27T16:00:00.000Z"),
            uploadedAt: now,
            version: 2,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: expenseReceiptCaptures.id });
        if (!ownerCapture) throw new Error("owner_duplicate_capture_missing");
        await expect(
          confirmExpenseReceiptInTransaction(tx, {
            captureId: ownerCapture.id,
            expectedVersion: 2,
            actorId: owner.id,
            canApprove: true,
            confirmation: parseExpenseReceiptConfirmation(submission),
            now,
          }),
        ).rejects.toMatchObject({ code: "invalid" });
        expect(
          await tx
            .select({ id: expenses.id })
            .from(expenses)
            .where(eq(expenses.receiptCaptureId, ownerCapture.id)),
        ).toEqual([]);

        const confirmed = await confirmExpenseReceiptInTransaction(tx, {
          captureId: ownerCapture.id,
          expectedVersion: 2,
          actorId: owner.id,
          canApprove: true,
          confirmation: parseExpenseReceiptConfirmation({
            ...submission,
            exactDuplicateOverrideReason:
              "Separate disposal charge after owner verified the ticket",
          }),
          now,
        });
        expect(confirmed).toMatchObject({
          duplicateOverrideRecorded: true,
          lifecycleStatus: "posted",
        });
        expect(confirmed.scaleTicketDuplicateOfExpenseId).not.toBeNull();
        const [updatedCapture] = await tx
          .select({
            reason: expenseReceiptCaptures.duplicateOverrideReason,
            actorId: expenseReceiptCaptures.duplicateOverrideBy,
          })
          .from(expenseReceiptCaptures)
          .where(eq(expenseReceiptCaptures.id, ownerCapture.id));
        expect(updatedCapture).toEqual({
          reason: "Separate disposal charge after owner verified the ticket",
          actorId: owner.id,
        });

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });
});
