import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { QuoteCapabilityAction } from "@/lib/quote-v2-domain";

const TOKEN_BYTES = 32;
const READ_ONLY_DAYS = 90;
const ACCEPTED_READ_DAYS = 365;

export type QuoteCapabilityRole = "signer" | "viewer";

export const QUOTE_SIGNER_ACTIONS: readonly QuoteCapabilityAction[] = [
  "view",
  "pdf",
  "change",
  "refresh",
  "accept",
  "decline",
  "availability",
  "hold",
  "checkout",
  "book",
] as const;

export const QUOTE_VIEWER_ACTIONS: readonly QuoteCapabilityAction[] = [
  "view",
  "pdf",
] as const;

export type IssuedQuoteCapability = {
  token: string;
  tokenHash: string;
};

export function generateQuoteCapability(): IssuedQuoteCapability {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashQuoteCapabilityToken(token) };
}

export function hashQuoteCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function quoteCapabilityHashMatches(
  token: string,
  expectedHash: string,
): boolean {
  if (!/^[0-9a-f]{64}$/u.test(expectedHash)) return false;
  const actual = Buffer.from(hashQuoteCapabilityToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function capabilityActionsForRole(
  role: QuoteCapabilityRole,
): QuoteCapabilityAction[] {
  return [...(role === "signer" ? QUOTE_SIGNER_ACTIONS : QUOTE_VIEWER_ACTIONS)];
}

export function quoteCapabilityReadExpiry(input: {
  at: Date;
  outcome:
    | "open"
    | "expired"
    | "superseded"
    | "declined"
    | "voided"
    | "accepted"
    | "booked";
}): Date {
  const days =
    input.outcome === "accepted" || input.outcome === "booked"
      ? ACCEPTED_READ_DAYS
      : READ_ONLY_DAYS;
  return new Date(input.at.getTime() + days * 24 * 60 * 60 * 1_000);
}

export function redactQuoteCapabilities(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactQuoteCapabilities);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      /^(share_?token|capability_?token|raw_?token|share_?url)$/iu.test(key)
    ) {
      result[key] = "[REDACTED_QUOTE_CAPABILITY]";
      continue;
    }
    result[key] = redactQuoteCapabilities(entry);
  }
  return result;
}
