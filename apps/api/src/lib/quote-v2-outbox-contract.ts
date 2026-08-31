import { z } from "zod";

export const QUOTE_V2_OUTBOX_SCHEMA_VERSION = 2 as const;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export const QuoteV2EventTypeSchema = z.enum([
  "quote.send_requested.v2",
  "quote.change_requested.v2",
  "quote.response_recorded.v2",
  "quote.deposit_checkout_requested.v2",
  "quote.accepted_and_booked.v2",
]);

export type QuoteV2EventType = z.infer<typeof QuoteV2EventTypeSchema>;

export const QuoteV2OutboxPayloadSchema = z
  .object({
    schemaVersion: z.literal(QUOTE_V2_OUTBOX_SCHEMA_VERSION),
    eventId: z.string().uuid(),
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    correlationId: z.string().trim().regex(CORRELATION_ID_PATTERN),
    occurredAt: z.string().max(40).datetime({ offset: true }),
    attemptId: z.string().uuid().nullable().optional(),
    responseId: z.string().uuid().nullable().optional(),
    appointmentId: z.string().uuid().nullable().optional(),
    holdId: z.string().uuid().nullable().optional(),
    paymentAttemptId: z.string().uuid().nullable().optional(),
    paymentId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type QuoteV2OutboxPayload = z.infer<typeof QuoteV2OutboxPayloadSchema>;

const REQUIRED_BINDINGS: Record<
  QuoteV2EventType,
  ReadonlyArray<keyof QuoteV2OutboxPayload>
> = {
  "quote.send_requested.v2": ["attemptId"],
  "quote.change_requested.v2": ["responseId"],
  "quote.response_recorded.v2": ["responseId"],
  "quote.deposit_checkout_requested.v2": ["responseId", "paymentAttemptId"],
  "quote.accepted_and_booked.v2": ["responseId", "appointmentId", "holdId"],
};

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|email|phone|address|customer|recipient|signer|message|content|name|url)/iu;

export class QuoteV2OutboxContractError extends Error {
  readonly code: "unknown_event" | "invalid_payload" | "sensitive_payload";

  constructor(code: QuoteV2OutboxContractError["code"], message: string) {
    super(message);
    this.name = "QuoteV2OutboxContractError";
    this.code = code;
  }
}

function findSensitiveKey(value: unknown, path = "payload"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveKey(value[index], `${path}.${index}`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `${path}.${key}`;
    const found = findSensitiveKey(entry, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

export function parseQuoteV2OutboxEvent(input: {
  type: string;
  payload: unknown;
}): { type: QuoteV2EventType; payload: QuoteV2OutboxPayload } {
  const type = QuoteV2EventTypeSchema.safeParse(input.type);
  if (!type.success) {
    throw new QuoteV2OutboxContractError(
      "unknown_event",
      input.type.startsWith("quote.")
        ? `Unknown quote event ${input.type} must be quarantined.`
        : `Event ${input.type} is not a Quote V2 event.`,
    );
  }
  const sensitiveKey = findSensitiveKey(input.payload);
  if (sensitiveKey) {
    throw new QuoteV2OutboxContractError(
      "sensitive_payload",
      `Quote event payload contains prohibited field ${sensitiveKey}.`,
    );
  }
  const payload = QuoteV2OutboxPayloadSchema.safeParse(input.payload);
  if (!payload.success) {
    throw new QuoteV2OutboxContractError(
      "invalid_payload",
      "Quote event payload does not match schema version 2.",
    );
  }
  const missingBinding = REQUIRED_BINDINGS[type.data].find(
    (key) => !payload.data[key],
  );
  if (missingBinding) {
    throw new QuoteV2OutboxContractError(
      "invalid_payload",
      `Quote event ${type.data} is missing required ${missingBinding}.`,
    );
  }
  if (
    type.data === "quote.accepted_and_booked.v2" &&
    Boolean(payload.data.paymentAttemptId) !== Boolean(payload.data.paymentId)
  ) {
    throw new QuoteV2OutboxContractError(
      "invalid_payload",
      "Booked quote paymentAttemptId and paymentId must be supplied together.",
    );
  }
  return { type: type.data, payload: payload.data };
}

export function isQuoteEventType(type: string): boolean {
  return type.startsWith("quote.");
}

export function quoteV2RetryDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(Math.trunc(attempt), 8));
  return Math.min(15 * 60_000, 5_000 * 2 ** (boundedAttempt - 1));
}

export function quoteV2ShouldQuarantine(input: {
  type: string;
  attempt: number;
  error: unknown;
}): boolean {
  if (!isQuoteEventType(input.type)) return false;
  if (
    input.error instanceof QuoteV2OutboxContractError &&
    (input.error.code === "unknown_event" ||
      input.error.code === "sensitive_payload")
  ) {
    return true;
  }
  return input.attempt >= 8;
}
