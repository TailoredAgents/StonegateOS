export const SCHEDULING_ERROR_CODES = [
  "invalid_service_key",
  "invalid_policy",
  "invalid_demand",
  "invalid_interval",
  "invalid_capacity",
  "invalid_candidate_grid",
  "slot_unavailable",
  "review_required",
] as const;

export type SchedulingErrorCode = (typeof SCHEDULING_ERROR_CODES)[number];

export type SchedulingErrorPayload = Readonly<{
  ok: false;
  error: SchedulingErrorCode;
  message: string;
  retryable: boolean;
}>;

const DEFAULT_ERROR_STATUS: Readonly<Record<SchedulingErrorCode, number>> = {
  invalid_service_key: 422,
  invalid_policy: 500,
  invalid_demand: 422,
  invalid_interval: 422,
  invalid_capacity: 500,
  invalid_candidate_grid: 500,
  slot_unavailable: 409,
  review_required: 409,
};

/**
 * A scheduling failure whose externally visible fields are deliberately
 * separated from internal diagnostics. Route adapters may log `cause` and the
 * correlation ID, but must serialize only `toPayload()`.
 */
export class SchedulingDomainError extends Error {
  readonly code: SchedulingErrorCode;
  readonly publicMessage: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: SchedulingErrorCode,
    publicMessage: string,
    options: {
      status?: number;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(
      publicMessage,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SchedulingDomainError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = options.status ?? DEFAULT_ERROR_STATUS[code];
    this.retryable = options.retryable ?? false;
  }

  toPayload(): SchedulingErrorPayload {
    return {
      ok: false,
      error: this.code,
      message: this.publicMessage,
      retryable: this.retryable,
    };
  }
}

export function isSchedulingDomainError(
  value: unknown,
): value is SchedulingDomainError {
  return value instanceof SchedulingDomainError;
}

/** Converts unknown failures without reflecting exception text to callers. */
export function toSafeSchedulingError(value: unknown): SchedulingDomainError {
  if (isSchedulingDomainError(value)) return value;
  return new SchedulingDomainError(
    "invalid_policy",
    "Scheduling is temporarily unavailable. Please try again.",
    { status: 500, retryable: true, cause: value },
  );
}
