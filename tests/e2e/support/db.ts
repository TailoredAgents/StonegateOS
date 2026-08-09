import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type LeadDetails = {
  leadId: string;
  contactId: string;
  propertyId: string;
  services: string[];
  contactEmail: string | null;
  contactPhoneE164: string | null;
  appointmentId: string | null;
};

export type QuoteDetails = {
  id: string;
  status: string;
  shareToken: string | null;
  total: number;
  depositDue: number;
  balanceDue: number;
  contactEmail: string | null;
};

export type OutboxEventDetails = {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
};

export type SpeedToLeadCustomerFollowUpDetails = {
  body: string;
  toAddress: string | null;
  deliveryStatus: string;
  isDraft: boolean;
};

export type E2ESeedSummary = {
  contactId: string;
  propertyId: string;
  leadId: string;
  quoteId: string | null;
  appointmentId: string | null;
};

export type E2EContactSummary = {
  contactId: string;
  firstName: string;
  lastName: string;
  phone: string;
  phoneE164: string;
};

type SqlClient = ReturnType<typeof postgres>;

const E2E_COMMISSION_PRINCIPALS = [
  {
    id: "239ca36d-e618-4c5c-a283-b6e5d4ccb704",
    name: "E2E Austin commission principal",
  },
  {
    id: "b45988bb-7417-48c5-af6d-fcdf71088282",
    name: "E2E Devon commission principal",
  },
  {
    id: "5ac5217e-3905-4ea3-bdeb-65456982f5e3",
    name: "E2E Jeffrey commission principal",
  },
] as const;

let cachedClient: SqlClient | null = null;

function getSql(): SqlClient {
  if (cachedClient) {
    return cachedClient;
  }

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for E2E DB helpers.");
  }

  const shouldUseSsl =
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com/.test(connectionString) ||
    /sslmode=require/.test(connectionString);

  cachedClient = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  return cachedClient;
}

export async function findLeadByEmail(
  email: string,
): Promise<LeadDetails | null> {
  const sql = getSql();
  const rows = await sql<
    {
      leadId: string;
      contactId: string;
      propertyId: string;
      servicesRequested: string[] | null;
      contactEmail: string | null;
      contactPhoneE164: string | null;
      appointmentId: string | null;
    }[]
  >`
    SELECT
      leads.id AS "leadId",
      leads.contact_id AS "contactId",
      leads.property_id AS "propertyId",
      leads.services_requested AS "servicesRequested",
      contacts.email AS "contactEmail",
      contacts.phone_e164 AS "contactPhoneE164",
      appointments.id AS "appointmentId"
    FROM leads
    INNER JOIN contacts ON leads.contact_id = contacts.id
    INNER JOIN properties ON leads.property_id = properties.id
    LEFT JOIN appointments ON appointments.lead_id = leads.id
    WHERE contacts.email = ${email}
    ORDER BY leads.created_at DESC
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    leadId: row.leadId,
    contactId: row.contactId,
    propertyId: row.propertyId,
    services: row.servicesRequested ?? [],
    contactEmail: row.contactEmail,
    contactPhoneE164: row.contactPhoneE164,
    appointmentId: row.appointmentId ?? null,
  };
}

export async function getQuoteById(id: string): Promise<QuoteDetails | null> {
  const sql = getSql();
  const rows = await sql<
    {
      id: string;
      status: string;
      shareToken: string | null;
      total: string | number | null;
      depositDue: string | number | null;
      balanceDue: string | number | null;
      contactEmail: string | null;
    }[]
  >`
    SELECT
      quotes.id,
      quotes.status,
      quotes.share_token AS "shareToken",
      quotes.total,
      quotes.deposit_due AS "depositDue",
      quotes.balance_due AS "balanceDue",
      contacts.email AS "contactEmail"
    FROM quotes
    LEFT JOIN contacts ON quotes.contact_id = contacts.id
    WHERE quotes.id = ${id}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    shareToken: row.shareToken,
    total: Number(row.total ?? 0),
    depositDue: Number(row.depositDue ?? 0),
    balanceDue: Number(row.balanceDue ?? 0),
    contactEmail: row.contactEmail,
  };
}

export async function getOutboxEventsByLeadId(
  leadId: string,
): Promise<OutboxEventDetails[]> {
  const sql = getSql();
  const rows = await sql<OutboxEventDetails[]>`
    SELECT
      id,
      type,
      payload,
      created_at AS "createdAt"
    FROM outbox_events
    WHERE payload->>'leadId' = ${leadId}
    ORDER BY created_at DESC
  `;

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdAt: new Date(row.createdAt),
  }));
}

export async function findSpeedToLeadCustomerFollowUpByLeadId(
  leadId: string,
): Promise<SpeedToLeadCustomerFollowUpDetails | null> {
  const sql = getSql();
  const rows = await sql<SpeedToLeadCustomerFollowUpDetails[]>`
    SELECT
      conversation_messages.body,
      conversation_messages.to_address AS "toAddress",
      conversation_messages.delivery_status AS "deliveryStatus",
      COALESCE((conversation_messages.metadata->>'draft')::boolean, false) AS "isDraft"
    FROM conversation_messages
    INNER JOIN conversation_threads
      ON conversation_threads.id = conversation_messages.thread_id
    WHERE conversation_threads.lead_id = ${leadId}
      AND conversation_messages.direction = 'outbound'
      AND conversation_messages.channel = 'sms'
      AND conversation_messages.metadata->>'speedToLead' = 'true'
    ORDER BY conversation_messages.created_at DESC
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function getOutboxEventsByQuoteId(
  quoteId: string,
): Promise<OutboxEventDetails[]> {
  const sql = getSql();
  const rows = await sql<OutboxEventDetails[]>`
    SELECT
      id,
      type,
      payload,
      created_at AS "createdAt"
    FROM outbox_events
    WHERE payload->>'quoteId' = ${quoteId}
    ORDER BY created_at DESC
  `;

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdAt: new Date(row.createdAt),
  }));
}

export async function getLatestE2ESeedSummary(): Promise<E2ESeedSummary | null> {
  const sql = getSql();
  const rows = await sql<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload
    FROM outbox_events
    WHERE type = 'seed.initialized'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const payload = rows[0]?.payload;
  if (!payload) return null;

  const contactId =
    typeof payload["contactId"] === "string" ? payload["contactId"] : null;
  const propertyId =
    typeof payload["propertyId"] === "string" ? payload["propertyId"] : null;
  const leadId =
    typeof payload["leadId"] === "string" ? payload["leadId"] : null;
  if (!contactId || !propertyId || !leadId) return null;

  return {
    contactId,
    propertyId,
    leadId,
    quoteId: typeof payload["quoteId"] === "string" ? payload["quoteId"] : null,
    appointmentId:
      typeof payload["appointmentId"] === "string"
        ? payload["appointmentId"]
        : null,
  };
}

export async function getAppointmentStartAt(
  appointmentId: string,
): Promise<Date | null> {
  const sql = getSql();
  const rows = await sql<{ startAt: Date | string }[]>`
    SELECT start_at AS "startAt"
    FROM appointments
    WHERE id = ${appointmentId}
    LIMIT 1
  `;
  const value = rows[0]?.startAt;
  if (!value) return null;
  const startAt = new Date(value);
  return Number.isFinite(startAt.getTime()) ? startAt : null;
}

export async function ensureE2ECommissionPrincipals(): Promise<void> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO team_members (id, name, active, created_at, updated_at)
      VALUES
        (
          ${E2E_COMMISSION_PRINCIPALS[0].id},
          ${E2E_COMMISSION_PRINCIPALS[0].name},
          true,
          now(),
          now()
        ),
        (
          ${E2E_COMMISSION_PRINCIPALS[1].id},
          ${E2E_COMMISSION_PRINCIPALS[1].name},
          true,
          now(),
          now()
        ),
        (
          ${E2E_COMMISSION_PRINCIPALS[2].id},
          ${E2E_COMMISSION_PRINCIPALS[2].name},
          true,
          now(),
          now()
        )
      ON CONFLICT (id) DO UPDATE SET
        active = true,
        updated_at = now()
    `;

    await tx`
      INSERT INTO commission_settings (
        key,
        timezone,
        payout_weekday,
        payout_hour,
        payout_minute,
        sales_rate_bps,
        marketing_rate_bps,
        crew_pool_rate_bps,
        marketing_member_id,
        created_at,
        updated_at
      ) VALUES (
        'default',
        'America/New_York',
        1,
        12,
        0,
        0,
        1700,
        2000,
        NULL,
        now(),
        now()
      )
      ON CONFLICT (key) DO NOTHING
    `;

    // This helper runs only against the disposable E2E database. Disable any
    // unrelated split rows so every journey proves the same established
    // 12%/5% management allocation rather than inheriting ambient test state.
    await tx`
      UPDATE commission_management_splits
      SET enabled = false, updated_at = now()
      WHERE settings_key = 'default'
        AND member_id NOT IN (
          ${E2E_COMMISSION_PRINCIPALS[0].id},
          ${E2E_COMMISSION_PRINCIPALS[2].id}
        )
    `;

    await tx`
      INSERT INTO commission_management_splits (
        settings_key,
        member_id,
        split_bps,
        enabled,
        created_at,
        updated_at
      ) VALUES
        (
          'default',
          ${E2E_COMMISSION_PRINCIPALS[2].id},
          12000,
          true,
          now(),
          now()
        ),
        (
          'default',
          ${E2E_COMMISSION_PRINCIPALS[0].id},
          5000,
          true,
          now(),
          now()
        )
      ON CONFLICT (settings_key, member_id) DO UPDATE SET
        split_bps = EXCLUDED.split_bps,
        enabled = true,
        updated_at = now()
    `;
  });
}

export async function createE2EDraftPayoutRun(): Promise<string> {
  const sql = getSql();
  const now = Date.now();
  const periodStart = new Date(now - 24 * 60 * 60 * 1000);
  const periodEnd = new Date(now + 24 * 60 * 60 * 1000);
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO payout_runs (
      timezone,
      period_start,
      period_end,
      scheduled_payout_at,
      status
    )
    VALUES (
      'America/New_York',
      ${periodStart},
      ${periodEnd},
      ${periodEnd},
      'draft'
    )
    RETURNING id
  `;
  const payoutRunId = rows[0]?.id;
  if (!payoutRunId) {
    throw new Error("Unable to create an E2E draft payout run.");
  }
  return payoutRunId;
}

export async function createE2EMobileAppointment(input: {
  contactId: string;
  propertyId: string;
  quotedScopeText?: string;
  finalTotalCents?: number | null;
}): Promise<{ appointmentId: string; startAt: Date }> {
  const sql = getSql();
  return sql.begin(async (transaction) => {
    // Fully parallel mobile tests share one seeded contact. Reserve a distinct
    // calendar week atomically so each page renders only its own cloned job.
    await transaction`
      SELECT pg_advisory_xact_lock(
        hashtext('e2e_mobile_appointment'),
        hashtext(${input.contactId})
      )
    `;
    const slotRows = await transaction<{ nextStartAt: Date | string }[]>`
      SELECT
        CURRENT_TIMESTAMP
          + (
              (
                COUNT(*) FILTER (
                  WHERE booking_details->>'e2eMobileClone' = 'true'
                )
                + 1
              ) * INTERVAL '7 days'
            ) AS "nextStartAt"
      FROM appointments
      WHERE contact_id = ${input.contactId}
    `;
    const nextStartAt = slotRows[0]?.nextStartAt;
    if (!nextStartAt) {
      throw new Error("Unable to reserve a mobile E2E calendar week.");
    }
    const startAt = new Date(nextStartAt);
    if (!Number.isFinite(startAt.getTime())) {
      throw new Error("The isolated mobile E2E appointment has no start time.");
    }

    const rows = await transaction<
      { appointmentId: string; startAt: Date | string }[]
    >`
      INSERT INTO appointments (
        contact_id,
        property_id,
        type,
        start_at,
        duration_min,
        status,
        quoted_scope_text,
        final_total_cents,
        booking_details,
        reschedule_token
      )
      VALUES (
        ${input.contactId},
        ${input.propertyId},
        'service',
        ${startAt},
        90,
        'confirmed',
        ${input.quotedScopeText ?? null},
        ${input.finalTotalCents ?? null},
        ${transaction.json({ e2eMobileClone: true })},
        ${randomUUID().replace(/-/gu, "")}
      )
      RETURNING id AS "appointmentId", start_at AS "startAt"
    `;
    const row = rows[0];
    if (!row?.appointmentId) {
      throw new Error("Unable to create an isolated mobile E2E appointment.");
    }
    const persistedStartAt = new Date(row.startAt);
    if (!Number.isFinite(persistedStartAt.getTime())) {
      throw new Error("The isolated mobile E2E appointment has no start time.");
    }
    return { appointmentId: row.appointmentId, startAt: persistedStartAt };
  });
}

export async function getE2EAppointmentCompletion(
  appointmentId: string,
): Promise<{
  status: string;
  finalTotalCents: number | null;
  commissionBaseCents: number[];
} | null> {
  const sql = getSql();
  const appointments = await sql<
    Array<{ status: string; finalTotalCents: number | null }>
  >`
    SELECT
      status,
      final_total_cents AS "finalTotalCents"
    FROM appointments
    WHERE id = ${appointmentId}
    LIMIT 1
  `;
  const appointment = appointments[0];
  if (!appointment) return null;

  const commissions = await sql<Array<{ baseCents: number }>>`
    SELECT base_cents AS "baseCents"
    FROM appointment_commissions
    WHERE appointment_id = ${appointmentId}
    ORDER BY role, member_id
  `;

  return {
    ...appointment,
    commissionBaseCents: commissions.map((row) => row.baseCents),
  };
}

export async function getE2EDraftPayoutReport(
  payoutRunId: string,
  appointmentId: string,
): Promise<{
  status: string;
  reportHtml: string | null;
  reportGeneratedAt: Date | null;
  appointmentCommissionCents: number;
  includesAppointment: boolean;
} | null> {
  const sql = getSql();
  const rows = await sql<
    Array<{
      status: string;
      reportHtml: string | null;
      reportGeneratedAt: Date | string | null;
      appointmentCommissionCents: number | string;
      appointmentCommissionCount: number | string;
    }>
  >`
    SELECT
      payout_runs.status,
      payout_runs.report_html AS "reportHtml",
      payout_runs.report_generated_at AS "reportGeneratedAt",
      COALESCE(SUM(appointment_commissions.amount_cents), 0)
        AS "appointmentCommissionCents",
      COUNT(appointment_commissions.id) AS "appointmentCommissionCount"
    FROM payout_runs
    LEFT JOIN appointments
      ON appointments.id = ${appointmentId}
      AND appointments.status = 'completed'
      AND appointments.completed_at >= payout_runs.period_start
      AND appointments.completed_at < payout_runs.period_end
    LEFT JOIN appointment_commissions
      ON appointment_commissions.appointment_id = appointments.id
    WHERE payout_runs.id = ${payoutRunId}
    GROUP BY payout_runs.id
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    reportHtml: row.reportHtml,
    reportGeneratedAt: row.reportGeneratedAt
      ? new Date(row.reportGeneratedAt)
      : null,
    appointmentCommissionCents: Number(row.appointmentCommissionCents),
    includesAppointment: Number(row.appointmentCommissionCount) > 0,
  };
}

export async function createE2EPhoneOnlyContact(
  label = "Direct Caller",
): Promise<E2EContactSummary> {
  const sql = getSql();
  const suffix = String(Date.now()).slice(-7);
  const phone = `404${suffix}`;
  const phoneE164 = `+1${phone}`;
  const firstName = "E2E";
  const lastName = `${label} ${suffix}`;

  const rows = await sql<{ id: string }[]>`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, source, preferred_contact_method)
    VALUES (${firstName}, ${lastName}, ${phone}, ${phoneE164}, 'inbound_call', 'phone')
    RETURNING id
  `;

  const contactId = rows[0]?.id;
  if (!contactId) throw new Error("Unable to create E2E phone-only contact.");

  return { contactId, firstName, lastName, phone, phoneE164 };
}
