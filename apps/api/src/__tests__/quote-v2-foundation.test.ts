import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function createTableBlock(migration: string, table: string): string {
  const match = migration.match(
    new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\);`, "u"),
  );
  if (!match) {
    throw new Error(`Missing CREATE TABLE for ${table}`);
  }
  return match[0];
}

describe("Quote V2 database foundation", () => {
  const migration = source("src/db/migrations/0114_quote_v2_foundation.sql");
  const schema = source("src/db/schema.ts");

  it("registers 0114 after the unrelated partner 0113 migration", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const quoteMigration = entries.findIndex(
      (entry) => entry.tag === "0114_quote_v2_foundation",
    );

    expect(entries.slice(quoteMigration - 1, quoteMigration + 1)).toEqual([
      expect.objectContaining({
        idx: 110,
        tag: "0113_partner_calendar_external_busy_coverage",
      }),
      expect.objectContaining({
        idx: 111,
        tag: "0114_quote_v2_foundation",
      }),
    ]);
  });

  it("is expand-only and does not silently backfill legacy quote data", () => {
    expect(migration).not.toMatch(
      /^\s*(?:TRUNCATE|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN)|UPDATE|INSERT\s+INTO)\b/imu,
    );
    expect(migration).not.toMatch(/ALTER\s+COLUMN[\s\S]*?SET\s+NOT\s+NULL/iu);
    expect(migration).not.toMatch(/engine_version[^;]*DEFAULT\s+'v2'/iu);
    expect(migration).toContain(
      "\"engine_version\" text DEFAULT 'legacy' NOT NULL",
    );
  });

  it("exports the opportunity, version aggregate, delivery, and evidence tables", () => {
    const exports = [
      "salesOpportunities",
      "quoteVersions",
      "quoteVersionOptionGroups",
      "quoteVersionLineItems",
      "quoteVersionAdjustments",
      "quoteVersionAttachments",
      "quoteVersionDocuments",
      "quoteCapabilities",
      "quoteSendAttempts",
      "quoteSendDeliveries",
      "quoteResponses",
      "quoteActivityEvents",
      "quotePublicRateLimits",
      "quoteMigrationCheckpoints",
      "quoteMigrationReviewItems",
    ];
    const tables = [
      "sales_opportunities",
      "quote_versions",
      "quote_version_option_groups",
      "quote_version_line_items",
      "quote_version_adjustments",
      "quote_version_attachments",
      "quote_version_documents",
      "quote_capabilities",
      "quote_send_attempts",
      "quote_send_deliveries",
      "quote_responses",
      "quote_activity_events",
      "quote_public_rate_limits",
      "quote_migration_checkpoints",
      "quote_migration_review_items",
    ];

    for (const exportedName of exports) {
      expect(schema).toContain(`export const ${exportedName} = pgTable(`);
    }
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it("matches the no-tax, range-aware domain contract and freezes ready content", () => {
    const versions = createTableBlock(migration, "quote_versions");
    const optionGroups = createTableBlock(
      migration,
      "quote_version_option_groups",
    );
    const lineItems = createTableBlock(migration, "quote_version_line_items");
    const adjustments = createTableBlock(
      migration,
      "quote_version_adjustments",
    );

    expect(versions).toContain('"document_snapshot" jsonb');
    expect(versions).toContain('"party_snapshot" jsonb');
    expect(versions).toContain('"issuer_snapshot" jsonb');
    expect(versions).toContain('"canonical_render_json" text');
    for (const hash of [
      "document_schema_hash",
      "pricing_hash",
      "template_hash",
      "content_hash",
    ]) {
      expect(versions).toContain(`"${hash}" varchar(64)`);
    }
    expect(versions).toContain(
      "\"document_type\" IN ('fixed_quote', 'estimate', 'range')",
    );
    expect(versions).toContain(
      "\"state\" IN ('draft', 'ready', 'issued', 'superseded', 'accepted', 'expired', 'declined', 'voided')",
    );
    expect(versions).toContain('"subtotal_min_cents" integer');
    expect(versions).toContain('"subtotal_max_cents" integer');
    expect(versions).toContain('"deposit_cents" integer');
    expect(versions).toContain('"balance_min_cents" integer');
    expect(versions).toContain('"balance_max_cents" integer');
    expect(versions).not.toContain("tax");
    expect(lineItems).toContain('"quantity" numeric(12,3)');
    expect(lineItems).toContain('"unit_price_min_cents" integer');
    expect(lineItems).toContain('"unit_price_max_cents" integer');
    expect(lineItems).toContain('"amount_min_cents" integer');
    expect(lineItems).toContain('"amount_max_cents" integer');
    expect(lineItems).toContain("quote_line_items_option_group_fk");
    expect(optionGroups).toContain('"minimum_selections" integer');
    expect(optionGroups).toContain('"maximum_selections" integer');
    expect(adjustments).toContain("\"kind\" IN ('discount', 'fee', 'travel')");
    expect(adjustments).not.toContain("tax");
    expect(versions).toContain("quote_versions_totals_check");
    expect(versions).toContain("quote_versions_deposit_check");
    expect(versions).toContain("quote_versions_range_check");
    expect(versions).toContain("quote_versions_ready_publication_check");
    expect(versions).toContain(
      "\"state\" IN ('draft', 'voided') OR \"ready_at\" IS NOT NULL",
    );
    expect(versions).toContain(
      '"state" <> \'draft\' OR (\n      "valid_from" IS NULL',
    );
    expect(versions).toContain(
      '"state" <> \'ready\' OR (\n      "valid_from" IS NULL',
    );
    expect(versions).toContain(
      '"canonical_render_json" IS NOT NULL AND "document_schema_hash" IS NOT NULL',
    );
    expect(versions).toContain(
      "\"state\" IN ('draft', 'ready', 'voided') OR (\n      \"ready_at\" IS NOT NULL AND \"issued_at\" IS NOT NULL",
    );
    expect(migration).toContain("quote_versions_immutable_after_ready");
    expect(migration).toContain(
      "canonical quote content may only be frozen during draft to ready transition",
    );
    expect(migration).toContain(
      "OLD.\"state\" = 'draft' AND NEW.\"state\" = 'ready'",
    );
    expect(migration).toContain(
      "quote validity evidence may only be set during ready to issued transition",
    );
    expect(migration).toContain("quote_version_option_groups_draft_only");
    expect(migration).toContain("quote_version_line_items_draft_only");
    expect(migration).toContain("quote_version_adjustments_draft_only");
    expect(migration).toContain("quote_version_attachments_draft_only");
  });

  it("adds publication evidence without rewriting ready content during issue", () => {
    const persistence = source("src/lib/quote-v2-issue-persistence.ts");
    const issueUpdate = persistence.match(
      /\.update\(quoteVersions\)\n\s+\.set\(\{\n\s+state: "issued",([\s\S]*?)\n\s+\}\)\n\s+\.where/u,
    );
    expect(issueUpdate).not.toBeNull();
    const patch = issueUpdate?.[1] ?? "";
    for (const frozenField of [
      "selectedOptionIds",
      "canonicalRenderJson",
      "documentSchemaHash",
      "pricingHash",
      "templateHash",
      "contentHash",
      "subtotalMinCents",
      "totalMinCents",
      "depositCents",
      "balanceMinCents",
    ]) {
      expect(patch).not.toContain(`${frozenField}:`);
    }
    for (const publicationField of [
      "validFrom",
      "issuedAt",
      "expiresAt",
      "firstSentAt",
    ]) {
      expect(patch).toContain(`${publicationField}:`);
    }
    expect(persistence).toContain(
      "versionContentHash: source.readyContentHash",
    );
    expect(persistence).toContain("renderContentHash: versionPlan.contentHash");
  });

  it("supports approved opportunities without allowing closed-state regression", () => {
    const opportunities = createTableBlock(migration, "sales_opportunities");
    expect(opportunities).toContain(
      "\"status\" IN ('open', 'approved', 'won', 'lost', 'archived')",
    );
    expect(migration).toContain("sales_opportunities_status_transition_guard");
    expect(migration).toContain("closed opportunity cannot regress");
  });

  it("links opportunity context across lead, booking, task, and conversation surfaces", () => {
    for (const table of [
      "leads",
      "appointments",
      "crm_tasks",
      "conversation_threads",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}"\n  ADD COLUMN "sales_opportunity_id" uuid`,
      );
      expect(migration).toContain(
        `"${table}_sales_opportunity_id_fk" FOREIGN KEY ("sales_opportunity_id") REFERENCES "sales_opportunities"("id") ON DELETE SET NULL`,
      );
      expect(migration).toContain(`${table}_sales_opportunity_idx`);
      expect(migration).not.toContain(
        `ALTER TABLE "${table}"\n  ADD COLUMN "sales_opportunity_id" uuid NOT NULL`,
      );
    }

    expect(
      schema.match(/salesOpportunityId: uuid\("sales_opportunity_id"\)/gu),
    ).toHaveLength(5);
  });

  it("stores only capability and public limiter hashes, never raw bearer or network keys", () => {
    const capabilities = createTableBlock(migration, "quote_capabilities");
    const rateLimits = createTableBlock(migration, "quote_public_rate_limits");

    expect(capabilities).toContain('"token_hash" varchar(64) NOT NULL');
    expect(capabilities).toContain('"recipient_role" text NOT NULL');
    expect(capabilities).toContain('"allowed_actions" text[]');
    expect(capabilities).toContain('"read_expires_at" timestamptz NOT NULL');
    expect(capabilities).toContain('"action_expires_at" timestamptz');
    expect(capabilities).not.toMatch(/"(?:token|share_token|bearer_token)"/iu);
    expect(rateLimits).toContain('"scope_key_hash" varchar(64) NOT NULL');
    expect(rateLimits).not.toMatch(
      /"(?:token|ip|ip_address|network_address|scope_key)"/iu,
    );
    expect(rateLimits).toContain("quote_public_rate_limits_hash_check");
    expect(migration).toContain(
      "quote_public_rate_limits_scope_key_window_key",
    );
  });

  it("keeps recipient data encrypted and persists complete acceptance evidence", () => {
    const deliveries = createTableBlock(migration, "quote_send_deliveries");
    const responses = createTableBlock(migration, "quote_responses");

    expect(deliveries).not.toContain('"recipient_address"');
    expect(deliveries).toContain('"recipient_address_hash" varchar(64)');
    expect(deliveries).toContain('"encrypted_provider_payload" text NOT NULL');
    expect(deliveries).toContain('"external_message_dispatch_id" uuid');
    expect(deliveries).toContain('"conversation_thread_id" uuid');
    for (const evidence of [
      "signer_snapshot",
      "configuration_snapshot",
      "consent_hash",
      "content_hash",
      "issued_pdf_hash",
      "accepted_total_min_cents",
      "accepted_total_max_cents",
      "accepted_deposit_cents",
    ]) {
      expect(responses).toContain(`"${evidence}"`);
    }
    expect(responses).toContain("quote_responses_acceptance_evidence_check");
    expect(responses).toContain('"consent_affirmed" IS TRUE');
    expect(responses).toContain('"accepted_deposit_cents" IS NOT NULL');
  });

  it("keeps legacy pointers and payment/change-request links nullable and constrained", () => {
    for (const column of [
      '"sales_opportunity_id" uuid',
      '"current_version_id" uuid',
      '"published_version_id" uuid',
    ]) {
      expect(migration).toContain(column);
      expect(migration).not.toContain(`${column} NOT NULL`);
    }
    expect(migration).toContain(
      'ALTER TABLE "quote_change_requests"\n  ADD COLUMN "quote_version_id" uuid',
    );
    expect(migration).toContain('ADD COLUMN "request_key_hash" varchar(64)');
    expect(migration).toContain(
      'ALTER TABLE "payment_attempts"\n  ADD COLUMN "quote_id" uuid',
    );
    expect(migration).toContain(
      'ALTER TABLE "payments"\n  ADD COLUMN "quote_id" uuid',
    );
    expect(migration).toContain("payment_attempts_quote_payment_kind_check");
    expect(migration).toContain("payments_quote_payment_kind_check");
  });

  it("version-binds downloads, holds, and bookings without legacy backfill", () => {
    for (const table of [
      "quote_pdf_downloads",
      "appointment_holds",
      "appointments",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}"\n  ADD COLUMN "quote_version_id" uuid`,
      );
      expect(migration).not.toContain(
        `ALTER TABLE "${table}"\n  ADD COLUMN "quote_version_id" uuid NOT NULL`,
      );
    }
    expect(migration).toContain("quote_pdf_downloads_version_idx");
    expect(migration).toContain("appointment_holds_quote_version_idx");
    expect(migration).toContain("appointment_holds_active_quote_version_key");
    expect(migration).toContain("appointments_quote_version_key");
  });

  it("requires collision-safe V2 quote numbers and durable migration review", () => {
    expect(migration).toContain("quotes_v2_quote_number_key");
    expect(migration).toContain(
      '"engine_version" = \'legacy\' OR ("aggregate_state" IS NOT NULL AND "aggregate_revision" IS NOT NULL AND "aggregate_revision" > 0 AND "quote_number" IS NOT NULL)',
    );
    expect(migration).toContain(
      "quote_migration_checkpoints_job_checkpoint_key",
    );
    expect(migration).toContain(
      "quote_migration_review_items_entity_reason_key",
    );
    const review = createTableBlock(migration, "quote_migration_review_items");
    expect(review).not.toMatch(/"(?:token|ip_address|network_address)"/iu);
  });

  it("models replay-safe sending and append-only customer/audit evidence", () => {
    expect(migration).toContain("quote_send_attempts_version_idempotency_key");
    expect(migration).toContain(
      "quote_send_deliveries_attempt_channel_address_key",
    );
    expect(migration).toContain("reconciliation_required");
    expect(migration).toContain("quote_responses_terminal_version_key");
    expect(migration).toContain("quote_responses_version_idempotency_key");
    expect(migration).toContain("quote_version_documents_immutable");
    expect(migration).toContain("quote_responses_immutable");
    expect(migration).toContain("quote_activity_events_immutable");
  });
});
