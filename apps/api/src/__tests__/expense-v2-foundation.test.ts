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
  const correctionControls = source(
    "src/db/migrations/0103_expense_v2_correction_controls.sql",
  );
  const releaseGuards = source(
    "src/db/migrations/0105_expense_v2_release_guards.sql",
  );
  const dumpAliasBackfill = source(
    "src/db/migrations/0107_expense_dump_alias_and_backfill.sql",
  );

  it("registers the additive expense migrations after the booking backfill", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];

    const firstExpenseMigration = entries.findIndex(
      (entry) => entry.tag === "0101_online_booking_quote_range_backfill",
    );
    expect(
      entries.slice(firstExpenseMigration, firstExpenseMigration + 9),
    ).toEqual([
      expect.objectContaining({
        idx: 98,
        tag: "0101_online_booking_quote_range_backfill",
      }),
      expect.objectContaining({
        idx: 99,
        tag: "0102_expense_tracking_v2_foundation",
      }),
      expect.objectContaining({
        idx: 100,
        tag: "0103_expense_v2_correction_controls",
      }),
      expect.objectContaining({
        idx: 101,
        tag: "0104_expense_receipt_retry_state",
      }),
      expect.objectContaining({
        idx: 102,
        tag: "0105_expense_v2_release_guards",
      }),
      expect.objectContaining({
        idx: 103,
        tag: "0106_expense_mobile_queue_health",
      }),
      expect.objectContaining({
        idx: 104,
        tag: "0107_expense_dump_alias_and_backfill",
      }),
      expect.objectContaining({
        idx: 105,
        tag: "0108_expense_recurring_fixed_costs",
      }),
      expect.objectContaining({
        idx: 106,
        tag: "0109_expense_dump_ticket_details",
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
    expect(dumpAliasBackfill).toContain("VALUES ('dump_fees', 'Dump', 'dump')");
    expect(dumpAliasBackfill).toContain('INSERT INTO "expense_allocations"');
    expect(dumpAliasBackfill).toMatch(
      /DISABLE TRIGGER "expenses_v2_evidence_guard"[\s\S]*UPDATE "expenses"[\s\S]*ENABLE TRIGGER "expenses_v2_evidence_guard"/u,
    );
    expect(dumpAliasBackfill).toMatch(
      /DISABLE TRIGGER "expense_allocations_immutability_guard"[\s\S]*INSERT INTO "expense_allocations"[\s\S]*ENABLE TRIGGER "expense_allocations_immutability_guard"/u,
    );
    expect(dumpAliasBackfill).toMatch(
      /INSERT INTO "expense_allocations"[\s\S]*SET CONSTRAINTS ALL IMMEDIATE;[\s\S]*ENABLE TRIGGER "expense_allocations_immutability_guard"/u,
    );
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
    expect(releaseGuards).toContain(
      'CREATE CONSTRAINT TRIGGER "daily_ad_spend_expense_link_guard"',
    );
    expect(releaseGuards).toContain(
      'CREATE CONSTRAINT TRIGGER "current_daily_ad_expense_posted_guard"',
    );
    expect(releaseGuards).toContain(
      'expense."amount_cents" = entry."amount_cents"',
    );
  });

  it("links a reimbursement claim to exactly one underlying expense", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "expense_reimbursement_claims"',
    );
    expect(migration).toContain('"expense_reimbursement_claims_expense_key"');
    expect(migration).toContain('"payout_adjustment_id" uuid REFERENCES');
    expect(correctionControls).toContain(
      "reimbursement financial evidence may only follow a linked expense correction",
    );
    expect(correctionControls).toContain(
      "active reimbursements require the linked correction workflow",
    );
    expect(migration).not.toMatch(
      /CREATE TABLE IF NOT EXISTS "expense_reimbursement_claims"[\s\S]*?"receipt_url"/u,
    );
  });

  it("prevents pending submissions from becoming posted ledger entries", () => {
    expect(releaseGuards).toContain('"expenses_review_lifecycle_check"');
    expect(releaseGuards).toContain(
      "\"lifecycle_status\" = 'draft' OR \"review_status\" = 'approved'",
    );
  });

  it("removes legacy global expense grants from crew", () => {
    expect(releaseGuards).toContain(
      "array_remove(coalesce(\"permissions\", ARRAY[]::text[]), 'expenses.read')",
    );
    expect(releaseGuards).toContain("'expenses.write'");
    expect(migration).toContain("expenses.submit");
  });
});
