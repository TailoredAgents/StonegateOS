import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

let cachedClient: SqlClient | null = null;
const activeFixtureContactIds = new Set<string>();

function getSql(): SqlClient {
  if (cachedClient) return cachedClient;
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for Quote V2 E2E fixtures.");
  }
  const shouldUseSsl =
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com|sslmode=require/u.test(connectionString);
  cachedClient = postgres(connectionString, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  return cachedClient;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type QuoteV2E2EFixture = {
  token: string;
  contactId: string;
  propertyId: string;
  opportunityId: string;
  quoteId: string;
  versionId: string;
  quoteNumber: string;
  contentHash: string;
  depositCents: number;
  publicPath: string;
};

export async function closeQuoteV2E2EFixtureConnection(): Promise<void> {
  if (!cachedClient) return;
  const client = cachedClient;
  cachedClient = null;
  await client.end({ timeout: 2 });
}

function fixedQuoteDocument(input: {
  quoteNumber: string;
  schedulingMode: "self_schedule" | "staff_followup" | "approval_only";
  depositCents: number;
}) {
  return {
    schemaVersion: 1 as const,
    documentType: "fixed_quote" as const,
    audience: "commercial" as const,
    schedulingMode: input.schedulingMode,
    parties: {
      customerName: "Avery Facilities",
      companyName: "Northstar Commerce",
      attentionName: "Avery Facilities",
      attentionTitle: "Facilities Manager",
      email: "avery.quote-v2@mystos.test",
      phoneE164: "+14045550177",
      billingAddress: "100 Billing Plaza, Atlanta, GA 30303",
      serviceAddress: "200 Service Way, Atlanta, GA 30302",
      projectName: "North warehouse cleanout",
      purchaseOrder: "PO-E2E-2026",
      reference: input.quoteNumber,
      preparerName: "E2E Sales Owner",
    },
    issuer: {
      legalName: "Stonegate Services LLC",
      displayName: "Stonegate",
      address: "Woodstock, GA, US",
      email: "sales@mystos.test",
      phoneE164: "+14045550100",
      website: "https://example.test",
      logoAssetId: null,
      supportMessage: "Questions? Contact the Stonegate team.",
    },
    scope:
      "Remove the listed warehouse material, sweep the service area, and haul all included debris.",
    inclusions: ["Labor", "Hauling", "Disposal"],
    exclusions: ["Hazardous materials"],
    assumptions: ["Clear loading access is available"],
    pricing: {
      documentType: "fixed_quote" as const,
      currency: "USD" as const,
      lineItems: [
        {
          id: "warehouse-cleanout",
          catalogKey: null,
          name: "Commercial cleanout",
          description: "One scoped warehouse cleanout.",
          quantity: 1,
          unit: "project",
          unitPriceMinCents: 125_000,
          unitPriceMaxCents: 125_000,
          optionGroupId: null,
          selectedByDefault: false,
          displayOrder: 0,
        },
      ],
      optionGroups: [],
      adjustments: [],
      deposit:
        input.depositCents > 0
          ? ({
              mode: "fixed" as const,
              amountCents: input.depositCents,
            } as const)
          : ({ mode: "none" as const } as const),
    },
    terms: {
      templateId: null,
      templateVersion: "stonegate-commercial-v1",
      terms: "This proposal covers only the stated scope.",
      paymentTerms: "Balance is due after completion.",
      changeOrderRules: "Changes require written approval before work begins.",
      validityDays: 30,
      consentVersion: "fixed_quote-consent-v1",
    },
    estimatedDurationMinutes: 240,
    serviceZoneId: "zone-core",
    serviceZoneConfirmed: true,
  };
}

/**
 * Creates an exact issued V2 proposal without relying on email delivery. The
 * disposable E2E database is reset by the harness, so immutable evidence is
 * deliberately left intact for failed-test inspection.
 */
export async function createQuoteV2E2EFixture(
  input: {
    schedulingMode?: "self_schedule" | "staff_followup" | "approval_only";
    depositCents?: number;
    issuedAt?: Date;
    expiresAt?: Date;
  } = {},
): Promise<QuoteV2E2EFixture> {
  const sql = getSql();
  const contactId = randomUUID();
  const propertyId = randomUUID();
  const quoteId = randomUUID();
  const versionId = randomUUID();
  const opportunityId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const phoneSuffix = String(randomBytes(4).readUInt32BE() % 10_000).padStart(
    4,
    "0",
  );
  const quoteNumber = `Q-E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
  const depositCents = input.depositCents ?? 0;
  if (
    !Number.isSafeInteger(depositCents) ||
    depositCents < 0 ||
    depositCents > 125_000
  ) {
    throw new Error(
      "Quote V2 E2E deposit must be whole cents within the total.",
    );
  }
  const document = fixedQuoteDocument({
    quoteNumber,
    schedulingMode: input.schedulingMode ?? "self_schedule",
    depositCents,
  });
  const issuedAt = input.issuedAt ?? new Date(Date.now() - 60_000);
  const readyAt = new Date(issuedAt.getTime() - 60_000);
  const expiresAt =
    input.expiresAt ?? new Date(issuedAt.getTime() + 30 * 24 * 60 * 60_000);
  const readExpiresAt = new Date(
    Math.max(Date.now(), expiresAt.getTime()) + 365 * 24 * 60 * 60_000,
  );
  const balanceCents = 125_000 - depositCents;
  const canonical = JSON.stringify({ document, quoteNumber, versionNumber: 1 });
  const contentHash = sha256(canonical);
  const actions = [
    "view",
    "pdf",
    "change",
    "refresh",
    "accept",
    "decline",
    "availability",
    "hold",
    "checkout",
    "book",
  ];

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO contacts (
        id, first_name, last_name, company, email, phone, phone_e164,
        preferred_contact_method, source
      ) VALUES (
        ${contactId}, 'Avery', 'Facilities', 'Northstar Commerce',
        ${`quote-v2-e2e-${contactId}@mystos.test`},
        ${`404555${phoneSuffix}`},
        ${`+1404555${phoneSuffix}`},
        'email', 'playwright_quote_v2'
      )
    `;
    await tx`
      INSERT INTO properties (
        id, contact_id, address_key, address_line1, city, state, postal_code
      ) VALUES (
        ${propertyId}, ${contactId}, ${`quote-v2-e2e:${propertyId}`},
        '200 Service Way', 'Atlanta', 'GA', '30302'
      )
    `;
    await tx`
      INSERT INTO sales_opportunities (
        id, contact_id, property_id, name, status, pipeline_stage, currency,
        estimated_value_cents, revision, metadata
      ) VALUES (
        ${opportunityId}, ${contactId}, ${propertyId},
        ${document.parties.projectName}, 'open', 'proposal_issued', 'USD',
        125000, 1, ${tx.json({ fixture: "quote-v2-e2e" })}
      )
    `;
    await tx`
      INSERT INTO quotes (
        id, sales_opportunity_id, engine_version, aggregate_state,
        aggregate_revision, contact_id, property_id, status, services, zone_id,
        travel_fee, discounts, add_ons_total, subtotal, total, deposit_due,
        deposit_rate, balance_due, line_items, quote_number,
        job_duration_minutes, client_scope, revision, sent_at, expires_at
      ) VALUES (
        ${quoteId}, ${opportunityId}, 'v2', 'open', 1,
        ${contactId}, ${propertyId}, 'sent',
        ${tx.json(["commercial_cleanout"])}, 'zone-core', 0, 0, 0,
        1250, 1250, ${depositCents / 100}, 0, ${balanceCents / 100},
        ${tx.json([{ id: "warehouse-cleanout", label: "Commercial cleanout", amount: 1250 }])},
        ${quoteNumber}, 240, ${document.scope}, 1, ${issuedAt}, ${expiresAt}
      )
    `;
    await tx`
      INSERT INTO quote_versions (
        id, quote_id, version_number, draft_revision, state, provenance,
        schema_version, document_type, audience, scheduling_mode, currency,
        document_snapshot, party_snapshot, issuer_snapshot, terms_snapshot,
        canonical_render_json, document_schema_hash, pricing_hash,
        template_hash, content_hash, client_name, client_company, client_email,
        client_phone, project_name, purchase_order_number, reference_number,
        selected_option_ids, subtotal_min_cents, subtotal_max_cents,
        discount_min_cents, discount_max_cents, fee_min_cents, fee_max_cents,
        total_min_cents, total_max_cents, deposit_cents, balance_min_cents,
        balance_max_cents, scope, assumptions, exclusions, terms, payment_terms,
        valid_from, expires_at, ready_at, issued_at, first_sent_at
      ) VALUES (
        ${versionId}, ${quoteId}, 1, 1, 'issued', 'native', 1,
        'fixed_quote', 'commercial', ${document.schedulingMode}, 'USD',
        ${tx.json(document)}, ${tx.json(document.parties)},
        ${tx.json(document.issuer)}, ${tx.json(document.terms)},
        ${canonical}, ${sha256("document-schema-v1")}, ${sha256("pricing-v1")},
        ${sha256("template-v1")}, ${contentHash},
        ${document.parties.customerName}, ${document.parties.companyName},
        ${document.parties.email}, ${document.parties.phoneE164},
        ${document.parties.projectName}, ${document.parties.purchaseOrder},
        ${document.parties.reference}, ${tx.array([])}::text[],
        125000, 125000, 0, 0, 0, 0, 125000, 125000,
        ${depositCents}, ${balanceCents}, ${balanceCents},
        ${document.scope}, ${document.assumptions.join("\n")},
        ${document.exclusions.join("\n")}, ${document.terms.terms},
        ${document.terms.paymentTerms}, ${issuedAt}, ${expiresAt}, ${readyAt},
        ${issuedAt}, ${issuedAt}
      )
    `;
    await tx`
      UPDATE quotes
      SET current_version_id = ${versionId}, published_version_id = ${versionId}
      WHERE id = ${quoteId}
    `;
    await tx`
      INSERT INTO quote_capabilities (
        quote_id, quote_version_id, recipient_role, recipient_address_hash,
        allowed_actions, token_hash, status, read_expires_at,
        action_expires_at, issued_at
      ) VALUES (
        ${quoteId}, ${versionId}, 'signer',
        ${sha256(`recipient:${quoteId}`)}, ${tx.array(actions)}::text[],
        ${sha256(token)}, 'active', ${readExpiresAt}, ${expiresAt}, ${issuedAt}
      )
    `;
  });
  activeFixtureContactIds.add(contactId);

  return {
    token,
    contactId,
    propertyId,
    opportunityId,
    quoteId,
    versionId,
    quoteNumber,
    contentHash,
    depositCents,
    publicPath: `/quote/${encodeURIComponent(token)}`,
  };
}

/** Soft-deletes fixture contacts while retaining immutable quote evidence. */
export async function archiveQuoteV2E2EFixtures(): Promise<void> {
  if (activeFixtureContactIds.size === 0) return;
  const sql = getSql();
  const contactIds = [...activeFixtureContactIds];
  const archivedAt = new Date();
  await sql.begin(async (tx) => {
    await tx`
      UPDATE quote_capabilities AS capability
      SET status = 'revoked',
          revoked_at = ${archivedAt},
          revoked_by_team_member_id = NULL,
          revocation_reason = 'contact_inactive',
          updated_at = ${archivedAt}
      WHERE capability.status <> 'revoked'
        AND EXISTS (
          SELECT 1
          FROM quotes AS fixture_quote
          WHERE fixture_quote.id = capability.quote_id
            AND fixture_quote.contact_id IN ${tx(contactIds)}
        )
    `;
    await tx`
      UPDATE contacts
      SET email = NULL,
          phone = NULL,
          phone_e164 = NULL,
          deleted_at = ${archivedAt},
          deleted_by = NULL,
          purge_eligible_at = ${archivedAt} + interval '30 days',
          updated_at = ${archivedAt}
      WHERE id IN ${tx(contactIds)} AND deleted_at IS NULL
    `;
  });
  for (const id of contactIds) activeFixtureContactIds.delete(id);
}

export async function requestQuoteV2E2EFixtureChanges(
  fixture: QuoteV2E2EFixture,
): Promise<void> {
  const sql = getSql();
  const taskId = randomUUID();
  const requestedAt = new Date("2030-01-15T14:00:00.000Z");
  const dueAt = new Date("2030-01-15T18:00:00.000Z");
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO crm_tasks (
        id, sales_opportunity_id, contact_id, title, due_at, assigned_to,
        status, notes, created_at, updated_at
      ) VALUES (
        ${taskId}, ${fixture.opportunityId}, ${fixture.contactId},
        'Review professional quote change request', ${dueAt}, 'Sales queue',
        'open', 'Deterministic Quote V2 visual fixture.', ${requestedAt},
        ${requestedAt}
      )
    `;
    await tx`
      INSERT INTO quote_change_requests (
        quote_id, quote_version_id, expected_revision, request_key_hash,
        status, owner_task_id, due_at, reason, message, created_at
      ) VALUES (
        ${fixture.quoteId}, ${fixture.versionId}, 1,
        ${sha256(`visual-change:${fixture.versionId}`)}, 'open', ${taskId},
        ${dueAt}, 'scope',
        'Please revise the loading-access assumption before approval.',
        ${requestedAt}
      )
    `;
  });
}

export async function acceptQuoteV2E2EFixture(
  fixture: QuoteV2E2EFixture,
): Promise<string> {
  const sql = getSql();
  const responseId = randomUUID();
  const acceptedAt = new Date("2030-01-16T15:30:00.000Z");
  const configurationHash = sha256(`visual-configuration:${fixture.versionId}`);
  const consentHash = sha256(`visual-consent:${fixture.versionId}`);
  const issuedPdfHash = sha256(`visual-issued-pdf:${fixture.versionId}`);
  const balanceCents = 125_000 - fixture.depositCents;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO quote_responses (
        id, quote_id, quote_version_id, response_type, source,
        signer_snapshot, configuration_snapshot, selected_option_ids,
        consent_text, consent_version, consent_affirmed, configuration_hash,
        consent_hash, content_hash, issued_pdf_hash,
        accepted_total_min_cents, accepted_total_max_cents,
        accepted_deposit_cents, accepted_balance_min_cents,
        accepted_balance_max_cents, request_metadata, responded_at, created_at
      ) VALUES (
        ${responseId}, ${fixture.quoteId}, ${fixture.versionId}, 'accepted',
        'customer',
        ${tx.json({
          name: "Avery Facilities",
          title: "Facilities Manager",
          company: "Northstar Commerce",
          authorityAffirmed: true,
        })},
        ${tx.json({
          documentType: "fixed_quote",
          schedulingMode: "staff_followup",
          selectedOptionIds: [],
          requestedStartAt: null,
          holdId: null,
          totals: {
            totalMinCents: 125_000,
            totalMaxCents: 125_000,
            depositCents: fixture.depositCents,
            balanceMinCents: balanceCents,
            balanceMaxCents: balanceCents,
          },
        })},
        ${tx.array([])}::text[],
        'I approve this exact proposal and its terms.',
        'fixed_quote-consent-v1', true, ${configurationHash}, ${consentHash},
        ${fixture.contentHash}, ${issuedPdfHash}, 125000, 125000,
        ${fixture.depositCents}, ${balanceCents}, ${balanceCents},
        ${tx.json({ fixture: "quote-v2-visual" })}, ${acceptedAt}, ${acceptedAt}
      )
    `;
    await tx`
      UPDATE quote_versions
      SET state = 'accepted', updated_at = ${acceptedAt}
      WHERE id = ${fixture.versionId} AND quote_id = ${fixture.quoteId}
    `;
    await tx`
      UPDATE quotes
      SET aggregate_state = 'accepted', aggregate_revision = aggregate_revision + 1,
          status = 'accepted', decision_at = ${acceptedAt}, updated_at = ${acceptedAt}
      WHERE id = ${fixture.quoteId}
    `;
    await tx`
      UPDATE sales_opportunities
      SET status = 'approved', pipeline_stage = 'approved',
          revision = revision + 1, updated_at = ${acceptedAt}
      WHERE id = ${fixture.opportunityId}
    `;
  });
  return responseId;
}

export async function declineQuoteV2E2EFixture(
  fixture: QuoteV2E2EFixture,
): Promise<string> {
  const sql = getSql();
  const responseId = randomUUID();
  const declinedAt = new Date("2030-01-16T15:30:00.000Z");

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO quote_responses (
        id, quote_id, quote_version_id, response_type, source,
        signer_snapshot, reason, message, request_metadata, responded_at,
        created_at
      ) VALUES (
        ${responseId}, ${fixture.quoteId}, ${fixture.versionId}, 'declined',
        'customer', ${tx.json({ name: "Avery Facilities" })}, 'timing',
        'The project is not moving forward this quarter.',
        ${tx.json({ fixture: "quote-v2-visual" })}, ${declinedAt}, ${declinedAt}
      )
    `;
    await tx`
      UPDATE quote_versions
      SET state = 'declined', updated_at = ${declinedAt}
      WHERE id = ${fixture.versionId} AND quote_id = ${fixture.quoteId}
        AND state = 'issued'
    `;
    await tx`
      UPDATE quotes
      SET aggregate_state = 'declined',
          aggregate_revision = aggregate_revision + 1,
          status = 'declined', decision_at = ${declinedAt},
          decision_notes = 'timing\nThe project is not moving forward this quarter.',
          revision = revision + 1, updated_at = ${declinedAt}
      WHERE id = ${fixture.quoteId} AND aggregate_state = 'open'
    `;
    await tx`
      UPDATE quote_capabilities
      SET action_expires_at = NULL, updated_at = ${declinedAt}
      WHERE quote_id = ${fixture.quoteId}
        AND quote_version_id = ${fixture.versionId}
        AND status <> 'revoked'
    `;
    await tx`
      UPDATE sales_opportunities
      SET status = 'lost', pipeline_stage = 'lost',
          revision = revision + 1, closed_at = ${declinedAt},
          updated_at = ${declinedAt}
      WHERE id = ${fixture.opportunityId} AND status = 'open'
    `;
  });
  return responseId;
}

export async function bookQuoteV2E2EFixture(
  fixture: QuoteV2E2EFixture,
): Promise<string> {
  const sql = getSql();
  const responseId = await acceptQuoteV2E2EFixture(fixture);
  const appointmentId = randomUUID();
  const bookedAt = new Date("2030-01-16T15:35:00.000Z");
  const startAt = new Date("2030-02-01T14:00:00.000Z");
  const configurationHash = sha256(`visual-configuration:${fixture.versionId}`);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO appointments (
        id, quote_version_id, quote_response_id, sales_opportunity_id,
        contact_id, property_id, type, start_at, scheduling_timezone,
        duration_min, status,
        quoted_total_cents, quoted_total_max_cents, quote_configuration_hash,
        quote_content_hash, quoted_scope_text, reschedule_token,
        created_at, updated_at
      ) VALUES (
        ${appointmentId}, ${fixture.versionId}, ${responseId},
        ${fixture.opportunityId}, ${fixture.contactId}, ${fixture.propertyId},
        'junk_removal', ${startAt}, 'America/New_York', 240, 'confirmed',
        125000, 125000,
        ${configurationHash}, ${fixture.contentHash},
        'Remove the listed warehouse material, sweep the service area, and haul all included debris.',
        ${sha256(`visual-reschedule:${appointmentId}`)}, ${bookedAt}, ${bookedAt}
      )
    `;
    await tx`
      UPDATE quote_responses
      SET appointment_id = ${appointmentId}
      WHERE id = ${responseId} AND quote_id = ${fixture.quoteId}
        AND quote_version_id = ${fixture.versionId}
        AND response_type = 'accepted' AND appointment_id IS NULL
    `;
    await tx`
      UPDATE quotes
      SET accepted_appointment_id = ${appointmentId},
          aggregate_revision = aggregate_revision + 1, updated_at = ${bookedAt}
      WHERE id = ${fixture.quoteId}
    `;
    await tx`
      UPDATE sales_opportunities
      SET status = 'won', pipeline_stage = 'won', revision = revision + 1,
          closed_at = ${bookedAt}, updated_at = ${bookedAt}
      WHERE id = ${fixture.opportunityId}
    `;
  });
  return appointmentId;
}

/** Publishes a second immutable revision while leaving the browser's link on V1. */
export async function supersedeQuoteV2E2EFixture(
  fixture: QuoteV2E2EFixture,
): Promise<string> {
  const sql = getSql();
  const nextVersionId = randomUUID();
  const supersededAt = new Date();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO quote_versions (
        id, quote_id, version_number, draft_revision, supersedes_version_id,
        state, provenance, schema_version, document_type, audience,
        scheduling_mode, currency, document_snapshot, party_snapshot,
        issuer_snapshot, terms_snapshot, canonical_render_json,
        document_schema_hash, pricing_hash, template_hash, content_hash,
        client_name, client_company, client_email, client_phone, project_name,
        purchase_order_number, reference_number, selected_option_ids,
        subtotal_min_cents, subtotal_max_cents, discount_min_cents,
        discount_max_cents, fee_min_cents, fee_max_cents, total_min_cents,
        total_max_cents, deposit_cents, balance_min_cents, balance_max_cents,
        scope, assumptions, exclusions, terms, payment_terms, valid_from,
        expires_at, ready_at, issued_at, first_sent_at
      )
      SELECT
        ${nextVersionId}, quote_id, 2, 1, id, 'issued', provenance,
        schema_version, document_type, audience, scheduling_mode, currency,
        document_snapshot, party_snapshot, issuer_snapshot, terms_snapshot,
        canonical_render_json, document_schema_hash, pricing_hash, template_hash,
        content_hash, client_name, client_company, client_email, client_phone,
        project_name, purchase_order_number, reference_number,
        selected_option_ids, subtotal_min_cents, subtotal_max_cents,
        discount_min_cents, discount_max_cents, fee_min_cents, fee_max_cents,
        total_min_cents, total_max_cents, deposit_cents, balance_min_cents,
        balance_max_cents, scope, assumptions, exclusions, terms, payment_terms,
        ${supersededAt}, expires_at, ${supersededAt}, ${supersededAt},
        ${supersededAt}
      FROM quote_versions
      WHERE id = ${fixture.versionId} AND quote_id = ${fixture.quoteId}
    `;
    await tx`
      UPDATE quote_versions
      SET state = 'superseded', superseded_at = ${supersededAt}, updated_at = ${supersededAt}
      WHERE id = ${fixture.versionId} AND quote_id = ${fixture.quoteId}
    `;
    await tx`
      UPDATE quotes
      SET current_version_id = ${nextVersionId}, published_version_id = ${nextVersionId},
          aggregate_revision = aggregate_revision + 1, updated_at = ${supersededAt}
      WHERE id = ${fixture.quoteId}
    `;
  });
  return nextVersionId;
}

/** Issues an actionable V2 revision while retaining the original V1 link. */
export async function issueQuoteV2E2EFixtureRevision(
  fixture: QuoteV2E2EFixture,
): Promise<QuoteV2E2EFixture> {
  const sql = getSql();
  const versionId = await supersedeQuoteV2E2EFixture(fixture);
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const [version] = await sql<
    Array<{ expires_at: Date }>
  >`SELECT expires_at FROM quote_versions WHERE id = ${versionId}`;
  if (!version?.expires_at) {
    throw new Error("Quote V2 E2E revision was not persisted.");
  }
  const readExpiresAt = new Date(
    Math.max(Date.now(), version.expires_at.getTime()) + 365 * 24 * 60 * 60_000,
  );
  const actions = [
    "view",
    "pdf",
    "change",
    "refresh",
    "accept",
    "decline",
    "availability",
    "hold",
    "checkout",
    "book",
  ];
  await sql`
    INSERT INTO quote_capabilities (
      quote_id, quote_version_id, recipient_role, recipient_address_hash,
      allowed_actions, token_hash, status, read_expires_at,
      action_expires_at, issued_at
    ) VALUES (
      ${fixture.quoteId}, ${versionId}, 'signer',
      ${sha256(`recipient:${fixture.quoteId}:v2`)},
      ${sql.array(actions)}::text[], ${sha256(token)}, 'active',
      ${readExpiresAt}, ${version.expires_at}, ${now}
    )
  `;
  return {
    ...fixture,
    token,
    versionId,
    publicPath: `/quote/${encodeURIComponent(token)}`,
  };
}
