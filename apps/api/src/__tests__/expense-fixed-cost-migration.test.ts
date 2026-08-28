import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("fixed monthly cost migration contract", () => {
  const migration = source(
    "src/db/migrations/0108_expense_recurring_fixed_costs.sql",
  );

  it("registers 0108 exactly once after 0107", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const matches = entries.filter(
      (entry) => entry.tag === "0108_expense_recurring_fixed_costs",
    );

    expect(matches).toEqual([
      expect.objectContaining({
        idx: 105,
        tag: "0108_expense_recurring_fixed_costs",
      }),
    ]);
    expect(entries.at(-2)?.tag).toBe("0107_expense_dump_alias_and_backfill");
    expect(entries.at(-1)?.tag).toBe("0108_expense_recurring_fixed_costs");
  });

  it("creates stable series and exact, effective-dated versions", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "expense_fixed_cost_series"',
    );
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "expense_fixed_cost_versions"',
    );
    expect(migration).toContain('"monthly_amount_cents" integer NOT NULL');
    expect(migration).toContain('"effective_start_date" date NOT NULL');
    expect(migration).toContain(
      '"category_id" text NOT NULL REFERENCES "expense_categories"("id")',
    );
    expect(migration).toMatch(
      /expense_fixed_cost_versions_series_version_key[\s\S]*?\("series_id", "version"\)/u,
    );
    expect(migration).toContain(
      'CHECK ("monthly_amount_cents" BETWEEN 1 AND 100000000)',
    );
  });

  it("makes accounting identities and versions append-only", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER "expense_fixed_cost_series_append_only_guard"[\s\S]*?BEFORE UPDATE OR DELETE ON "expense_fixed_cost_series"/u,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "expense_fixed_cost_versions_append_only_guard"[\s\S]*?BEFORE UPDATE OR DELETE ON "expense_fixed_cost_versions"/u,
    );
    expect(migration).toContain(
      "fixed cost accounting records are append-only",
    );
    expect(migration).not.toMatch(
      /(?:^|\n)\s*UPDATE\s+"expense_fixed_cost_(?:series|versions)"/iu,
    );
    expect(migration).not.toMatch(
      /(?:^|\n)\s*DELETE\s+FROM\s+"expense_fixed_cost_(?:series|versions)"/iu,
    );
  });

  it("guards contiguous versions, monotonic effective dates, and terminal endings", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER "expense_fixed_cost_versions_sequence_guard"[\s\S]*?BEFORE INSERT ON "expense_fixed_cost_versions"/u,
    );
    expect(migration).toContain('IF NEW."version" <> 1 THEN');
    expect(migration).toContain('IF NEW."version" <> latest_version + 1 THEN');
    expect(migration).toContain(
      'IF NEW."effective_start_date" < latest_effective_start THEN',
    );
    expect(migration).toContain("IF latest_state = 'ended' THEN");
  });

  it("links receipt evidence without permitting double-count or mutable relinking", () => {
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "covered_by_fixed_cost_series_id" uuid',
    );
    expect(migration).toMatch(
      /expenses_covered_by_fixed_cost_series_id_fkey[\s\S]*?REFERENCES "expense_fixed_cost_series"\("id"\)[\s\S]*?ON DELETE RESTRICT/u,
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER "expenses_fixed_cost_coverage_guard"',
    );
    expect(migration).toMatch(
      /expenses_fixed_cost_coverage_guard[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(migration).toContain(
      "linked expense must have one exact fixed cost allocation",
    );
    expect(migration).toContain(
      "fixed cost already has linked expense evidence for the month",
    );
    expect(migration).toContain(
      "fixed cost coverage is immutable outside expense approval",
    );
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER "expense_fixed_cost_revision_coverage_guard"',
    );
    expect(migration).toContain(
      "fixed cost revision would invalidate a linked expense",
    );
  });
});
