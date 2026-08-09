const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_CHANNELS = new Set([
  "dm",
  "email",
  "facebook",
  "messenger",
  "sms",
  "voice",
]);
const ALLOWED_ACTION_TYPES = new Set([
  "appointment_checkin",
  "appointment_support",
  "call_now",
  "collect_missing_info",
  "dm_sms_handoff",
  "do_not_contact",
  "follow_up_quote",
  "handle_price_objection",
  "human_follow_up",
  "missed_call_recovery",
  "monitor_and_wait",
  "post_job_checkin",
  "quote_followup",
  "reply_now",
  "wait_for_appointment",
]);
const ALLOWED_TERMINAL_OUTCOMES = new Set([
  "connected",
  "not_connected",
  "not_dispatched",
]);

export type PublicSalesActivityContext = {
  contactId: string | null;
  leadId: string | null;
  threadId: string | null;
  callRecordId: string | null;
  taskId: string | null;
  channel: string | null;
  actionType: string | null;
  terminalOutcome: string | null;
};

function metaString(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = meta?.[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function metaUuid(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metaString(meta, key);
  return value && UUID_PATTERN.test(value) ? value : null;
}

function entityUuid(
  entityType: string,
  entityId: string | null | undefined,
  expectedType: string,
): string | null {
  return entityType === expectedType && entityId && UUID_PATTERN.test(entityId)
    ? entityId
    : null;
}

function allowedValue(
  value: string | null,
  allowed: ReadonlySet<string>,
): string | null {
  const normalized = value?.toLowerCase() ?? null;
  return normalized && allowed.has(normalized) ? normalized : null;
}

/**
 * Project an audit event into the smallest context Sales HQ needs. The raw
 * audit metadata may contain historical customer or provider data and must
 * never be returned by this operational feed.
 */
export function publicSalesActivityContext(input: {
  entityType: string;
  entityId: string | null | undefined;
  meta: Record<string, unknown> | null | undefined;
}): PublicSalesActivityContext {
  const channel = allowedValue(
    metaString(input.meta, "channel") ?? metaString(input.meta, "replyChannel"),
    ALLOWED_CHANNELS,
  );

  return {
    contactId:
      metaUuid(input.meta, "contactId") ??
      entityUuid(input.entityType, input.entityId, "contact"),
    leadId:
      metaUuid(input.meta, "leadId") ??
      entityUuid(input.entityType, input.entityId, "lead"),
    threadId:
      metaUuid(input.meta, "threadId") ??
      entityUuid(input.entityType, input.entityId, "conversation_thread"),
    callRecordId:
      metaUuid(input.meta, "callRecordId") ??
      entityUuid(input.entityType, input.entityId, "call_record"),
    taskId:
      metaUuid(input.meta, "taskId") ??
      entityUuid(input.entityType, input.entityId, "crm_task"),
    channel,
    actionType: allowedValue(
      metaString(input.meta, "actionType"),
      ALLOWED_ACTION_TYPES,
    ),
    terminalOutcome: allowedValue(
      metaString(input.meta, "terminalOutcome"),
      ALLOWED_TERMINAL_OUTCOMES,
    ),
  };
}
