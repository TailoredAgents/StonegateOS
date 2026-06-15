import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config();
dotenv.config({ path: "apps/api/.env.local", override: true });

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function redactPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = digits(value);
  return raw.length >= 4 ? `***${raw.slice(-4)}` : "***";
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

async function main() {
  const phoneArg = process.argv.find((arg) => arg.startsWith("--phone="));
  const phone = phoneArg?.slice("--phone=".length) || process.env["SALES_AUTONOMY_TEST_PHONE_E164"] || "";
  const phoneDigits = digits(phone).replace(/^1(?=\d{10}$)/, "");
  if (!phoneDigits) throw new Error("Provide --phone=<E.164 test phone> or SALES_AUTONOMY_TEST_PHONE_E164.");

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    ...(process.env["DATABASE_SSL"] === "true" || /render\.com|sslmode=require/.test(databaseUrl)
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  });

  try {
    const contacts = await sql`
      select id, first_name, last_name, phone, phone_e164, created_at, updated_at
      from contacts
      where regexp_replace(coalesce(phone, '') || coalesce(phone_e164, ''), '[^0-9]', '', 'g') like ${`%${phoneDigits}%`}
      order by updated_at desc nulls last, created_at desc
      limit 5
    `;
    const contactId = contacts[0]?.id ?? null;

    const automation = contactId
      ? await sql`
          select las.channel, las.paused, las.dnc, las.human_takeover, las.updated_at
          from lead_automation_state las
          join leads l on l.id = las.lead_id
          where l.contact_id = ${contactId}
          order by las.updated_at desc
          limit 10
        `
      : [];

    const threads = contactId
      ? await sql`
          select id, channel, state, last_message_at, updated_at
          from conversation_threads
          where contact_id = ${contactId}
          order by last_message_at desc nulls last, updated_at desc
          limit 5
        `
      : [];
    const threadIds = threads.map((thread) => thread.id);

    const messages = threadIds.length
      ? await sql`
          select id, thread_id, direction, channel, body, delivery_status, provider, provider_message_id, created_at, sent_at, received_at, metadata
          from conversation_messages
          where thread_id = any(${threadIds})
          order by created_at desc
          limit 20
        `
      : [];
    const messageIds = messages.map((message) => message.id);

    const outbox = messageIds.length
      ? await sql`
          select id, type, payload, attempts, last_error, created_at, processed_at, next_attempt_at
          from outbox_events
          where payload->>'messageId' = any(${messageIds})
          order by created_at desc
          limit 30
        `
      : [];

    const actions = threadIds.length
      ? await sql`
          select id, thread_id, proposed_action, executed_action, autonomy_mode, stage, confidence, decision_reason, human_review_reason, error, input_snapshot, result_json, created_at
          from facebook_sales_autopilot_actions
          where thread_id = any(${threadIds})
          order by created_at desc
          limit 20
        `
      : [];

    const appointments = contactId
      ? await sql`
          select id, type, start_at, duration_min, status, quoted_total_cents, booking_details, created_at, updated_at
          from appointments
          where contact_id = ${contactId}
          order by created_at desc
          limit 10
        `
      : [];
    const appointmentIds = appointments.map((appointment) => appointment.id);

    const bookingAudit = appointmentIds.length
      ? await sql`
          select id, action, entity_id, meta, created_at
          from audit_logs
          where action = 'appointment.booked'
            and entity_id = any(${appointmentIds})
          order by created_at desc
          limit 10
        `
      : [];

    const providerHealth = await sql`
      select provider, last_success_at, last_failure_at, last_failure_detail, updated_at
      from provider_health
      where provider in ('sms', 'calendar')
      order by provider
    `;

    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          phone: redactPhone(phone),
          contact: contacts.map((contact) => ({
            id: contact.id,
            name: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null,
            phone: redactPhone(contact.phone),
            phoneE164: redactPhone(contact.phone_e164),
            createdAt: iso(contact.created_at),
            updatedAt: iso(contact.updated_at),
          })),
          automation,
          threads: threads.map((thread) => ({
            id: thread.id,
            channel: thread.channel,
            state: thread.state,
            lastMessageAt: iso(thread.last_message_at),
            updatedAt: iso(thread.updated_at),
          })),
          messages: messages.map((message) => ({
            id: message.id,
            threadId: message.thread_id,
            direction: message.direction,
            channel: message.channel,
            body: message.body,
            deliveryStatus: message.delivery_status,
            provider: message.provider,
            hasProviderMessageId: Boolean(message.provider_message_id),
            createdAt: iso(message.created_at),
            sentAt: iso(message.sent_at),
            receivedAt: iso(message.received_at),
            metadata: message.metadata,
          })),
          outbox: outbox.map((event) => ({
            id: event.id,
            type: event.type,
            attempts: event.attempts,
            lastError: event.last_error,
            createdAt: iso(event.created_at),
            processedAt: iso(event.processed_at),
            nextAttemptAt: iso(event.next_attempt_at),
          })),
          actions: actions.map((action) => ({
            id: action.id,
            threadId: action.thread_id,
            proposedAction: action.proposed_action,
            executedAction: action.executed_action,
            autonomyMode: action.autonomy_mode,
            stage: action.stage,
            confidence: action.confidence,
            decisionReason: action.decision_reason,
            humanReviewReason: action.human_review_reason,
            error: action.error,
            inputSnapshot: action.input_snapshot,
            result: action.result_json,
            createdAt: iso(action.created_at),
          })),
          appointments: appointments.map((appointment) => ({
            id: appointment.id,
            type: appointment.type,
            startAt: iso(appointment.start_at),
            durationMinutes: appointment.duration_min,
            status: appointment.status,
            quotedTotalCents: appointment.quoted_total_cents,
            bookingDetails: appointment.booking_details,
            createdAt: iso(appointment.created_at),
            updatedAt: iso(appointment.updated_at),
          })),
          bookingAudit: bookingAudit.map((audit) => ({
            id: audit.id,
            action: audit.action,
            entityId: audit.entity_id,
            meta: audit.meta,
            createdAt: iso(audit.created_at),
          })),
          providerHealth: providerHealth.map((provider) => ({
            provider: provider.provider,
            lastSuccessAt: iso(provider.last_success_at),
            lastFailureAt: iso(provider.last_failure_at),
            lastFailureDetail: provider.last_failure_detail,
            updatedAt: iso(provider.updated_at),
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.message || error.stack || String(error));
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
