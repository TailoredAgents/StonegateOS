import { parsePhoneNumberFromString } from "libphonenumber-js";

const E164_PATTERN = /^\+[1-9]\d{9,14}$/u;
const PHONE_UNIQUE_INDEX = "team_members_phone_e164_key";
const EMAIL_UNIQUE_INDEX = "team_members_email_normalized_key";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Canonicalizes a team member's phone identity to E.164. US numbers are the
 * default for unqualified input, matching the existing CRM phone behavior.
 */
export function normalizeTeamMemberPhoneE164(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;

  const candidate = /^\d{10}$/u.test(raw) ? `+1${raw}` : raw;
  const parsed = parsePhoneNumberFromString(candidate, "US");
  const e164 = parsed?.number ?? null;
  return e164 && E164_PATTERN.test(e164) ? e164 : null;
}

/**
 * Canonical team email identity. Authentication, Access writes, and the
 * database migration all use this same trim/lower contract.
 */
export function normalizeTeamMemberEmail(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  return raw ? raw.toLowerCase() : null;
}

/**
 * Authentication must never choose an arbitrary row when legacy data contains
 * duplicate identities. The database constraint is the primary protection;
 * this check keeps reads fail-closed during an expand-first rollout as well.
 */
export function selectUnambiguousActiveIdentity<
  T extends { active: boolean | null },
>(rows: readonly T[]): T | null {
  if (rows.length !== 1) return null;
  const [row] = rows;
  return row && row.active !== false ? row : null;
}

export function isTeamMemberPhoneUniqueViolation(error: unknown): boolean {
  const direct = isRecord(error) ? error : null;
  const cause = direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const candidate = cause ?? direct;
  if (!candidate || candidate["code"] !== "23505") return false;

  const constraint =
    typeof candidate["constraint_name"] === "string"
      ? candidate["constraint_name"]
      : typeof candidate["constraint"] === "string"
        ? candidate["constraint"]
        : null;
  const message =
    typeof candidate["message"] === "string" ? candidate["message"] : "";
  return (
    constraint === PHONE_UNIQUE_INDEX || message.includes(PHONE_UNIQUE_INDEX)
  );
}

export function isTeamMemberEmailUniqueViolation(error: unknown): boolean {
  const direct = isRecord(error) ? error : null;
  const cause = direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const candidate = cause ?? direct;
  if (!candidate || candidate["code"] !== "23505") return false;

  const constraint =
    typeof candidate["constraint_name"] === "string"
      ? candidate["constraint_name"]
      : typeof candidate["constraint"] === "string"
        ? candidate["constraint"]
        : null;
  const message =
    typeof candidate["message"] === "string" ? candidate["message"] : "";
  return (
    constraint === EMAIL_UNIQUE_INDEX || message.includes(EMAIL_UNIQUE_INDEX)
  );
}
