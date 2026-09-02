import { randomUUID } from "node:crypto";
import postgres from "postgres";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;
const HASH = "b".repeat(64);

function sslOptions(connectionString: string) {
  return process.env["DATABASE_SSL"] === "true" ||
    /render\.com|sslmode=require/u.test(connectionString)
    ? { ssl: { rejectUnauthorized: false } }
    : {};
}

describeWithDatabase("Partner Quote V2 account evidence binding", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    sql = postgres(connectionString, {
      prepare: false,
      max: 1,
      ...sslOptions(connectionString),
    });
  });

  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  it("rejects Partner account A evidence for account B's canonical quote", async () => {
    const connection = await sql.reserve();
    const accountA = randomUUID();
    const accountB = randomUUID();
    const userA = randomUUID();
    const membershipA = randomUUID();
    const contactB = randomUUID();
    const propertyB = randomUUID();
    const opportunityB = randomUUID();
    const quoteB = randomUUID();
    const versionB = randomUUID();
    const now = new Date("2035-07-01T14:00:00.000Z");
    const expiresAt = new Date("2035-08-01T14:00:00.000Z");

    try {
      await connection`BEGIN`;
      await connection`
        INSERT INTO partner_accounts (
          id, name, normalized_name, status, segment, portal_access_enabled
        ) VALUES
          (${accountA}, 'Account A', ${`account-a-${accountA}`},
           'active_partner', 'commercial_client', true),
          (${accountB}, 'Account B', ${`account-b-${accountB}`},
           'active_partner', 'commercial_client', true)
      `;
      await connection`
        INSERT INTO partner_users (
          id, email, normalized_email, name, active, identity_status,
          email_verified_at
        ) VALUES (
          ${userA}, ${`quote-actor-${userA}@example.test`},
          ${`quote-actor-${userA}@example.test`}, 'Quote actor', true,
          'active', ${now}
        )
      `;
      await connection`
        INSERT INTO partner_account_memberships (
          id, partner_account_id, partner_user_id, role_key, status, persona,
          access_level, accepted_at
        ) VALUES (
          ${membershipA}, ${accountA}, ${userA}, 'billing_approver', 'active',
          'commercial_client', 'account', ${now}
        )
      `;
      await connection`
        INSERT INTO contacts (
          id, first_name, last_name, source, partner_account_id
        ) VALUES (
          ${contactB}, 'Account', 'B contact', 'partner_quote_pg', ${accountB}
        )
      `;
      await connection`
        INSERT INTO properties (
          id, contact_id, address_key, address_line1, city, state, postal_code
        ) VALUES (
          ${propertyB}, ${contactB}, ${`quote-binding:${propertyB}`},
          '10 Tenant Boundary Way', 'Atlanta', 'GA', '30303'
        )
      `;
      await connection`
        INSERT INTO sales_opportunities (
          id, contact_id, property_id, name, status, pipeline_stage, revision
        ) VALUES (
          ${opportunityB}, ${contactB}, ${propertyB}, 'Tenant binding proof',
          'open', 'quoted', 1
        )
      `;
      await connection`
        INSERT INTO quotes (
          id, sales_opportunity_id, partner_account_id, engine_version,
          aggregate_state, aggregate_revision, contact_id, property_id,
          status, services, zone_id, travel_fee, discounts, add_ons_total,
          subtotal, total, deposit_due, deposit_rate, balance_due, line_items,
          quote_number, revision
        ) VALUES (
          ${quoteB}, ${opportunityB}, ${accountB}, 'v2', 'open', 1,
          ${contactB}, ${propertyB}, 'sent', ${connection.json(["custom"])},
          'partner-quote-pg', 0, 0, 0, 100, 100, 0, 0, 100,
          ${connection.json([])}, ${`Q-PARTNER-${randomUUID()}`}, 1
        )
      `;
      await connection`
        INSERT INTO quote_versions (
          id, quote_id, version_number, state, provenance, schema_version,
          document_type, audience, scheduling_mode, currency,
          document_snapshot, party_snapshot, issuer_snapshot, terms_snapshot,
          canonical_render_json, document_schema_hash, pricing_hash,
          template_hash, content_hash, subtotal_min_cents,
          subtotal_max_cents, total_min_cents, total_max_cents, deposit_cents,
          balance_min_cents, balance_max_cents, valid_from, expires_at,
          ready_at, issued_at
        ) VALUES (
          ${versionB}, ${quoteB}, 1, 'issued', 'native', 1, 'fixed_quote',
          'commercial', 'approval_only', 'USD', '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}', ${HASH}, ${HASH}, ${HASH}, ${HASH},
          10000, 10000, 10000, 10000, 0, 10000, 10000, ${now}, ${expiresAt},
          ${now}, ${now}
        )
      `;

      let failure: unknown = null;
      try {
        await connection`
          INSERT INTO quote_responses (
            quote_id, quote_version_id, response_type, source,
            partner_account_id, partner_membership_id, partner_user_id,
            signer_snapshot, selected_option_ids, reason,
            idempotency_key_hash, request_hash, request_metadata,
            responded_at, created_at
          ) VALUES (
            ${quoteB}, ${versionB}, 'declined', 'partner_member', ${accountA},
            ${membershipA}, ${userA}, '{"name":"Quote actor"}'::jsonb,
            ARRAY[]::text[], 'not_authorized', ${HASH}, ${HASH},
            '{"evidenceQuality":"basic"}'::jsonb, ${now}, ${now}
          )
        `;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code).toBe("23503");
      expect((failure as Error).message).toContain(
        "quote_responses_quote_partner_account_fk",
      );
    } finally {
      await connection`ROLLBACK`;
      connection.release();
    }
  });
});
