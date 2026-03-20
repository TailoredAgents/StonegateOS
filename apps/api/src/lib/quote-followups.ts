export const QUOTE_FOLLOW_UP_TITLE = "Quote follow-up";

function readLineValue(
  notes: string | null | undefined,
  key: string,
): string | null {
  if (typeof notes !== "string" || notes.trim().length === 0) return null;
  const pattern = new RegExp(`^${key}=([^\\n]+)$`, "im");
  const match = notes.match(pattern);
  if (!match) return null;
  const value = match[1]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function isQuoteFollowUpTask(notes: string | null | undefined): boolean {
  return typeof notes === "string" && /\bkind=quote_follow_up\b/i.test(notes);
}

export function extractQuoteFollowUpAppointmentId(
  notes: string | null | undefined,
): string | null {
  return readLineValue(notes, "appointmentId");
}

export function extractQuoteFollowUpComment(
  notes: string | null | undefined,
): string | null {
  if (typeof notes !== "string" || notes.trim().length === 0) return null;
  const [, comment = ""] = notes.split(/\n\s*\n/, 2);
  const trimmed = comment.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildQuoteFollowUpNotes(input: {
  contactId: string;
  leadId?: string | null;
  appointmentId: string;
  comment?: string | null;
}): string {
  const lines = [
    `[auto] contactId=${input.contactId}`,
    input.leadId ? `[auto] leadId=${input.leadId}` : null,
    "kind=follow_up",
    "kind=quote_follow_up",
    `appointmentId=${input.appointmentId}`,
    "source=my_day_quote",
  ].filter((line): line is string => Boolean(line && line.trim().length > 0));

  const comment = input.comment?.trim() ?? "";
  if (!comment) {
    return lines.join("\n");
  }

  return `${lines.join("\n")}\n\n${comment}`;
}
