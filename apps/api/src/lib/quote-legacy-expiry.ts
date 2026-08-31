export const LEGACY_RESIDENTIAL_VALIDITY_DAYS = 14;

export class LegacyQuoteExpiryError extends Error {
  readonly code: "revision_required" | "expired";

  constructor(code: LegacyQuoteExpiryError["code"], message: string) {
    super(message);
    this.name = "LegacyQuoteExpiryError";
    this.code = code;
  }
}

export function resolveLegacyQuoteSendTiming(input: {
  now: Date;
  sentAt: Date | null;
  expiresAt: Date | null;
  requestedValidityDays?: number;
}): { firstSentAt: Date; expiresAt: Date } {
  if (input.sentAt) {
    if (input.requestedValidityDays !== undefined) {
      throw new LegacyQuoteExpiryError(
        "revision_required",
        "Changing an issued quote's expiry requires a revision.",
      );
    }
    if (!input.expiresAt || input.expiresAt <= input.now) {
      throw new LegacyQuoteExpiryError(
        "expired",
        "This issued quote has expired and must be revised before resending.",
      );
    }
    return { firstSentAt: input.sentAt, expiresAt: input.expiresAt };
  }

  const validityDays =
    input.requestedValidityDays ?? LEGACY_RESIDENTIAL_VALIDITY_DAYS;
  const expiresAt =
    input.requestedValidityDays === undefined &&
    input.expiresAt &&
    input.expiresAt > input.now
      ? input.expiresAt
      : new Date(input.now.getTime() + validityDays * 24 * 60 * 60 * 1_000);
  return { firstSentAt: input.now, expiresAt };
}
