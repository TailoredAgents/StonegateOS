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

export type E2ESeedSummary = {
  contactId: string;
  propertyId: string;
  leadId: string;
  quoteId: string | null;
  appointmentId: string | null;
};

type SqlClient = ReturnType<typeof postgres>;

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
    ...(shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {})
  });

  return cachedClient;
}

export async function findLeadByEmail(email: string): Promise<LeadDetails | null> {
  const sql = getSql();
  const rows = await sql<{
    leadId: string;
    contactId: string;
    propertyId: string;
    servicesRequested: string[] | null;
    contactEmail: string | null;
    contactPhoneE164: string | null;
    appointmentId: string | null;
  }[]>`
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
    appointmentId: row.appointmentId ?? null
  };
}

export async function getQuoteById(id: string): Promise<QuoteDetails | null> {
  const sql = getSql();
  const rows = await sql<{
    id: string;
    status: string;
    shareToken: string | null;
    total: string | number | null;
    depositDue: string | number | null;
    balanceDue: string | number | null;
    contactEmail: string | null;
  }[]>`
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
    contactEmail: row.contactEmail
  };
}

export async function getOutboxEventsByLeadId(leadId: string): Promise<OutboxEventDetails[]> {
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
    createdAt: new Date(row.createdAt)
  }));
}

export async function getOutboxEventsByQuoteId(quoteId: string): Promise<OutboxEventDetails[]> {
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
    createdAt: new Date(row.createdAt)
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

  const contactId = typeof payload["contactId"] === "string" ? payload["contactId"] : null;
  const propertyId = typeof payload["propertyId"] === "string" ? payload["propertyId"] : null;
  const leadId = typeof payload["leadId"] === "string" ? payload["leadId"] : null;
  if (!contactId || !propertyId || !leadId) return null;

  return {
    contactId,
    propertyId,
    leadId,
    quoteId: typeof payload["quoteId"] === "string" ? payload["quoteId"] : null,
    appointmentId: typeof payload["appointmentId"] === "string" ? payload["appointmentId"] : null
  };
}
