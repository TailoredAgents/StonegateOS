import { createHash } from "node:crypto";
import {
  createPortalV2ErrorResponse,
  type PortalV2ErrorHttpResponse,
} from "./errors";

export const PORTAL_V2_IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const PORTAL_V2_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;

export type PortalV2IdempotencyKeyResult =
  | Readonly<{
      ok: true;
      present: boolean;
      keyHash: string | null;
    }>
  | Readonly<{
      ok: false;
      reason: "required" | "invalid";
    }>;

export function normalizePortalV2IdempotencyKey(
  rawValue: unknown,
): string | null {
  if (typeof rawValue !== "string") return null;
  const normalized = rawValue.normalize("NFKC").trim();
  return PORTAL_V2_IDEMPOTENCY_KEY_PATTERN.test(normalized) ? normalized : null;
}

/** Returns only the safe fingerprint; raw client keys must not be persisted. */
export function hashPortalV2IdempotencyKey(rawValue: unknown): string {
  const normalized = normalizePortalV2IdempotencyKey(rawValue);
  if (!normalized) {
    throw new TypeError("The portal Idempotency-Key is invalid.");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function parsePortalV2IdempotencyKey(
  rawValue: string | null | undefined,
  options: { required?: boolean } = {},
): PortalV2IdempotencyKeyResult {
  if (rawValue === null || rawValue === undefined) {
    return options.required === false
      ? Object.freeze({ ok: true, present: false, keyHash: null })
      : Object.freeze({ ok: false, reason: "required" });
  }
  const normalized = normalizePortalV2IdempotencyKey(rawValue);
  if (!normalized) return Object.freeze({ ok: false, reason: "invalid" });
  return Object.freeze({
    ok: true,
    present: true,
    keyHash: hashPortalV2IdempotencyKey(normalized),
  });
}

export function readPortalV2IdempotencyKey(
  headers: Pick<Headers, "get">,
  options: { required?: boolean } = {},
): PortalV2IdempotencyKeyResult {
  return parsePortalV2IdempotencyKey(
    headers.get(PORTAL_V2_IDEMPOTENCY_KEY_HEADER),
    options,
  );
}

export function createPortalV2IdempotencyErrorResponse(
  result: Extract<PortalV2IdempotencyKeyResult, { ok: false }>,
  correlationId: string,
): PortalV2ErrorHttpResponse {
  return createPortalV2ErrorResponse(
    result.reason === "required"
      ? "idempotency_key_required"
      : "invalid_idempotency_key",
    correlationId,
    {
      fieldErrors: {
        idempotencyKey:
          result.reason === "required"
            ? "Start one submission attempt before sending this request."
            : "Use a new 16–200 character request key.",
      },
    },
  );
}
