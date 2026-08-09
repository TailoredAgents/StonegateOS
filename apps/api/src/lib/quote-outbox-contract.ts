export type QuoteDecision = "accepted" | "declined";
export type QuoteDecisionSource = "customer" | "team";

export type QuoteDecisionOutboxPayload = {
  quoteId: string;
  decision: QuoteDecision;
  source: QuoteDecisionSource;
  notes: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildQuoteSendAttemptId(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid_quote_send_revision");
  }
  return `revision-${revision}`;
}

/**
 * New sends always carry a revision-based attempt ID. The event-ID fallback
 * keeps already-queued pre-deployment events dispatchable without collapsing
 * two legacy events onto the same message dedupe key.
 */
export function resolveQuoteSendAttemptId(
  value: unknown,
  outboxEventId: string,
): string {
  const candidate = readNonEmptyString(value);
  return candidate && /^revision-[1-9][0-9]*$/u.test(candidate)
    ? candidate
    : `legacy-outbox-${outboxEventId}`;
}

export function quoteSentMessageDedupeKey(
  quoteId: string,
  sendAttemptId: string,
  channel: "sms" | "email",
): string {
  return `quote.sent:${quoteId}:${sendAttemptId}:${channel}`;
}

export function parseQuoteDecisionOutboxPayload(
  value: unknown,
): QuoteDecisionOutboxPayload | null {
  if (!isRecord(value)) return null;
  const quoteId = readNonEmptyString(value["quoteId"]);
  const decision = value["decision"];
  const source = value["source"];
  const rawNotes = value["notes"];
  const notes =
    rawNotes === null || rawNotes === undefined
      ? null
      : typeof rawNotes === "string"
        ? rawNotes
        : null;

  if (
    !quoteId ||
    (decision !== "accepted" && decision !== "declined") ||
    (source !== "customer" && source !== "team") ||
    (rawNotes !== null &&
      rawNotes !== undefined &&
      typeof rawNotes !== "string")
  ) {
    return null;
  }

  return { quoteId, decision, source, notes };
}

export function shouldNotifyCustomerForQuoteDecision(
  source: QuoteDecisionSource,
): boolean {
  switch (source) {
    case "customer":
      return true;
    case "team":
      return false;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
