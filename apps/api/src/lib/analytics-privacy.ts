const PROVIDER_PARAM_KEYS = new Set([
  "campaign",
  "medium",
  "service",
  "source",
]);
const PROVIDER_EVENT_NAMES = new Set(["generate_lead"]);

const IDENTIFIER_KEYS = new Set([
  "address",
  "appointment",
  "appointmentid",
  "contact",
  "contactid",
  "customer",
  "customerid",
  "email",
  "firstname",
  "fullname",
  "lastname",
  "lead",
  "leadid",
  "message",
  "messagebody",
  "messageid",
  "name",
  "notes",
  "phone",
  "quote",
  "quoteid",
  "thread",
  "threadid",
  "user",
  "userid",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isAnalyticsIdentifierKey(key: string): boolean {
  return IDENTIFIER_KEYS.has(normalizedKey(key));
}

export function sanitizeAnalyticsProviderEventName(
  eventName: string,
): string | null {
  const normalized = eventName.trim().toLowerCase();
  return PROVIDER_EVENT_NAMES.has(normalized) ? normalized : null;
}

function looksLikeIdentifierValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) return true;
  const digits = trimmed.replace(/\D/gu, "");
  return digits.length >= 10 && digits.length <= 15;
}

function safeProviderValue(value: unknown): string | number | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 120);
  if (!trimmed || looksLikeIdentifierValue(trimmed)) return null;
  return trimmed;
}

export function sanitizeAnalyticsProviderParams(
  params: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> {
  if (!params) return {};
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!PROVIDER_PARAM_KEYS.has(key) || isAnalyticsIdentifierKey(key)) {
      continue;
    }
    const normalized = safeProviderValue(value);
    if (normalized !== null) safe[key] = normalized;
  }
  return safe;
}

export function sanitizeFirstPartyAnalyticsMeta(
  value: unknown,
  maxKeys = 24,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (Object.keys(result).length >= maxKeys) break;
    const key = rawKey.trim().slice(0, 64);
    if (!key || isAnalyticsIdentifierKey(key)) continue;
    if (typeof rawValue === "string") {
      if (looksLikeIdentifierValue(rawValue)) continue;
      result[key] = rawValue.slice(0, 220);
    } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      result[key] = rawValue;
    } else if (typeof rawValue === "boolean") {
      result[key] = rawValue;
    } else if (rawValue === null) {
      result[key] = null;
    }
  }
  return result;
}
