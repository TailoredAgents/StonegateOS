/**
 * Normalizes a valid strong or weak HTTP entity tag before Quote CAS parsing.
 * Malformed quoting remains intact so the caller's digits-only validation
 * rejects it instead of silently accepting a partial revision.
 */
export function normalizeQuoteV2IfMatchRevision(value: string | null): string {
  const trimmed = value?.trim() ?? "";
  const candidate = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
  return candidate.length >= 2 &&
    candidate.startsWith('"') &&
    candidate.endsWith('"')
    ? candidate.slice(1, -1).trim()
    : candidate;
}
