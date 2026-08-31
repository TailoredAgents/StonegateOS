import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "../..");
const source = (relativePath: string): string =>
  readFileSync(path.join(ROOT, relativePath), "utf8");

describe("partner portal V2 operations and commercial foundation", () => {
  const operations = source(
    "apps/api/src/db/migrations/0111_partner_portal_operations_foundation.sql",
  );
  const commercial = source(
    "apps/api/src/db/migrations/0112_partner_portal_commercial_foundation.sql",
  );
  const schema = source("apps/api/src/db/schema.ts");

  it("registers the expand migrations in order without destructive data SQL", () => {
    const journal = JSON.parse(
      source("apps/api/src/db/migrations/meta/_journal.json"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entriesByTag = new Map(
      journal.entries.map((entry) => [entry.tag, entry.idx]),
    );
    expect(entriesByTag.get("0110_partner_account_identity_foundation")).toBe(
      107,
    );
    expect(entriesByTag.get("0111_partner_portal_operations_foundation")).toBe(
      108,
    );
    expect(entriesByTag.get("0112_partner_portal_commercial_foundation")).toBe(
      109,
    );
    expect(
      journal.entries.every(
        (entry, index) =>
          index === 0 || entry.idx > journal.entries[index - 1]!.idx,
      ),
    ).toBe(true);
    for (const migration of [operations, commercial]) {
      expect(migration).not.toMatch(
        /^\s*(?:TRUNCATE|DELETE\s+FROM|DROP\s+TABLE)\b/imu,
      );
      expect(migration).not.toMatch(/ALTER\s+COLUMN[\s\S]*?SET\s+NOT\s+NULL/iu);
    }
  });

  it("creates the account-owned scheduling and booking primitives", () => {
    for (const table of [
      "partner_account_locations",
      "partner_service_catalog",
      "schedule_resource_pools",
      "partner_scheduling_profiles",
      "schedule_date_overrides",
      "schedule_blocks",
      "partner_booking_drafts",
      "partner_draft_media",
      "partner_job_events",
      "partner_job_evidence",
    ]) {
      expect(operations).toContain(`CREATE TABLE "${table}"`);
    }
    expect(operations).toContain(
      'FOREIGN KEY ("partner_account_id", "booking_draft_id")',
    );
    expect(operations).toContain(
      'FOREIGN KEY ("partner_account_id", "partner_booking_id")',
    );
    expect(operations).toContain("partner_portal_migration_issues");
  });

  it("keeps arrival promises separate from internal work duration", () => {
    expect(operations).toContain('"promised_arrival_start_at"');
    expect(operations).toContain('"promised_arrival_end_at"');
    expect(operations).toContain('"duration_minutes" integer NOT NULL');
    expect(schema).toContain("promisedArrivalStartAt");
    expect(schema).toContain("arrivalWindowStartAt");
    expect(schema).toContain("durationMinutes");
  });

  it("requires explicit media ownership and recoverable deletion", () => {
    expect(operations).toContain('CREATE TABLE "partner_draft_media"');
    expect(operations).toContain('CREATE TABLE "partner_job_evidence"');
    expect(operations).toContain('"media_asset_id" uuid NOT NULL');
    expect(operations).toContain("interval '30 days'");
    expect(operations).not.toMatch(
      /partner_(?:draft_media|job_evidence)[\s\S]{0,500}contact_id/iu,
    );
  });

  it("creates versioned commercial evidence and immutable decisions", () => {
    for (const table of [
      "partner_rate_card_versions",
      "partner_rate_card_version_items",
      "partner_approval_rules",
      "partner_approval_requests",
      "partner_approval_decisions",
      "partner_quotes",
      "partner_invoices",
      "partner_invoice_lines",
      "partner_payment_allocations",
      "partner_statements",
    ]) {
      expect(commercial).toContain(`CREATE TABLE "${table}"`);
    }
    expect(commercial).toContain("partner_approval_decisions_immutable");
    expect(commercial).toContain("partner_invoice_lines_immutable");
    expect(commercial).toContain("partner_proof_packages_immutable");
    expect(commercial).toContain(
      "\"state\" IN ('pending', 'settled', 'reversed')",
    );
  });

  it("does not add raw card or bank credential storage", () => {
    const normalized = `${operations}\n${commercial}`.toLowerCase();
    for (const forbidden of [
      "card_number",
      "bank_account_number",
      "routing_number",
      "cvv",
      "security_code",
    ]) {
      expect(normalized).not.toContain(forbidden);
    }
  });
});
