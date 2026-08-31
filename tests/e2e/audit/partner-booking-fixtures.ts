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
  partnerAccountId: string;
  membershipId: string;
  locationId: string;
  partnerUserId: string;
  partnerEmail: string;
  partnerPhoneE164: string;
  sessionId: string;
  sessionToken: string;
};

export type PartnerApprovalFixture = Readonly<{
  requester: PartnerBookingFixture;
  approverUserId: string;
  approverMembershipId: string;
  approverSessionId: string;
  approverSessionToken: string;
  approvalRuleId: string;
}>;

export async function createPartnerBookingFixture(): Promise<PartnerBookingFixture> {
  const sql = sqlClient();
  const marker = `partner-booking-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const phoneSuffix = String(Date.now()).slice(-7);
  const partnerPhoneE164 = `+1470${phoneSuffix}`;
  const partnerEmail = `${marker}@mystos.test`;
  const calendarId =
    process.env["GOOGLE_CALENDAR_ID"] ?? "google-calendar-e2e-calendar";

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

    const accounts = await tx<Array<{ id: string }>>`
      INSERT INTO partner_accounts (
        name, normalized_name, segment, status, source, portal_contact_id,
        portal_access_enabled, created_at, updated_at
      ) VALUES (
        ${`Audit Partner ${marker}`}, ${`audit partner ${marker}`},
        'commercial_client', 'portal_partner', 'team_audit', ${contactId},
        true, now(), now()
      ) RETURNING id
    `;
    const partnerAccountId = accounts[0]?.id;
    if (!partnerAccountId)
      throw new Error("Unable to create partner account fixture.");
    await tx`
      UPDATE contacts
      SET partner_account_id = ${partnerAccountId}, updated_at = now()
      WHERE id = ${contactId}
    `;

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

    const memberships = await tx<Array<{ id: string }>>`
      INSERT INTO partner_account_memberships (
        partner_account_id, partner_user_id, role_template_id, role_key,
        status, persona, access_level, access_scope, preferences, is_default,
        invited_at, accepted_at, created_at, updated_at
      ) VALUES (
        ${partnerAccountId}, ${partnerUserId},
        'f0000000-0000-4000-8000-000000000003', 'scheduler', 'active',
        'commercial_client', 'account', '{}'::jsonb,
        '{"timezone":"America/New_York","locale":"en-US"}'::jsonb,
        true, now(), now(), now(), now()
      ) RETURNING id
    `;
    const membershipId = memberships[0]?.id;
    if (!membershipId)
      throw new Error("Unable to create partner membership fixture.");

    const locations = await tx<Array<{ id: string }>>`
      INSERT INTO partner_account_locations (
        partner_account_id, property_id, site_name, external_property_id,
        address_line1, city, state, postal_code, timezone, locale, latitude,
        longitude, geocode_status, service_area_status, active,
        created_by_membership_id, created_at, updated_at
      ) VALUES (
        ${partnerAccountId}, ${propertyId}, ${`Audit site ${marker}`},
        ${marker}, ${`100 ${marker} Way`}, 'Roswell', 'GA', '30075',
        'America/New_York', 'en-US', 34.0232, -84.3616, 'verified',
        'eligible', true, ${membershipId}, now(), now()
      ) RETURNING id
    `;
    const locationId = locations[0]?.id;
    if (!locationId)
      throw new Error("Unable to create partner location fixture.");

    await tx`
      INSERT INTO policy_settings (key, value, created_at, updated_at)
      VALUES
        (
          'business_hours',
          ${tx.json({
            timezone: "America/New_York",
            weekly: {
              monday: [{ start: "08:00", end: "17:30" }],
              tuesday: [{ start: "08:00", end: "17:30" }],
              wednesday: [{ start: "08:00", end: "17:30" }],
              thursday: [{ start: "08:00", end: "17:30" }],
              friday: [{ start: "08:00", end: "17:30" }],
              saturday: [{ start: "09:00", end: "14:00" }],
              sunday: [],
            },
          })}::jsonb,
          now(),
          now()
        ),
        (
          'booking_rules',
          ${tx.json({
            bookingWindowDays: 30,
            bufferMinutes: 30,
            maxJobsPerDay: 6,
            maxJobsPerCrew: 3,
          })}::jsonb,
          now(),
          now()
        )
      ON CONFLICT (key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `;

    await tx`
      INSERT INTO partner_service_catalog (
        key, label, description, active, instant_bookable,
        required_scope_fields, default_proof_requirements,
        automatic_review_rules, created_at, updated_at
      ) VALUES (
        'junk-removal', 'Junk removal',
        'E2E account-scoped removal service.', true, true,
        ARRAY['description', 'location', 'onSiteContact']::text[],
        '{"before":1,"after":1}'::jsonb, '{}'::jsonb, now(), now()
      ) ON CONFLICT (key) DO UPDATE SET
        active = true,
        instant_bookable = true,
        updated_at = excluded.updated_at
    `;
    await tx`
      INSERT INTO partner_service_catalog (
        key, label, description, active, instant_bookable,
        required_scope_fields, default_proof_requirements,
        automatic_review_rules, created_at, updated_at
      ) VALUES (
        'demo-hauloff', 'Demo + haul-off',
        'E2E review-request service without an online schedule profile.',
        true, false,
        ARRAY['description', 'location', 'onSiteContact']::text[],
        '{"before":1,"after":1}'::jsonb, '{}'::jsonb, now(), now()
      ) ON CONFLICT (key) DO UPDATE SET
        active = true,
        instant_bookable = false,
        updated_at = excluded.updated_at
    `;
    await tx`
      INSERT INTO partner_scheduling_profiles (
        service_key, version, duration_minutes, travel_buffer_minutes,
        capacity_pool_key, capacity_units, supported_territories,
        required_scope_fields, pricing_eligibility, proof_defaults,
        automatic_review_rules, instant_confirmation_enabled, active,
        effective_from, created_at, updated_at
      ) VALUES (
        'junk-removal', 1, 120, 30, 'field_service', 1,
        ARRAY['GA']::text[],
        ARRAY['description', 'location', 'onSiteContact']::text[],
        '{"amountMinor":25000,"currency":"USD"}'::jsonb,
        '{"before":1,"after":1}'::jsonb, '{}'::jsonb,
        true, true, now() - interval '1 day', now(), now()
      ) ON CONFLICT (service_key, version) DO UPDATE SET
        active = true,
        pricing_eligibility = excluded.pricing_eligibility,
        instant_confirmation_enabled = true,
        effective_to = NULL,
        updated_at = excluded.updated_at
    `;
    await tx`
      INSERT INTO calendar_sync_state (
        calendar_id, last_synced_at, external_busy_coverage_synced_at,
        created_at, updated_at
      ) VALUES (${calendarId}, now(), now(), now(), now())
      ON CONFLICT (calendar_id) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        external_busy_coverage_synced_at =
          excluded.external_busy_coverage_synced_at,
        last_notification_at = NULL,
        updated_at = excluded.updated_at
    `;

    const sessions = await tx<Array<{ id: string }>>`
      INSERT INTO partner_sessions (
        partner_user_id, active_partner_account_id, active_membership_id,
        session_hash, auth_method, assurance_level, account_selected_at,
        expires_at, created_at, last_seen_at
      ) VALUES (
        ${partnerUserId}, ${partnerAccountId}, ${membershipId},
        ${sessionHash(sessionToken)}, 'magic_link', 'aal1', now(),
        now() + interval '1 day', now(), now()
      ) RETURNING id
    `;
    const sessionId = sessions[0]?.id;
    if (!sessionId)
      throw new Error("Unable to create partner session fixture.");

    const cards = await tx<Array<{ id: string }>>`
      INSERT INTO partner_rate_cards (
        org_contact_id, partner_account_id, currency, active, version,
        effective_from, created_at, updated_at
      ) VALUES (
        ${contactId}, ${partnerAccountId}, 'USD', true, 1,
        now() - interval '1 day', now(), now()
      )
      RETURNING id
    `;
    const rateCardId = cards[0]?.id;
    if (!rateCardId) throw new Error("Unable to create partner rate fixture.");
    await tx`
      INSERT INTO partner_rate_items (
        rate_card_id, service_key, tier_key, label, amount_cents,
        sort_order, created_at
      ) VALUES
        (
          ${rateCardId}, 'junk-removal', 'quarter', 'Quarter load', 25000,
          10, now()
        ),
        (
          ${rateCardId}, 'demo-hauloff', 'medium', 'Medium demo', 85000,
          20, now()
        )
    `;

    return {
      marker,
      contactId,
      propertyId,
      partnerAccountId,
      membershipId,
      locationId,
      partnerUserId,
      partnerEmail,
      partnerPhoneE164,
      sessionId,
      sessionToken,
    };
  });
}

export async function configurePartnerApprovalFixture(
  requester: PartnerBookingFixture,
): Promise<PartnerApprovalFixture> {
  const sql = sqlClient();
  const approverSessionToken = crypto.randomBytes(32).toString("base64url");
  const approverEmail = `approver+${requester.marker}@mystos.test`;
  return sql.begin(async (tx) => {
    const users = await tx<Array<{ id: string }>>`
      INSERT INTO partner_users (
        org_contact_id, email, name, active, mfa_enrolled_at,
        created_at, updated_at
      ) VALUES (
        ${requester.contactId}, ${approverEmail}, 'Audit Account Approver',
        true, now(), now(), now()
      ) RETURNING id
    `;
    const approverUserId = users[0]?.id;
    if (!approverUserId) {
      throw new Error("Unable to create partner approval user fixture.");
    }

    const memberships = await tx<Array<{ id: string }>>`
      INSERT INTO partner_account_memberships (
        partner_account_id, partner_user_id, role_template_id, role_key,
        status, persona, access_level, access_scope, preferences, is_default,
        invited_at, accepted_at, created_at, updated_at
      ) VALUES (
        ${requester.partnerAccountId}, ${approverUserId},
        'f0000000-0000-4000-8000-000000000004', 'approver', 'active',
        'commercial_client', 'account', '{}'::jsonb,
        '{"timezone":"America/New_York","locale":"en-US"}'::jsonb,
        true, now(), now(), now(), now()
      ) RETURNING id
    `;
    const approverMembershipId = memberships[0]?.id;
    if (!approverMembershipId) {
      throw new Error("Unable to create partner approval membership fixture.");
    }

    const sessions = await tx<Array<{ id: string }>>`
      INSERT INTO partner_sessions (
        partner_user_id, active_partner_account_id, active_membership_id,
        session_hash, auth_method, assurance_level, account_selected_at,
        expires_at, created_at, last_seen_at, mfa_verified_at
      ) VALUES (
        ${approverUserId}, ${requester.partnerAccountId},
        ${approverMembershipId}, ${sessionHash(approverSessionToken)},
        'magic_link', 'aal2', now(), now() + interval '1 day', now(), now(), now()
      ) RETURNING id
    `;
    const approverSessionId = sessions[0]?.id;
    if (!approverSessionId) {
      throw new Error("Unable to create partner approval session fixture.");
    }

    const rules = await tx<Array<{ id: string }>>`
      INSERT INTO partner_approval_rules (
        partner_account_id, name, conditions, required_approver_role_keys,
        required_decision_count, active, version, created_by_membership_id,
        created_at, updated_at
      ) VALUES (
        ${requester.partnerAccountId}, 'E2E service approval',
        ${tx.json({ serviceKeys: ["junk-removal"] })}::jsonb,
        ARRAY['approver']::text[], 1, true, 1, ${approverMembershipId},
        now(), now()
      ) RETURNING id
    `;
    const approvalRuleId = rules[0]?.id;
    if (!approvalRuleId) {
      throw new Error("Unable to create partner approval rule fixture.");
    }

    return {
      requester,
      approverUserId,
      approverMembershipId,
      approverSessionId,
      approverSessionToken,
      approvalRuleId,
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
  startAt: string | null;
  arrivalWindowStartAt: string | null;
  arrivalWindowEndAt: string | null;
} | null> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      bookingId: string;
      appointmentId: string;
      status: string;
      version: number;
      calendarEventId: string | null;
      startAt: string | null;
      arrivalWindowStartAt: string | null;
      arrivalWindowEndAt: string | null;
    }>
  >`
    SELECT booking.id AS "bookingId", appointment.id AS "appointmentId",
      appointment.status::text AS status, booking.version,
      appointment.calendar_event_id AS "calendarEventId",
      appointment.start_at::text AS "startAt",
      booking.arrival_window_start_at::text AS "arrivalWindowStartAt",
      booking.arrival_window_end_at::text AS "arrivalWindowEndAt"
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

export async function getPartnerPortalV2IntegritySnapshot(
  fixture: PartnerBookingFixture,
  bookingId: string,
): Promise<{
  submittedAudits: number;
  rescheduledAudits: number;
  canceledAudits: number;
  submittedEvents: number;
  rescheduledEvents: number;
  canceledEvents: number;
  scheduleOutboxEvents: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      submittedAudits: number | string;
      rescheduledAudits: number | string;
      canceledAudits: number | string;
      submittedEvents: number | string;
      rescheduledEvents: number | string;
      canceledEvents: number | string;
      scheduleOutboxEvents: number | string;
    }>
  >`
    SELECT
      (SELECT count(*) FROM audit_logs
        WHERE action = 'partner.portal.v2.booking.submitted'
          AND entity_id = ${bookingId}
          AND actor_id = ${fixture.partnerUserId}
          AND session_id = ${fixture.sessionId}) AS "submittedAudits",
      (SELECT count(*) FROM audit_logs
        WHERE action = 'partner.portal.v2.booking.rescheduled'
          AND entity_id = ${bookingId}
          AND actor_id = ${fixture.partnerUserId}
          AND session_id = ${fixture.sessionId}) AS "rescheduledAudits",
      (SELECT count(*) FROM audit_logs
        WHERE action = 'partner.booking.canceled'
          AND entity_id = ${bookingId}
          AND actor_id = ${fixture.partnerUserId}
          AND session_id = ${fixture.sessionId}) AS "canceledAudits",
      (SELECT count(*) FROM partner_job_events
        WHERE partner_account_id = ${fixture.partnerAccountId}
          AND partner_booking_id = ${bookingId}
          AND event_type = 'job.submitted') AS "submittedEvents",
      (SELECT count(*) FROM partner_job_events
        WHERE partner_account_id = ${fixture.partnerAccountId}
          AND partner_booking_id = ${bookingId}
          AND event_type = 'job.rescheduled') AS "rescheduledEvents",
      (SELECT count(*) FROM partner_job_events
        WHERE partner_account_id = ${fixture.partnerAccountId}
          AND partner_booking_id = ${bookingId}
          AND event_type = 'job.canceled') AS "canceledEvents",
      (SELECT count(*) FROM outbox_events event
        JOIN partner_bookings booking ON booking.id = ${bookingId}
        WHERE event.type = 'appointment.calendar_sync_requested'
          AND event.payload->>'appointmentId' = booking.appointment_id::text)
        AS "scheduleOutboxEvents"
  `;
  const row = rows[0];
  if (!row)
    throw new Error("Partner Portal V2 integrity snapshot unavailable.");
  return {
    submittedAudits: Number(row.submittedAudits),
    rescheduledAudits: Number(row.rescheduledAudits),
    canceledAudits: Number(row.canceledAudits),
    submittedEvents: Number(row.submittedEvents),
    rescheduledEvents: Number(row.rescheduledEvents),
    canceledEvents: Number(row.canceledEvents),
    scheduleOutboxEvents: Number(row.scheduleOutboxEvents),
  };
}

export async function getPartnerReviewRequestSnapshot(
  fixture: PartnerBookingFixture,
  bookingId: string,
): Promise<{
  publicStatus: string;
  confirmationMode: string;
  appointmentStartAt: string | null;
  promisedArrivalStartAt: string | null;
  promisedArrivalEndAt: string | null;
  bookingArrivalStartAt: string | null;
  bookingArrivalEndAt: string | null;
  preferredWindows: unknown;
  reviewAuditCount: number;
  calendarOutboxCount: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      publicStatus: string;
      confirmationMode: string;
      appointmentStartAt: string | null;
      promisedArrivalStartAt: string | null;
      promisedArrivalEndAt: string | null;
      bookingArrivalStartAt: string | null;
      bookingArrivalEndAt: string | null;
      preferredWindows: unknown;
      reviewAuditCount: number | string;
      calendarOutboxCount: number | string;
    }>
  >`
    SELECT
      booking.public_status AS "publicStatus",
      booking.confirmation_mode AS "confirmationMode",
      appointment.start_at::text AS "appointmentStartAt",
      appointment.promised_arrival_start_at::text AS "promisedArrivalStartAt",
      appointment.promised_arrival_end_at::text AS "promisedArrivalEndAt",
      booking.arrival_window_start_at::text AS "bookingArrivalStartAt",
      booking.arrival_window_end_at::text AS "bookingArrivalEndAt",
      booking.scope_snapshot->'preferredWindows' AS "preferredWindows",
      (SELECT count(*) FROM audit_logs
        WHERE action = 'partner.portal.v2.booking.review_requested'
          AND entity_id = booking.id::text
          AND actor_id = ${fixture.partnerUserId}
          AND session_id = ${fixture.sessionId}) AS "reviewAuditCount",
      (SELECT count(*) FROM outbox_events event
        WHERE event.type = 'appointment.calendar_sync_requested'
          AND event.payload->>'appointmentId' = appointment.id::text)
        AS "calendarOutboxCount"
    FROM partner_bookings booking
    JOIN appointments appointment ON appointment.id = booking.appointment_id
    WHERE booking.partner_account_id = ${fixture.partnerAccountId}
      AND booking.id = ${bookingId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Partner review request snapshot unavailable.");
  return {
    ...row,
    reviewAuditCount: Number(row.reviewAuditCount),
    calendarOutboxCount: Number(row.calendarOutboxCount),
  };
}

export async function getPartnerApprovalLifecycleSnapshot(
  fixture: PartnerApprovalFixture,
  bookingId: string,
): Promise<{
  requestId: string;
  requestState: string;
  requestRevision: number;
  holdStatus: string | null;
  holdExpiresAt: string | null;
  bookingStatus: string;
  confirmationMode: string;
  appointmentStatus: string;
  appointmentStartAt: string | null;
  promisedArrivalStartAt: string | null;
  promisedArrivalEndAt: string | null;
  decisionCount: number;
  decisionAuditCount: number;
  approvalCalendarOutboxCount: number;
}> {
  const sql = sqlClient();
  const rows = await sql<
    Array<{
      requestId: string;
      requestState: string;
      requestRevision: number;
      holdStatus: string | null;
      holdExpiresAt: string | null;
      bookingStatus: string;
      confirmationMode: string;
      appointmentStatus: string;
      appointmentStartAt: string | null;
      promisedArrivalStartAt: string | null;
      promisedArrivalEndAt: string | null;
      decisionCount: number | string;
      decisionAuditCount: number | string;
      approvalCalendarOutboxCount: number | string;
    }>
  >`
    SELECT
      request.id AS "requestId",
      request.state AS "requestState",
      request.revision AS "requestRevision",
      hold.status AS "holdStatus",
      hold.expires_at::text AS "holdExpiresAt",
      booking.public_status AS "bookingStatus",
      booking.confirmation_mode AS "confirmationMode",
      appointment.status AS "appointmentStatus",
      appointment.start_at::text AS "appointmentStartAt",
      appointment.promised_arrival_start_at::text AS "promisedArrivalStartAt",
      appointment.promised_arrival_end_at::text AS "promisedArrivalEndAt",
      (SELECT count(*) FROM partner_approval_decisions decision
        WHERE decision.partner_account_id = ${fixture.requester.partnerAccountId}
          AND decision.approval_request_id = request.id) AS "decisionCount",
      (SELECT count(*) FROM audit_logs audit
        WHERE audit.action = 'partner.approval.decided'
          AND audit.entity_id = request.id::text
          AND audit.actor_id = ${fixture.approverUserId}
          AND audit.session_id = ${fixture.approverSessionId}) AS "decisionAuditCount",
      (SELECT count(*) FROM outbox_events event
        WHERE event.type = 'appointment.calendar_sync_requested'
          AND event.payload->>'appointmentId' = appointment.id::text
          AND event.payload->>'reason' = 'partner.portal.v2.booking.approval_confirmed')
        AS "approvalCalendarOutboxCount"
    FROM partner_approval_requests request
    JOIN partner_bookings booking ON booking.id = request.partner_booking_id
    JOIN appointments appointment ON appointment.id = booking.appointment_id
    LEFT JOIN appointment_holds hold ON hold.id = request.approval_hold_id
    WHERE request.partner_account_id = ${fixture.requester.partnerAccountId}
      AND booking.id = ${bookingId}
    ORDER BY request.created_at DESC, request.id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Partner approval lifecycle snapshot unavailable.");
  return {
    ...row,
    decisionCount: Number(row.decisionCount),
    decisionAuditCount: Number(row.decisionAuditCount),
    approvalCalendarOutboxCount: Number(row.approvalCalendarOutboxCount),
  };
}

export async function cleanupPartnerApprovalFixture(
  fixture: PartnerApprovalFixture,
): Promise<void> {
  const sql = sqlClient();
  await sql.begin(async (tx) => {
    await tx`
      UPDATE partner_sessions
      SET revoked_at = coalesce(revoked_at, statement_timestamp())
      WHERE partner_user_id = ${fixture.approverUserId}
    `;
    await tx`
      UPDATE partner_users
      SET active = false,
          email = ${`archived+${fixture.approverUserId}@mystos.test`},
          updated_at = statement_timestamp()
      WHERE id = ${fixture.approverUserId}
    `;
  });
  await cleanupPartnerBookingFixture(fixture.requester);
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
