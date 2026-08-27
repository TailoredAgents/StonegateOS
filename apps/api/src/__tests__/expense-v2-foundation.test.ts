import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("Expense Tracking V2 database foundation", () => {
  const migration = source(
    "src/db/migrations/0102_expense_tracking_v2_foundation.sql",
  );

  it("registers the additive migration after the booking backfill", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];

    expect(entries.slice(-2)).toEqual([
      expect.objectContaining({
        idx: 98,
        tag: "0101_online_booking_quote_range_backfill",
      }),
      expect.objectContaining({
        idx: 99,
        tag: "0102_expense_tracking_v2_foundation",
      }),
    ]);
  });

  it("seeds every locked stable category and deterministic aliases", () => {
    const categories = [
      ["dump_fees", "Dump Fees"],
      ["fuel", "Fuel"],
      ["meals", "Meals"],
      ["equipment", "Equipment"],
      ["vehicle", "Vehicle"],
      ["insurance", "Insurance"],
      ["software", "Software"],
      ["advertising", "Advertising"],
      ["supplies", "Supplies"],
      ["tolls_parking", "Tolls/Parking"],
      ["subcontractors", "Subcontractors"],
      ["office_admin", "Office/Admin"],
      ["other", "Other"],
      ["reimbursements", "Reimbursements"],
    ] as const;

    for (const [id, label] of categories) {
      expect(migration).toContain(`('${id}', '${label}'`);
    }
    expect(migration).toContain(
      '"category_needs_review" = (\n    nullif(btrim("category"), \'\') IS NOT NULL AND "category_id" IS NULL',
    );
    expect(migration).not.toMatch(/UPDATE\s+"expenses"[\s\S]*ELSE\s+'other'/iu);
  });

  it("stores receipt references and analysis state without a new data-url column", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "expense_receipt_captures"',
    );
    expect(migration).toContain('"original_object_key" text NOT NULL');
    expect(migration).toContain('"normalized_object_key" text');
    expect(migration).toContain('"sha256" varchar(64)');
    expect(migration).not.toMatch(
      /expense_receipt_captures[\s\S]{0,3000}"receipt_url"/u,
    );
    expect(migration).toContain("receipt capture evidence cannot be deleted");
  });

  it("enforces exact signed allocations and immutable posted allocations", () => {
    expect(migration).toContain(
      "expense allocations must exactly equal expense total",
    );
    expect(migration).toContain(
      "expense allocations must follow expense amount direction",
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER "expense_allocation_total_on_expense"',
    );
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("posted expense allocations are immutable");
  });

  it("distinguishes missing daily ads from confirmed zero with one row per date", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "daily_ad_spend_platform_date_key"',
    );
    expect(migration).toContain(
      '("amount_cents" = 0 AND "current_expense_id" IS NULL)',
    );
    expect(migration).toContain(
      '("amount_cents" > 0 AND "current_expense_id" IS NOT NULL)',
    );
    expect(migration).toContain(
      "daily ad spend confirmations cannot be deleted",
    );
  });

  it("links a reimbursement claim to exactly one underlying expense", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "expense_reimbursement_claims"',
    );
    expect(migration).toContain('"expense_reimbursement_claims_expense_key"');
    expect(migration).toContain('"payout_adjustment_id" uuid REFERENCES');
    expect(migration).toContain(
      "reimbursement claim financial evidence is immutable",
    );
    expect(migration).not.toMatch(
      /CREATE TABLE IF NOT EXISTS "expense_reimbursement_claims"[\s\S]*?"receipt_url"/u,
    );
  });
});
