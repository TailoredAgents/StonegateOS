import { createHash } from "node:crypto";

export const PARTNER_QUARANTINE_CASE_KINDS = [
  "identity",
  "membership_migration",
  "invite_delivery",
  "cancellation_review",
] as const;

export type PartnerQuarantineCaseKind =
  (typeof PARTNER_QUARANTINE_CASE_KINDS)[number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Produces a stable opaque UUID for a typed quarantine case without exposing
 * which backing table owns the record. The original source UUID remains a
 * separately validated mutation binding for the one safely resolvable case.
 */
export function partnerQuarantineCaseId(
  kind: PartnerQuarantineCaseKind,
  sourceId: string,
): string {
  if (!UUID_PATTERN.test(sourceId)) {
    throw new Error("invalid_partner_quarantine_source_id");
  }
  const chars = createHash("sha256")
    .update(`stonegate.partner.quarantine.v1:${kind}:${sourceId}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function boundedPartnerQuarantineText(
  value: string | null | undefined,
  fallback: string,
  maximum = 500,
): string {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) return fallback;
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function hasAcceptedPartnerInviteProviderEvidence(
  evidence: readonly Record<string, unknown>[],
): boolean {
  return evidence.some((item) => item["state"] === "succeeded");
}
