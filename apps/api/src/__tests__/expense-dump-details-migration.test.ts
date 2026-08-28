import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("expense dump-ticket details migration contract", () => {
  const migration = source(
    "src/db/migrations/0109_expense_dump_ticket_details.sql",
  );

  it("registers 0109 exactly once after 0108", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    expect(
      entries.filter(
        (entry) => entry.tag === "0109_expense_dump_ticket_details",
      ),
    ).toEqual([
      expect.objectContaining({
        idx: 106,
        tag: "0109_expense_dump_ticket_details",
      }),
    ]);
    expect(entries.at(-2)?.tag).toBe("0108_expense_recurring_fixed_costs");
    expect(entries.at(-1)?.tag).toBe("0109_expense_dump_ticket_details");
  });

  it("stores one reviewed scale-ticket fact set per expense with exact units", () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "expense_dump_details"',
    );
    expect(migration).toMatch(
      /"expense_id" uuid PRIMARY KEY REFERENCES "expenses"\("id"\)[\s\S]*?ON DELETE RESTRICT/u,
    );
    expect(migration).toContain('"net_weight_pounds" integer');
    expect(migration).toContain('"billed_weight_milli_tons" integer');
    expect(migration).toContain('"unit_rate_cents_per_ton" integer');
    expect(migration).toMatch(
      /"confirmed_by" uuid NOT NULL REFERENCES "team_members"\("id"\)/u,
    );
    expect(migration).toContain(
      "\"weight_status\" IN ('confirmed', 'unreadable')",
    );
  });

  it("requires positive confirmed net weight or an explicit unreadable state", () => {
    expect(migration).toMatch(
      /"weight_status" = 'confirmed'[\s\S]*?"net_weight_pounds" BETWEEN 1 AND 10000000/u,
    );
    expect(migration).toMatch(
      /"weight_status" = 'unreadable'[\s\S]*?"net_weight_pounds" IS NULL/u,
    );
    expect(migration).toContain(
      '"gross_weight_pounds" >= "tare_weight_pounds"',
    );
  });

  it("locks posted facts and preserves the positive Dump Fees allocation link", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER "expense_dump_details_draft_guard"[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON "expense_dump_details"/u,
    );
    expect(migration).toContain("posted dump-ticket facts are immutable");
    expect(migration).toContain(
      'NEW."expense_id" IS DISTINCT FROM OLD."expense_id"',
    );
    expect(migration).toContain("dump-ticket fact identity is immutable");
    expect(migration).toMatch(
      /FROM "expenses"[\s\S]*?WHERE "id" = target_expense_id[\s\S]*?FOR UPDATE;/u,
    );
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER "expense_dump_details_allocation_guard"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER "expense_dump_allocations_link_guard"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(migration).toContain("\"category_id\" = 'dump_fees'");
    expect(migration).toContain('"amount_cents" > 0');
  });

  it("does not invent or backfill historical weights", () => {
    expect(migration).not.toMatch(/(?:^|\n)\s*UPDATE\s+"expenses"/iu);
    expect(migration).not.toMatch(
      /(?:^|\n)\s*INSERT\s+INTO\s+"expense_dump_details"/iu,
    );
  });
});
