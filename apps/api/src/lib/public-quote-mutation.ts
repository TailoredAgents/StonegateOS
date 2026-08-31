import { createHash } from "node:crypto";

const PUBLIC_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

export const PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type PublicQuoteMutationAction =
  | "decision"
  | "refresh"
  | "hold"
  | "book"
  | "change";

export function normalizePublicQuoteIdempotencyKey(
  value: string | null,
): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  return PUBLIC_IDEMPOTENCY_KEY_PATTERN.test(normalized) ? normalized : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function publicQuoteMutationKeyHash(key: string): string {
  return sha256(key);
}

/**
 * Hash only the normalized, token-free action payload. Object construction is
 * explicit so key ordering cannot change the fingerprint between retries.
 */
export function publicQuoteMutationRequestHash(input: {
  action: PublicQuoteMutationAction;
  decision?: "accepted" | "declined";
  reason?: string | null;
  notes?: string | null;
  quoteId?: string | null;
  expectedRevision?: number | null;
  startAt?: string | null;
  holdId?: string | null;
}): string {
  return sha256(
    JSON.stringify({
      action: input.action,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      quoteId: input.quoteId ?? null,
      expectedRevision: input.expectedRevision ?? null,
      startAt: input.startAt ?? null,
      holdId: input.holdId ?? null,
    }),
  );
}

export function isPublicQuoteMutationSuccessBody(
  value: unknown,
): value is Record<string, unknown> & { ok: true; quoteId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate["ok"] === true &&
    typeof candidate["quoteId"] === "string" &&
    candidate["quoteId"].length > 0
  );
}
