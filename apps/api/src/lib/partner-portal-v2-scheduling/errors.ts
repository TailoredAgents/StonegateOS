import type {
  PortalV2ErrorAlternative,
  PortalV2ErrorCode,
} from "@/lib/portal-v2-contract";

export class PartnerPortalSchedulingError extends Error {
  readonly code: PortalV2ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly alternatives?: readonly PortalV2ErrorAlternative[];
  readonly additionalHeaders?: Readonly<Record<string, string>>;

  constructor(
    code: PortalV2ErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      fieldErrors?: Readonly<Record<string, string>>;
      alternatives?: readonly PortalV2ErrorAlternative[];
      additionalHeaders?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(message);
    this.name = "PartnerPortalSchedulingError";
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.retryable = options.retryable ?? false;
    this.fieldErrors = options.fieldErrors;
    this.alternatives = options.alternatives;
    this.additionalHeaders = options.additionalHeaders;
  }
}

function defaultStatus(code: PortalV2ErrorCode): number {
  switch (code) {
    case "unauthorized":
    case "session_expired":
    case "session_revoked":
      return 401;
    case "forbidden":
    case "account_access_required":
    case "account_inactive":
    case "recent_authentication_required":
      return 403;
    case "not_found":
      return 404;
    case "revision_mismatch":
      return 412;
    case "if_match_required":
      return 428;
    case "invalid_fields":
      return 422;
    case "conflict":
    case "slot_unavailable":
    case "hold_expired":
    case "idempotency_conflict":
      return 409;
    case "review_required":
      return 422;
    case "legacy_scope_unavailable":
      return 409;
    case "service_unavailable":
      return 503;
    case "internal_error":
      return 500;
    default:
      return 400;
  }
}

export function schedulingFieldError(
  fieldErrors: Readonly<Record<string, string>>,
): PartnerPortalSchedulingError {
  return new PartnerPortalSchedulingError(
    "invalid_fields",
    "Review the highlighted fields and try again.",
    { status: 422, fieldErrors },
  );
}
