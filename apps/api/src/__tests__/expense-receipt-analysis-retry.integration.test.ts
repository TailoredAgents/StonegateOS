import { eq } from "drizzle-orm";

const mockGetMediaObject = jest.fn(() =>
  Promise.resolve(Buffer.from("receipt")),
);
const mockExtractExpenseReceiptWithOpenAi = jest.fn();
const mockRecordProviderFailure = jest.fn(() => Promise.resolve());
const mockRecordProviderSuccess = jest.fn(() => Promise.resolve());

class MockExpenseReceiptAnalysisProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
    this.name = "ExpenseReceiptAnalysisProviderError";
  }
}

jest.mock("@/lib/media-storage", () => ({
  getMediaObject: mockGetMediaObject,
}));

jest.mock("@/lib/expense-receipt-openai", () => ({
  ExpenseReceiptAnalysisProviderError: MockExpenseReceiptAnalysisProviderError,
  extractExpenseReceiptWithOpenAi: mockExtractExpenseReceiptWithOpenAi,
}));

jest.mock("@/lib/provider-health", () => ({
  recordProviderFailure: mockRecordProviderFailure,
  recordProviderSuccess: mockRecordProviderSuccess,
}));

import {
  closeDbForTests,
  expenseReceiptCaptures,
  getDb,
  teamMembers,
} from "@/db";
import {
  processExpenseReceiptAnalysisOutbox,
  toExpenseReceiptCaptureStatusDto,
} from "@/lib/expense-receipt-captures";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

describeOrSkip("expense receipt analysis retry integration", () => {
  const ROLLBACK = new Error("expense_receipt_retry_test_rollback");

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await closeDbForTests();
  });

  it("keeps transient failures queued and makes only permanent failures terminal", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        let clock = new Date("2026-08-27T14:00:00.000Z");
        const [member] = await tx
          .insert(teamMembers)
          .values({ name: "Receipt retry employee", active: true })
          .returning({ id: teamMembers.id });
        if (!member) throw new Error("test_member_missing");

        const [created] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: member.id,
            status: "queued",
            storageProvider: "r2",
            originalObjectKey: `expense-retry-test/${member.id}/original.jpg`,
            filename: "receipt.jpg",
            declaredContentType: "image/jpeg",
            verifiedContentType: "image/jpeg",
            byteLength: 7,
            sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            uploadExpiresAt: new Date("2026-08-27T15:00:00.000Z"),
            uploadedAt: clock,
            analysisQueuedAt: clock,
            version: 1,
            createdAt: clock,
            updatedAt: clock,
          })
          .returning();
        if (!created) throw new Error("test_capture_missing");

        mockExtractExpenseReceiptWithOpenAi.mockRejectedValueOnce(
          new MockExpenseReceiptAnalysisProviderError(
            "openai_expense_http_429",
            true,
            "Rate limited",
          ),
        );
        const retry = await processExpenseReceiptAnalysisOutbox(
          { captureId: created.id, priorAttempts: 0 },
          { db: tx, now: () => clock },
        );
        expect(retry).toEqual({
          status: "retry",
          error: "openai_expense_http_429",
          nextAttemptAt: new Date("2026-08-27T14:01:00.000Z"),
        });

        const [queued] = await tx
          .select()
          .from(expenseReceiptCaptures)
          .where(eq(expenseReceiptCaptures.id, created.id));
        if (!queued) throw new Error("queued_capture_missing");
        expect(queued).toEqual(
          expect.objectContaining({
            status: "queued",
            version: 3,
            analysisAttemptCount: 1,
            analysisStartedAt: null,
            analysisCompletedAt: null,
            analysisNextAttemptAt: new Date("2026-08-27T14:01:00.000Z"),
            failureCode: "openai_expense_http_429",
            failureMessage: "Rate limited",
          }),
        );
        expect(toExpenseReceiptCaptureStatusDto(queued)).toEqual(
          expect.objectContaining({
            status: "queued",
            retryPending: true,
            analysisAttemptCount: 1,
            analysisNextAttemptAt: "2026-08-27T14:01:00.000Z",
            failure: {
              code: "openai_expense_http_429",
              message: "Rate limited",
            },
          }),
        );

        const earlyRetry = await processExpenseReceiptAnalysisOutbox(
          { captureId: created.id, priorAttempts: 1 },
          { db: tx, now: () => clock },
        );
        expect(earlyRetry).toEqual(retry);
        expect(mockExtractExpenseReceiptWithOpenAi).toHaveBeenCalledTimes(1);

        clock = new Date("2026-08-27T14:01:00.001Z");
        mockExtractExpenseReceiptWithOpenAi.mockRejectedValueOnce(
          new MockExpenseReceiptAnalysisProviderError(
            "openai_expense_http_400",
            false,
            "Unsupported receipt input",
          ),
        );
        const terminal = await processExpenseReceiptAnalysisOutbox(
          { captureId: created.id, priorAttempts: 2 },
          { db: tx, now: () => clock },
        );
        expect(terminal).toEqual({
          status: "processed",
          error: "openai_expense_http_400",
        });

        const [failed] = await tx
          .select()
          .from(expenseReceiptCaptures)
          .where(eq(expenseReceiptCaptures.id, created.id));
        if (!failed) throw new Error("failed_capture_missing");
        expect(failed).toEqual(
          expect.objectContaining({
            status: "failed",
            version: 5,
            analysisAttemptCount: 2,
            analysisNextAttemptAt: null,
            analysisCompletedAt: clock,
            failureCode: "openai_expense_http_400",
            failureMessage: "Unsupported receipt input",
          }),
        );
        expect(toExpenseReceiptCaptureStatusDto(failed)).toEqual(
          expect.objectContaining({
            status: "failed",
            retryPending: false,
            analysisAttemptCount: 2,
            analysisNextAttemptAt: null,
          }),
        );

        const terminalReplay = await processExpenseReceiptAnalysisOutbox(
          { captureId: created.id, priorAttempts: 3 },
          { db: tx, now: () => clock },
        );
        expect(terminalReplay).toEqual({ status: "processed" });
        expect(mockExtractExpenseReceiptWithOpenAi).toHaveBeenCalledTimes(2);

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });

  it("marks the capture failed only after the fifth retryable analysis attempt", async () => {
    await expect(
      getDb().transaction(async (tx) => {
        let clock = new Date("2026-08-28T13:00:00.000Z");
        const [member] = await tx
          .insert(teamMembers)
          .values({ name: "Receipt exhaustion employee", active: true })
          .returning({ id: teamMembers.id });
        if (!member) throw new Error("test_member_missing");

        const [created] = await tx
          .insert(expenseReceiptCaptures)
          .values({
            submittedBy: member.id,
            status: "queued",
            storageProvider: "r2",
            originalObjectKey: `expense-exhaustion-test/${member.id}/original.jpg`,
            filename: "receipt.jpg",
            declaredContentType: "image/jpeg",
            verifiedContentType: "image/jpeg",
            byteLength: 7,
            sha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            uploadExpiresAt: new Date("2026-08-28T14:00:00.000Z"),
            uploadedAt: clock,
            analysisQueuedAt: clock,
            version: 1,
            createdAt: clock,
            updatedAt: clock,
          })
          .returning();
        if (!created) throw new Error("test_capture_missing");

        mockExtractExpenseReceiptWithOpenAi.mockRejectedValue(
          new MockExpenseReceiptAnalysisProviderError(
            "openai_expense_http_503",
            true,
            "Provider unavailable",
          ),
        );

        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const outcome = await processExpenseReceiptAnalysisOutbox(
            { captureId: created.id, priorAttempts: attempt - 1 },
            { db: tx, now: () => clock },
          );
          if (attempt < 5) {
            expect(outcome).toEqual(
              expect.objectContaining({
                status: "retry",
                error: "openai_expense_http_503",
              }),
            );
            expect(outcome.nextAttemptAt).toBeInstanceOf(Date);
            const retryAt = outcome.nextAttemptAt;
            if (!retryAt) throw new Error("retry_time_missing");
            clock = new Date(retryAt.getTime() + 1);
          } else {
            expect(outcome).toEqual({
              status: "processed",
              error: "openai_expense_http_503",
            });
          }
        }

        const [failed] = await tx
          .select()
          .from(expenseReceiptCaptures)
          .where(eq(expenseReceiptCaptures.id, created.id));
        expect(failed).toEqual(
          expect.objectContaining({
            status: "failed",
            version: 11,
            analysisAttemptCount: 5,
            analysisNextAttemptAt: null,
            failureCode: "openai_expense_http_503",
          }),
        );
        expect(mockExtractExpenseReceiptWithOpenAi).toHaveBeenCalledTimes(5);

        const terminalReplay = await processExpenseReceiptAnalysisOutbox(
          { captureId: created.id, priorAttempts: 5 },
          { db: tx, now: () => clock },
        );
        expect(terminalReplay).toEqual({ status: "processed" });
        expect(mockExtractExpenseReceiptWithOpenAi).toHaveBeenCalledTimes(5);

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });
});
