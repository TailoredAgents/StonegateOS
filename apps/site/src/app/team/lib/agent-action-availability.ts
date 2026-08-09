import type { AgentActionType } from "@myst-os/sdk";

/**
 * Only actions whose operational API currently proves durable idempotency and
 * an actor/entity/version-bound MutationResult may execute through the Agent.
 * The others remain visible for proposal review but are explicitly unavailable
 * until their existing business endpoint is hardened; the Agent never falls
 * back to interpreting a legacy 2xx as success.
 */
export const AGENT_ACTION_TEMPORARY_BLOCKERS: Partial<
  Record<AgentActionType, string>
> = {
  create_contact:
    "Contact creation is temporarily unavailable in Agent while its atomic receipt endpoint is upgraded. Create the contact in Contacts.",
  create_quote:
    "Quote creation is temporarily unavailable in Agent while its atomic receipt endpoint is upgraded. Create the quote in Quotes.",
  create_task:
    "Appointment task creation is temporarily unavailable in Agent while its atomic receipt endpoint is upgraded. Use the appointment workspace.",
  add_contact_note:
    "Contact notes are temporarily unavailable in Agent while their atomic receipt endpoint is upgraded. Use the contact workspace.",
  book_appointment:
    "Booking is temporarily unavailable in Agent while its atomic receipt endpoint is upgraded. Use Calendar or the contact workspace.",
  cancel_appointment:
    "Cancellation is temporarily unavailable in Agent. Use Calendar, where Google Calendar cleanup and the optional customer notice are shown as separate, permission-checked effects.",
  reschedule_appointment:
    "Rescheduling is temporarily unavailable in Agent while its atomic receipt endpoint is upgraded. Use Calendar.",
  send_text:
    "SMS is temporarily unavailable in Agent while its durable send receipt is upgraded. Use Inbox.",
};

export function agentActionTemporaryBlocker(
  actionType: AgentActionType,
): string | null {
  return AGENT_ACTION_TEMPORARY_BLOCKERS[actionType] ?? null;
}
