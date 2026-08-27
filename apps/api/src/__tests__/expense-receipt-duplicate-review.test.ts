import fs from "node:fs";
import path from "node:path";
import {
  ExpenseReceiptCaptureError,
  parseExactDuplicateCaptureReviewQuery,
} from "@/lib/expense-receipt-captures";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

function cursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString(
    "base64url",
  );
}

function expectQueryFailure(searchParams: URLSearchParams, code: string): void {
  try {
    parseExactDuplicateCaptureReviewQuery(searchParams);
    throw new Error("Expected duplicate review query parsing to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ExpenseReceiptCaptureError);
    if (!(error instanceof ExpenseReceiptCaptureError)) throw error;
    expect(error.code).toBe(code);
    expect(error.status).toBe(400);
  }
}

describe("exact duplicate receipt review queue", () => {
  it("uses a bounded default and accepts a valid keyset cursor", () => {
    expect(
      parseExactDuplicateCaptureReviewQuery(new URLSearchParams()),
    ).toEqual({ limit: 25, cursor: null });

    const createdAt = "2026-08-27T14:30:00.000Z";
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      parseExactDuplicateCaptureReviewQuery(
        new URLSearchParams({ limit: "100", cursor: cursor(createdAt, id) }),
      ),
    ).toEqual({ limit: 100, cursor: { updatedAt: new Date(createdAt), id } });
  });

  it.each(["0", "101", "1.5", "twenty-five"])(
    "rejects an invalid queue limit (%s)",
    (limit) => {
      expectQueryFailure(
        new URLSearchParams({ limit }),
        "expense_receipt_review_limit_invalid",
      );
    },
  );

  it.each([
    "not-base64-json",
    "a".repeat(257),
    cursor("2026-08-27", "11111111-1111-4111-8111-111111111111"),
    cursor("2026-08-27T14:30:00.000Z", "not-a-uuid"),
  ])("rejects a malformed queue cursor", (value) => {
    expectQueryFailure(
      new URLSearchParams({ cursor: value }),
      "expense_receipt_review_cursor_invalid",
    );
  });

  it("keeps the queue exact-only and the posting bridge owner-gated", () => {
    const captures = read("apps/api/src/lib/expense-receipt-captures.ts");
    const confirmation = read(
      "apps/api/src/lib/expense-receipt-confirmation.ts",
    );

    expect(captures).toContain('eq(expenseReceiptCaptures.status, "ready")');
    expect(captures).toContain(
      "isNotNull(expenseReceiptCaptures.exactDuplicateOfCaptureId)",
    );
    expect(captures).toContain(".limit(query.limit + 1)");
    expect(confirmation).toContain("if (!input.canApprove)");
    expect(confirmation).toContain(
      "if (!duplicateReason || duplicateReason.length < 10)",
    );
    expect(confirmation).toContain("duplicateOverrideReason:");
    expect(confirmation).toContain("duplicateOverrideBy:");
  });
});
