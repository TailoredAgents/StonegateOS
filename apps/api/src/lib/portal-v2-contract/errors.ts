import {
  isPortalV2CorrelationId,
  PORTAL_V2_CORRELATION_ID_HEADER,
} from "./correlation";

export const PORTAL_V2_ERROR_CODES = [
  "unauthorized",
  "session_expired",
  "session_revoked",
  "forbidden",
  "mfa_step_up_required",
  "account_access_required",
  "account_inactive",
  "legacy_scope_unavailable",
  "not_found",
  "invalid_request",
  "invalid_body",
  "invalid_fields",
  "invalid_cursor",
  "idempotency_key_required",
  "invalid_idempotency_key",
  "idempotency_conflict",
  "if_match_required",
  "invalid_if_match",
  "revision_mismatch",
  "conflict",
  "billing_request_pending",
  "invoice_not_disputable",
  "slot_unavailable",
  "hold_expired",
  "review_required",
  "rate_limited",
  "service_unavailable",
  "internal_error",
] as const;

export type PortalV2ErrorCode = (typeof PORTAL_V2_ERROR_CODES)[number];

export type PortalV2ErrorAlternative = Readonly<{
  action: string;
  label: string;
  href?: string;
}>;

export type PortalV2ErrorEnvelope = Readonly<{
  ok: false;
  error: PortalV2ErrorCode;
  message: string;
  correlationId: string;
  retryable: boolean;
  fieldErrors?: Readonly<Record<string, string>>;
  alternatives?: readonly PortalV2ErrorAlternative[];
}>;

export type PortalV2ErrorHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: PortalV2ErrorEnvelope;
}>;

type ErrorDefinition = Readonly<{
  status: number;
  message: string;
  retryable: boolean;
}>;

const ERROR_DEFINITIONS: Readonly<Record<PortalV2ErrorCode, ErrorDefinition>> =
  {
    unauthorized: {
      status: 401,
      message: "Sign in to continue.",
      retryable: false,
    },
    session_expired: {
      status: 401,
      message: "Your session expired. Sign in again to continue.",
      retryable: false,
    },
    session_revoked: {
      status: 401,
      message: "This session is no longer active. Sign in again to continue.",
      retryable: false,
    },
    forbidden: {
      status: 403,
      message: "You do not have access to this action.",
      retryable: false,
    },
    mfa_step_up_required: {
      status: 403,
      message: "Complete the additional security check to continue.",
      retryable: false,
    },
    account_access_required: {
      status: 403,
      message: "Choose an account you can access to continue.",
      retryable: false,
    },
    account_inactive: {
      status: 403,
      message: "This partner account is not active.",
      retryable: false,
    },
    legacy_scope_unavailable: {
      status: 409,
      message: "This action requires an upgraded partner account.",
      retryable: false,
    },
    not_found: {
      status: 404,
      message: "The requested item could not be found.",
      retryable: false,
    },
    invalid_request: {
      status: 400,
      message: "The request could not be understood.",
      retryable: false,
    },
    invalid_body: {
      status: 400,
      message: "The request body is invalid.",
      retryable: false,
    },
    invalid_fields: {
      status: 422,
      message: "Review the highlighted fields and try again.",
      retryable: false,
    },
    invalid_cursor: {
      status: 422,
      message:
        "This page link is invalid or expired. Return to the first page.",
      retryable: false,
    },
    idempotency_key_required: {
      status: 400,
      message: "A request key is required before this action can be submitted.",
      retryable: false,
    },
    invalid_idempotency_key: {
      status: 400,
      message: "The request key is invalid. Start a new attempt and try again.",
      retryable: false,
    },
    idempotency_conflict: {
      status: 409,
      message: "That request key was already used for different input.",
      retryable: false,
    },
    if_match_required: {
      status: 428,
      message: "Refresh this item before saving your changes.",
      retryable: false,
    },
    invalid_if_match: {
      status: 400,
      message: "The record version is invalid. Refresh and try again.",
      retryable: false,
    },
    revision_mismatch: {
      status: 412,
      message: "This item changed since you opened it. Refresh before saving.",
      retryable: false,
    },
    conflict: {
      status: 409,
      message: "The request conflicts with the current state.",
      retryable: false,
    },
    billing_request_pending: {
      status: 409,
      message: "This invoice already has a billing request under review.",
      retryable: false,
    },
    invoice_not_disputable: {
      status: 409,
      message: "This invoice is not in a state that accepts billing requests.",
      retryable: false,
    },
    slot_unavailable: {
      status: 409,
      message: "That service time is no longer available.",
      retryable: false,
    },
    hold_expired: {
      status: 409,
      message: "The service-time hold expired. Choose an available time again.",
      retryable: false,
    },
    review_required: {
      status: 422,
      message:
        "Stonegate needs to review this request before a service time can be confirmed.",
      retryable: false,
    },
    rate_limited: {
      status: 429,
      message: "Too many attempts were made. Wait before trying again.",
      retryable: true,
    },
    service_unavailable: {
      status: 503,
      message: "This service is temporarily unavailable. Try again shortly.",
      retryable: true,
    },
    internal_error: {
      status: 500,
      message:
        "The request could not be completed. Try again or contact support with the reference ID.",
      retryable: true,
    },
  };

const ERROR_CODE_SET = new Set<string>(PORTAL_V2_ERROR_CODES);
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const ALTERNATIVE_ACTION_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MAX_FIELD_ERRORS = 32;
const MAX_ALTERNATIVES = 8;

function hasDisallowedControlCharacter(
  value: string,
  allowWhitespaceControls: boolean,
): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 127) return true;
    if (allowWhitespaceControls && [9, 10, 13].includes(codePoint))
      return false;
    return codePoint < 32;
  });
}

export function isPortalV2ErrorCode(
  value: unknown,
): value is PortalV2ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

function requiredPublicText(
  value: string,
  maximum: number,
  name: string,
): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    hasDisallowedControlCharacter(normalized, true)
  ) {
    throw new TypeError(`The portal ${name} is invalid.`);
  }
  return normalized;
}

function normalizeFieldErrors(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_FIELD_ERRORS) {
    throw new TypeError("The portal field errors are invalid.");
  }
  const normalized: Record<string, string> = {};
  const seenFields = new Set<string>();
  for (const [field, message] of entries) {
    if (!FIELD_NAME_PATTERN.test(field) || seenFields.has(field)) {
      throw new TypeError("A portal field error is invalid.");
    }
    seenFields.add(field);
    normalized[field] = requiredPublicText(message, 300, "field error");
  }
  return Object.freeze(normalized);
}

function normalizeAlternativeHref(value: string): string {
  const href = value.trim();
  const safeRelativeHref =
    href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\");
  let safeHttpsHref = false;
  if (href.startsWith("https://")) {
    try {
      const parsed = new URL(href);
      safeHttpsHref =
        parsed.protocol === "https:" &&
        parsed.username.length === 0 &&
        parsed.password.length === 0 &&
        parsed.hostname.length > 0;
    } catch {
      safeHttpsHref = false;
    }
  }
  if (
    href.length === 0 ||
    href.length > 500 ||
    hasDisallowedControlCharacter(href, false) ||
    (!safeRelativeHref && !safeHttpsHref)
  ) {
    throw new TypeError("A portal recovery link is invalid.");
  }
  return href;
}

function normalizeAlternatives(
  alternatives: readonly PortalV2ErrorAlternative[] | undefined,
): readonly PortalV2ErrorAlternative[] | undefined {
  if (alternatives === undefined) return undefined;
  if (alternatives.length === 0 || alternatives.length > MAX_ALTERNATIVES) {
    throw new TypeError("The portal recovery alternatives are invalid.");
  }
  const seenActions = new Set<string>();
  return Object.freeze(
    alternatives.map((alternative) => {
      const action = alternative.action.trim();
      if (!ALTERNATIVE_ACTION_PATTERN.test(action) || seenActions.has(action)) {
        throw new TypeError("A portal recovery alternative is invalid.");
      }
      seenActions.add(action);
      return Object.freeze({
        action,
        label: requiredPublicText(alternative.label, 160, "recovery label"),
        ...(alternative.href
          ? { href: normalizeAlternativeHref(alternative.href) }
          : {}),
      });
    }),
  );
}

function normalizeAdditionalHeaders(
  value: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
  };
  for (const [name, rawValue] of Object.entries(value ?? {})) {
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      name.toLowerCase() === PORTAL_V2_CORRELATION_ID_HEADER ||
      name.toLowerCase() === "cache-control" ||
      rawValue.length > 1_024 ||
      hasDisallowedControlCharacter(rawValue, false)
    ) {
      throw new TypeError("An additional portal response header is invalid.");
    }
    headers[name] = rawValue;
  }
  return headers;
}

export function createPortalV2ErrorResponse(
  code: PortalV2ErrorCode,
  correlationId: string,
  options: {
    publicMessage?: string;
    status?: number;
    retryable?: boolean;
    fieldErrors?: Readonly<Record<string, string>>;
    alternatives?: readonly PortalV2ErrorAlternative[];
    retryAfterSeconds?: number;
    additionalHeaders?: Readonly<Record<string, string>>;
  } = {},
): PortalV2ErrorHttpResponse {
  if (!isPortalV2CorrelationId(correlationId)) {
    throw new TypeError("The portal correlation ID is invalid.");
  }
  const definition = ERROR_DEFINITIONS[code];
  const status = options.status ?? definition.status;
  if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
    throw new TypeError("The portal error status is invalid.");
  }
  const fieldErrors = normalizeFieldErrors(options.fieldErrors);
  const alternatives = normalizeAlternatives(options.alternatives);
  const headers = normalizeAdditionalHeaders(options.additionalHeaders);
  headers[PORTAL_V2_CORRELATION_ID_HEADER] = correlationId;
  if (options.retryAfterSeconds !== undefined) {
    if (
      !Number.isSafeInteger(options.retryAfterSeconds) ||
      options.retryAfterSeconds < 1 ||
      options.retryAfterSeconds > 86_400
    ) {
      throw new TypeError("The portal retry delay is invalid.");
    }
    headers["Retry-After"] = String(options.retryAfterSeconds);
  }

  return Object.freeze({
    status,
    headers: Object.freeze(headers),
    body: Object.freeze({
      ok: false,
      error: code,
      message: options.publicMessage
        ? requiredPublicText(options.publicMessage, 500, "error message")
        : definition.message,
      correlationId,
      retryable: options.retryable ?? definition.retryable,
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(alternatives ? { alternatives } : {}),
    }),
  });
}

/** Unknown exceptions are deliberately ignored so their text cannot leak. */
export function createPortalV2UnexpectedErrorResponse(
  correlationId: string,
  _error?: unknown,
): PortalV2ErrorHttpResponse {
  return createPortalV2ErrorResponse("internal_error", correlationId);
}
