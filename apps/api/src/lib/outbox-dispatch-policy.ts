import { getTeamOperationKillSwitch } from "@/lib/team-operation-kill-switch";

/**
 * Events in this set can cross a provider boundary directly. Upstream events
 * that only enqueue one of these events may continue while the switch is on;
 * the provider-bound event remains durable and is deferred here.
 */
const EXTERNAL_PROVIDER_EVENT_TYPES = new Set([
  "appointment.calendar_sync_requested",
  "call.recording.delete",
  "crm.reminder.sms",
  "estimate.reminder",
  "estimate.requested",
  "estimate.rescheduled",
  "estimate.status_changed",
  "followup.send",
  "lead.alert",
  "message.send",
  "partner.account_invitation.email",
  "quote.decision",
  "quote.sent",
  "quote.send_requested.v2",
  "quote.accepted_and_booked.v2",
  "review.request",
  "sales.autopilot.autosend",
  "sales.escalation.call",
  "sales.queue.nudge.sms",
  "staff_notification.dispatch",
]);

export type OutboxDispatchBlock = {
  reason: "outbox_dispatch_disabled" | "external_sends_disabled";
  retryAfterMs: number;
};

export function getOutboxDispatchBlock(
  eventType: string,
): OutboxDispatchBlock | null {
  if (getTeamOperationKillSwitch(["outbox.dispatch"])) {
    return { reason: "outbox_dispatch_disabled", retryAfterMs: 60_000 };
  }
  if (
    EXTERNAL_PROVIDER_EVENT_TYPES.has(eventType) &&
    getTeamOperationKillSwitch(["messages.send"])
  ) {
    return { reason: "external_sends_disabled", retryAfterMs: 60_000 };
  }
  return null;
}
