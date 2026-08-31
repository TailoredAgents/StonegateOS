import { randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import postgres from "postgres";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

const HASH = "a".repeat(64);
jest.setTimeout(30_000);

function sslOptions(connectionString: string) {
  return process.env["DATABASE_SSL"] === "true" ||
    /render\.com|sslmode=require/u.test(connectionString)
    ? { ssl: { rejectUnauthorized: false } }
    : {};
}

describeWithDatabase("Quote V2 response appointment binding trigger", () => {
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

  it("permits one exact accepted-response link and rejects every other mutation", async () => {
    const connection = await sql.reserve();
    const contactId = randomUUID();
    const propertyId = randomUUID();
    const otherContactId = randomUUID();
    const otherPropertyId = randomUUID();
    const opportunityId = randomUUID();
    const quoteId = randomUUID();
    const versionIds = [randomUUID(), randomUUID(), randomUUID()];
    const responseIds = [randomUUID(), randomUUID(), randomUUID()];
    const appointmentIds = [randomUUID(), randomUUID(), randomUUID()];
    const now = new Date("2031-01-15T15:00:00.000Z");
    const expiresAt = new Date("2031-02-15T15:00:00.000Z");

    const expectImmutableRejection = async (
      savepoint: string,
      mutation: () => Promise<unknown>,
    ) => {
      await connection.unsafe(`SAVEPOINT ${savepoint}`);
      let failure: unknown = null;
      try {
        await mutation();
      } catch (error) {
        failure = error;
      }
      await connection.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("immutable evidence");
    };

    try {
      await connection`BEGIN`;
      await connection`
        INSERT INTO contacts (id, first_name, last_name, source)
        VALUES
          (${contactId}, 'Binding', 'Proof', 'quote_v2_integration'),
          (${otherContactId}, 'Wrong', 'Target', 'quote_v2_integration')
      `;
      await connection`
        INSERT INTO properties (
          id, contact_id, address_key, address_line1, city, state, postal_code
        ) VALUES (
          ${propertyId}, ${contactId}, ${`binding:${propertyId}`},
          '100 Binding Way', 'Atlanta', 'GA', '30303'
        )
      `;
      await connection`
        INSERT INTO properties (
          id, contact_id, address_key, address_line1, city, state, postal_code
        ) VALUES (
          ${otherPropertyId}, ${otherContactId},
          ${`binding:${otherPropertyId}`}, '999 Wrong Target Road',
          'Atlanta', 'GA', '30303'
        )
      `;
      await connection`
        INSERT INTO sales_opportunities (
          id, contact_id, property_id, name, status, pipeline_stage, revision
        ) VALUES (
          ${opportunityId}, ${contactId}, ${propertyId},
          'Response appointment binding proof', 'approved', 'approved', 1
        )
      `;
      await connection`
        INSERT INTO quotes (
          id, sales_opportunity_id, engine_version, aggregate_state,
          aggregate_revision, contact_id, property_id, status, services,
          zone_id, travel_fee, discounts, add_ons_total, subtotal, total,
          deposit_due, deposit_rate, balance_due, line_items, quote_number,
          revision
        ) VALUES (
          ${quoteId}, ${opportunityId}, 'v2', 'accepted', 1,
          ${contactId}, ${propertyId}, 'accepted', ${connection.json(["custom"])},
          'zone-binding', 0, 0, 0, 100, 100, 0, 0, 100,
          ${connection.json([])}, ${`Q-BIND-${randomUUID()}`}, 1
        )
      `;
      for (const [index, versionId] of versionIds.entries()) {
        await connection`
          INSERT INTO quote_versions (
            id, quote_id, version_number, state, provenance, schema_version,
            document_type, audience, scheduling_mode, currency,
            document_snapshot, party_snapshot, issuer_snapshot, terms_snapshot,
            canonical_render_json, document_schema_hash, pricing_hash,
            template_hash, content_hash, subtotal_min_cents,
            subtotal_max_cents, total_min_cents, total_max_cents,
            deposit_cents, balance_min_cents, balance_max_cents, valid_from,
            expires_at, ready_at, issued_at
          ) VALUES (
            ${versionId}, ${quoteId}, ${index + 1}, 'issued', 'native', 1,
            'fixed_quote', 'commercial', 'self_schedule', 'USD',
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}',
            ${HASH}, ${HASH}, ${HASH}, ${HASH}, 10000, 10000, 10000, 10000,
            0, 10000, 10000, ${now}, ${expiresAt}, ${now}, ${now}
          )
        `;
      }
      for (const index of [0, 1]) {
        await connection`
          INSERT INTO quote_responses (
            id, quote_id, quote_version_id, response_type, source,
            signer_snapshot, configuration_snapshot, selected_option_ids,
            consent_text, consent_version, consent_affirmed,
            configuration_hash, consent_hash, content_hash, issued_pdf_hash,
            accepted_total_min_cents, accepted_total_max_cents,
            accepted_deposit_cents, accepted_balance_min_cents,
            accepted_balance_max_cents, responded_at, created_at
          ) VALUES (
            ${responseIds[index]}, ${quoteId}, ${versionIds[index]},
            'accepted', 'customer', '{"name":"Binding Proof"}'::jsonb,
            '{}'::jsonb, ARRAY[]::text[], 'Exact consent', 'binding-v1', true,
            ${HASH}, ${HASH}, ${HASH}, ${HASH}, 10000, 10000, 0, 10000,
            10000, ${now}, ${now}
          )
        `;
      }
      await connection`
        INSERT INTO quote_responses (
          id, quote_id, quote_version_id, response_type, source,
          signer_snapshot, selected_option_ids, responded_at, created_at
        ) VALUES (
          ${responseIds[2]}, ${quoteId}, ${versionIds[2]}, 'declined',
          'customer', '{"name":"Binding Proof"}'::jsonb,
          ARRAY[]::text[], ${now}, ${now}
        )
      `;
      for (const index of [0, 1, 2]) {
        const appointmentContactId = index === 1 ? otherContactId : contactId;
        const appointmentPropertyId =
          index === 1 ? otherPropertyId : propertyId;
        await connection`
          INSERT INTO appointments (
            id, quote_version_id, quote_response_id, sales_opportunity_id,
            contact_id, property_id, type, start_at, scheduling_timezone,
            duration_min, status, quoted_total_cents,
            quoted_total_max_cents, quote_configuration_hash,
            quote_content_hash, quoted_scope_text, reschedule_token,
            created_at, updated_at
          ) VALUES (
            ${appointmentIds[index]}, ${versionIds[index]},
            ${responseIds[index]}, ${opportunityId}, ${appointmentContactId},
            ${appointmentPropertyId}, 'junk_removal',
            ${new Date(now.getTime() + (index + 1) * 86_400_000)},
            'America/New_York', 120, 'confirmed', 10000, 10000,
            ${HASH}, ${HASH}, 'Exact accepted scope', ${randomUUID()},
            ${now}, ${now}
          )
        `;
      }

      await expectImmutableRejection(
        "wrong_binding",
        () =>
          connection`
          UPDATE quote_responses SET appointment_id = ${appointmentIds[1]}
          WHERE id = ${responseIds[0]}
        `,
      );
      await expectImmutableRejection(
        "nonaccepted_binding",
        () =>
          connection`
          UPDATE quote_responses SET appointment_id = ${appointmentIds[2]}
          WHERE id = ${responseIds[2]}
        `,
      );

      const linked = await connection<Array<{ id: string }>>`
        UPDATE quote_responses SET appointment_id = ${appointmentIds[0]}
        WHERE id = ${responseIds[0]} AND appointment_id IS NULL
        RETURNING id
      `;
      expect(linked).toEqual([{ id: responseIds[0] }]);

      await expectImmutableRejection(
        "second_link",
        () =>
          connection`
          UPDATE quote_responses SET appointment_id = ${appointmentIds[1]}
          WHERE id = ${responseIds[0]}
        `,
      );
      await expectImmutableRejection(
        "unlink",
        () =>
          connection`
          UPDATE quote_responses SET appointment_id = NULL
          WHERE id = ${responseIds[0]}
        `,
      );
      await expectImmutableRejection(
        "evidence_change",
        () =>
          connection`
          UPDATE quote_responses SET message = 'mutated'
          WHERE id = ${responseIds[0]}
        `,
      );
      await expectImmutableRejection(
        "delete_response",
        () =>
          connection`DELETE FROM quote_responses WHERE id = ${responseIds[0]}`,
      );
    } finally {
      await connection`ROLLBACK`;
      connection.release();
    }
  });
});
