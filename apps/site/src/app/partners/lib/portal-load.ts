import {
  portalSupportReference,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
} from "./portal-v2";

export type PortalLoadError = {
  status: "error";
  reason:
    | "auth"
    | "permission"
    | "disabled"
    | "unavailable"
    | "invalid_response"
    | "not_found";
  correlationId: string | null;
  httpStatus: number | null;
  code: string | null;
};
export type PortalLoadResult<T> =
  | { status: "ok"; value: T; response: Response }
  | PortalLoadError;

export function isPortalRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A failed or incomplete response must never become an empty collection. */
export async function loadPartnerPortalResource<T>(
  fetchResponse: () => Promise<Response>,
  parse: (payload: unknown) => T | null,
): Promise<PortalLoadResult<T>> {
  let response: Response;
  try {
    response = await fetchResponse();
  } catch {
    return {
      status: "error",
      reason: "unavailable",
      correlationId: null,
      httpStatus: null,
      code: null,
    };
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = isPortalRecord(payload) ? payload : {};
  const correlationId =
    portalSupportReferenceFromResponse(response) ??
    portalSupportReference(
      typeof record["correlationId"] === "string"
        ? record["correlationId"]
        : null,
    );
  const code = typeof record["error"] === "string" ? record["error"] : null;
  if (!response.ok) {
    const disabled =
      code !== null &&
      [
        "feature_disabled",
        "portal_v2_disabled",
        "portal_v2_reads_disabled",
        "portal_v2_writes_disabled",
        "portal_reads_disabled",
        "portal_writes_disabled",
        "tool_disabled",
      ].includes(code);
    const reason: PortalLoadError["reason"] =
      response.status === 401
        ? "auth"
        : disabled
          ? "disabled"
          : response.status === 403
            ? "permission"
            : response.status === 404
              ? "not_found"
              : "unavailable";
    return {
      status: "error",
      reason,
      correlationId,
      httpStatus: response.status,
      code,
    };
  }
  let value: T | null = null;
  if (record["ok"] === true) {
    try {
      value = parse(payload);
    } catch {
      /* Treat invalid nested data as an incomplete response. */
    }
  }
  return value === null
    ? {
        status: "error",
        reason: "invalid_response",
        correlationId,
        httpStatus: response.status,
        code,
      }
    : { status: "ok", value, response };
}

export function portalLoadErrorMessage(
  error: PortalLoadError,
  fallback: string,
): string {
  const message =
    error.reason === "auth"
      ? "Your sign-in has expired. Sign in again to continue."
      : error.reason === "permission"
        ? "Your role does not include this information. Ask your company administrator for access."
        : error.reason === "disabled"
          ? "This part of the portal is temporarily unavailable. Contact Stonegate for help."
          : fallback;
  return withPortalSupportReference(message, error.correlationId);
}

export function parsePortalCollection<T>(
  payload: unknown,
  key: string,
  isItem: (value: unknown) => value is T,
): { items: T[]; nextCursor: string | null } | null {
  if (!isPortalRecord(payload) || payload["ok"] !== true) return null;
  const items = payload[key];
  const page = payload["page"];
  if (
    !Array.isArray(items) ||
    !items.every(isItem) ||
    !isPortalRecord(page) ||
    !(page["nextCursor"] === null || typeof page["nextCursor"] === "string") ||
    (page["hasMore"] !== undefined && typeof page["hasMore"] !== "boolean")
  )
    return null;
  return {
    items,
    nextCursor: page["hasMore"] === false ? null : page["nextCursor"],
  };
}
