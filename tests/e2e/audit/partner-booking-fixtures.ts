import crypto, { randomUUID } from "node:crypto";
import postgres from "postgres";
import { assertSafeAuditSeedDatabase } from "./db-safety";

type SqlClient = ReturnType<typeof postgres>;

let cachedSql: SqlClient | null = null;

function sqlClient(): SqlClient {
  if (cachedSql) return cachedSql;
  assertSafeAuditSeedDatabase();
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for partner booking fixtures.");
  }
  cachedSql = postgres(connectionString, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
  });
  return cachedSql;
}

function sessionHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export type PartnerBookingFixture = {
  marker: string;
  contactId: string;
  propertyId: string;
  partnerUserId: string;
  partnerEmail: string;
  partnerPhoneE164: string;
  sessionId: string;
  sessionToken: string;
};

export async function createPartnerBookingFixture(): Promise<PartnerBookingFixture> {
  const sql = sqlClient();
  const marker = `partner-booking-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const phoneSuffix = String(Date.now()).slice(-7);
  const partnerPhoneE164 = `+1470${phoneSuffix}`;
  const partnerEmail = `${marker}@mystos.test`;

  return sql.begin(async (tx) => {
    const contacts = await tx<Array<{ id: string }>>`
      INSERT INTO contacts (
        first_name, last_name, company, email, phone, phone_e164,
        preferred_contact_method, source, partner_status, created_at, updated_at
      ) VALUES (
        'Portal', 'Auditor', ${`Audit Partner ${marker}`}, ${partnerEmail},
        ${partnerPhoneE164}, ${partnerPhoneE164}, 'email', 'team_audit',
        'partner', now(), now()
      ) RETURNING id
    `;
    const contactId = contacts[0]?.id;
    if (!contactId)
      throw new Error("Unable to create partner contact fixture.");

    const properties = await tx<Array<{ id: string }>>`
      INSERT INTO properties (
        contact_id, address_key, address_line1, city, state, postal_code,
        gated, created_at, updated_at
      ) VALUES (
        ${contactId}, ${marker}, ${`100 ${marker} Way`}, 'Roswell', 'GA',
        '30075', false, now(), now()
      ) RETURNING id
    `;
    const propertyId = properties[0]?.id;
    if (!propertyId)
      throw new Error("Unable to create partner property fixture.");
    await tx`
      INSERT INTO contact_properties (contact_id, property_id, relationship)
      VALUES (${contactId}, ${propertyId}, 'partner-managed')
    `;

    const users = await tx<Array<{ id: string }>>`
      INSERT INTO partner_users (
        org_contact_id, email, phone, phone_e164, name, active,
        created_at, updated_at
      ) VALUES (
        ${contactId}, ${partnerEmail}, ${partnerPhoneE164},
        ${partnerPhoneE164}, 'Audit Portal User', true, now(), now()
      ) RETURNING id
    `;
    const partnerUserId = users[0]?.id;
    if (!partnerUserId)
      throw new Error("Unable to create partner user fixture.");

    const sessions = await tx<Array<{ id: string }>>`
      INSERT INTO partner_sessions (
        partner_user_id, session_hash, expires_at, created_at, last_seen_at
      ) VALUES (
        ${partnerUserId}, ${sessionHash(sessionToken)},
        now() + interval '1 day', now(), now()
      ) RETURNING id
    `;
    const sessionId = sessions[0]?.id;
    if (!sessionId)
      throw new Error("Unable to create partner session fixture.");

    const cards = await tx<Array<{ id: string }>>`
      INSERT INTO partner_rate_cards (
        org_contact_id, currency, active, created_at, updated_at
      ) VALUES (${contactId}, 'USD', true, now(), now())
      RETURNING id
    `;
    const rateCardId = cards[0]?.id;
    if (!rateCardId) throw new Error("Unable to create partner rate fixture.");
    await tx`
      INSERT INTO partner_rate_items (
        rate_card_id, service_key, tier_key, label, amount_cents,
        sort_order, created_at
      ) VALUES (
        ${rateCardId}, 'junk-removal', 'quarter', 'Quarter load', 25000,
        10, now()
      )
    `;

    return {
      marker,
      contactId,
      propertyId,
      partnerUserId,
      partnerEmail,
      partnerPhoneE164,
      sessionId,
      sessionToken,
    };
  });
}

export async function findPartnerBookingForFixture(
  fixture: PartnerBookingFixture,
): Promise<{
  bookingId: string;
  appointmentId: string;
  status: string;
  version: number;
  calendarEventId: string | null;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      bookingId: string;
      appointmentId: string;
      status: string;
      version: number;
      calendarEventId: string | null;
    }>
  >`
    SELECT booking.id AS "bookingId", appointment.id AS "appointmentId",
      appointment.status::text AS status, booking.version,
      appointment.calendar_event_id AS "calendarEventId"
    FROM partner_bookings booking
    JOIN appointments appointment ON appointment.id = booking.appointment_id
    WHERE booking.org_contact_id = ${fixture.contactId}
    ORDER BY booking.created_at DESC, booking.id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findPartnerBookingByAppointmentId(
  fixture: PartnerBookingFixture,
  appointmentId: string,
): Promise<{
  bookingId: string;
  appointmentId: string;
  status: string;
  version: number;
  calendarEventId: string | null;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      bookingId: string;
      appointmentId: string;
      status: string;
      version: number;
      calendarEventId: string | null;
    }>
  >`
    SELECT booking.id AS "bookingId", appointment.id AS "appointmentId",
      appointment.status::text AS status, booking.version,
      appointment.calendar_event_id AS "calendarEventId"
    FROM partner_bookings booking
    JOIN appointments appointment ON appointment.id = booking.appointment_id
    WHERE booking.org_contact_id = ${fixture.contactId}
      AND booking.appointment_id = ${appointmentId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getPartnerBookingIntegritySnapshot(
  fixture: PartnerBookingFixture,
  appointmentId: string,
): Promise<{
  bookingCount: number;
  createdAuditCount: number;
  rescheduledAuditCount: number;
  canceledAuditCount: number;
  createdAlertState: string | null;
  canceledAlertState: string | null;
  createdAlertAttempts: number;
  canceledAlertAttempts: number;
  confirmationMessages: number;
  rescheduleMessages: number;
  cancellationMessages: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      bookingCount: number | string;
      createdAuditCount: number | string;
      rescheduledAuditCount: number | string;
      canceledAuditCount: number | string;
      createdAlertState: string | null;
      canceledAlertState: string | null;
      createdAlertAttempts: number | string;
      canceledAlertAttempts: number | string;
      confirmationMessages: number | string;
      rescheduleMessages: number | string;
      cancellationMessages: number | string;
    }>
  >`
    SELECT
      (SELECT count(*) FROM partner_bookings
        WHERE org_contact_id = ${fixture.contactId}) AS "bookingCount",
      (SELECT count(*) FROM audit_logs
        WHERE action = 'partner.booking.created'
          AND entity_id = ${appointmentId}
          AND actor_id = ${fixture.partnerUserId}
          AND session_id = ${fixture.sessionId}
          AND auth_method = 'partner_session'
          AND outcome = 'succeeded') AS "createdAuditCount",
      (SELECT count(*) FROM audit_logs
        WHERE action = 'partner.booking.rescheduled'
          AND entity_id = ${appointmentId}
          AND actor_id = ${fixture.partnerUserId}
          AND session_id = ${fixture.sessionId}
          AND auth_method = 'partner_session'
          AND outcome = 'succeeded') AS "rescheduledAuditCount",
      (SELECT count(*) FROM audit_logs
        WHERE action = 'partner.booking.canceled'
          AND entity_id = ${appointmentId}
          AND actor_id = ${fixture.partnerUserId}
          AND session_id = ${fixture.sessionId}
          AND auth_method = 'partner_session'
          AND outcome = 'succeeded') AS "canceledAuditCount",
      (SELECT state FROM staff_notification_operations
        WHERE appointment_id = ${appointmentId}
          AND kind = 'partner_booking_created' LIMIT 1) AS "createdAlertState",
      (SELECT state FROM staff_notification_operations
        WHERE appointment_id = ${appointmentId}
          AND kind = 'partner_booking_canceled' LIMIT 1) AS "canceledAlertState",
      coalesce((SELECT attempt_count FROM staff_notification_operations
        WHERE appointment_id = ${appointmentId}
          AND kind = 'partner_booking_created' LIMIT 1), 0) AS "createdAlertAttempts",
      coalesce((SELECT attempt_count FROM staff_notification_operations
        WHERE appointment_id = ${appointmentId}
          AND kind = 'partner_booking_canceled' LIMIT 1), 0) AS "canceledAlertAttempts",
      (SELECT count(*) FROM conversation_messages message
        JOIN conversation_threads thread ON thread.id = message.thread_id
        WHERE thread.contact_id = ${fixture.contactId}
          AND message.metadata->>'kind' = 'partner.booking.rescheduled') AS "rescheduleMessages",
      (SELECT count(*) FROM conversation_messages message
        JOIN conversation_threads thread ON thread.id = message.thread_id
        WHERE thread.contact_id = ${fixture.contactId}
          AND message.metadata->>'kind' = 'partner.booking.confirmation') AS "confirmationMessages",
      (SELECT count(*) FROM conversation_messages message
        JOIN conversation_threads thread ON thread.id = message.thread_id
        WHERE thread.contact_id = ${fixture.contactId}
          AND message.metadata->>'kind' = 'partner.booking.canceled') AS "cancellationMessages"
  `;
  const row = rows[0];
  if (!row) throw new Error("Partner booking integrity snapshot unavailable.");
  return {
    bookingCount: Number(row.bookingCount),
    createdAuditCount: Number(row.createdAuditCount),
    rescheduledAuditCount: Number(row.rescheduledAuditCount),
    canceledAuditCount: Number(row.canceledAuditCount),
    createdAlertState: row.createdAlertState,
    canceledAlertState: row.canceledAlertState,
    createdAlertAttempts: Number(row.createdAlertAttempts),
    canceledAlertAttempts: Number(row.canceledAlertAttempts),
    confirmationMessages: Number(row.confirmationMessages),
    rescheduleMessages: Number(row.rescheduleMessages),
    cancellationMessages: Number(row.cancellationMessages),
  };
}

export async function cleanupPartnerBookingFixture(
  fixture: PartnerBookingFixture,
): Promise<void> {
  const sql = sqlClient();
  await sql.begin(async (tx) => {
    // Provider, audit, booking, message, and version evidence is intentionally
    // retained until the disposable shard is recreated. Teardown only revokes
    // credentials and archives/redacts the unique synthetic identities; it
    // must never bypass the same purge guard this journey is validating.
    await tx`
      UPDATE partner_sessions
      SET revoked_at = coalesce(revoked_at, statement_timestamp())
      WHERE partner_user_id = ${fixture.partnerUserId}
    `;
    await tx`
      UPDATE partner_login_tokens
      SET used_at = coalesce(used_at, statement_timestamp())
      WHERE partner_user_id = ${fixture.partnerUserId}
    `;
    await tx`
      UPDATE partner_users
      SET active = false,
          email = ${`archived+${fixture.partnerUserId}@mystos.test`},
          phone = NULL,
          phone_e164 = NULL,
          updated_at = statement_timestamp()
      WHERE id = ${fixture.partnerUserId}
    `;
    await tx`
      UPDATE contacts
      SET email = NULL,
          phone = NULL,
          phone_e164 = NULL,
          deleted_at = statement_timestamp(),
          deleted_by = NULL,
          purge_eligible_at = statement_timestamp() + interval '30 days',
          updated_at = statement_timestamp()
      WHERE id = ${fixture.contactId}
    `;
    await tx`
      UPDATE properties
      SET address_line1 = 'Archived E2E property',
          address_line2 = NULL,
          city = 'Roswell',
          state = 'GA',
          postal_code = '00000',
          updated_at = statement_timestamp()
      WHERE id = ${fixture.propertyId}
    `;
  });
}

export async function closePartnerBookingFixtures(): Promise<void> {
  const sql = cachedSql;
  cachedSql = null;
  if (sql) await sql.end({ timeout: 5 });
}
