const DEFAULT_PARTNER_RETURN = "/partners/overview";

const PROTECTED_PARTNER_PATH =
  /^\/partners\/(?:approvals|billing|book|bookings|help|overview|photos|properties|reports|settings)(?:\/|$|\?|#)/u;

export function normalizePartnerReturnTo(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PARTNER_RETURN;
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > 1_024 ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    !PROTECTED_PARTNER_PATH.test(candidate)
  ) {
    return DEFAULT_PARTNER_RETURN;
  }
  try {
    const base = new URL("https://partner-return.invalid");
    const parsed = new URL(candidate, base);
    if (parsed.origin !== base.origin) return DEFAULT_PARTNER_RETURN;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_PARTNER_RETURN;
  }
}

export function partnerLoginHref(returnTo: unknown): string {
  const destination = normalizePartnerReturnTo(returnTo);
  return destination === DEFAULT_PARTNER_RETURN
    ? "/partners/login"
    : `/partners/login?returnTo=${encodeURIComponent(destination)}`;
}
