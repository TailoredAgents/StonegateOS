const MAX_DEPTH = 5;
const MAX_OBJECT_KEYS = 80;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 500;

const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "dataurl",
  "filedata",
  "password",
  "passwordhash",
  "rawbody",
  "receiptdata",
  "receipturl",
  "refreshtoken",
  "secret",
  "sessionhash",
  "token",
  "accesstoken",
]);

const PII_KEYS = new Set([
  "address",
  "addressline1",
  "addressline2",
  "body",
  "contactname",
  "email",
  "firstname",
  "from",
  "fromaddress",
  "fromnumber",
  "lastname",
  "message",
  "messagebody",
  "name",
  "notes",
  "phone",
  "phonee164",
  "recipient",
  "subject",
  "text",
  "to",
  "toaddress",
  "tonumber",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function classifyKey(key: string): "secret" | "pii" | null {
  const normalized = normalizeKey(key);
  if (
    SECRET_KEYS.has(normalized) ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("apikey")
  ) {
    return "secret";
  }
  return PII_KEYS.has(normalized) ? "pii" : null;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push("[TRUNCATED]");
    return items;
  }
  if (typeof value !== "object") return `[UNSUPPORTED_${typeof value}]`;

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, nested] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const classification = classifyKey(key);
    result[key] =
      classification === "secret"
        ? "[REDACTED]"
        : classification === "pii"
          ? "[REDACTED_PII]"
          : sanitizeValue(nested, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) result["_truncated"] = true;
  return result;
}

/**
 * Produce a bounded, JSON-safe audit summary. Audit metadata is operational
 * evidence, not a secondary copy of customer messages, credentials, receipts,
 * or contact details.
 */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  return sanitizeValue(metadata, 0) as Record<string, unknown>;
}
