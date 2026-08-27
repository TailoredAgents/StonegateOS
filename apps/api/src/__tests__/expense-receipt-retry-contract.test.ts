import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "../..");
const source = (relativePath: string): string =>
  fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");

describe("expense receipt retry state contract", () => {
  const migration = source(
    "src/db/migrations/0104_expense_receipt_retry_state.sql",
  );
  const service = source("src/lib/expense-receipt-captures.ts");
  const outbox = source("src/lib/outbox-processor.ts");

  it("registers durable attempt and next-attempt diagnostics", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    expect(journal.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idx: 101,
          tag: "0104_expense_receipt_retry_state",
        }),
      ]),
    );
    expect(migration).toContain('"analysis_attempt_count" integer');
    expect(migration).toContain('"analysis_next_attempt_at" timestamp');
    expect(migration).toContain(
      "OLD.\"status\" = 'analyzing' AND NEW.\"status\" IN ('queued', 'ready', 'failed')",
    );
    expect(migration).toContain(
      "OLD.\"status\" = 'failed' AND NEW.\"status\" = 'discarded'",
    );
  });

  it("requeues transient failures and never revives a terminal failure", () => {
    expect(service).toContain("requeueCaptureAfterRetryableFailure");
    expect(service).toContain('status: "queued"');
    expect(service).toContain("analysisNextAttemptAt: input.retryAt");
    expect(service).toContain('capture.status === "queued"');
    expect(service).toContain('"ready", "failed", "confirmed", "discarded"');
    expect(service).not.toContain("resetFailedCaptureToQueued");
  });

  it("leaves infrastructure failures retryable until capture state is durable", () => {
    expect(outbox).toContain('event.type === "expense.receipt.analyze" ||');
    expect(outbox).not.toContain(
      'event.type === "expense.receipt.analyze" && attempt < 5',
    );
  });
});
