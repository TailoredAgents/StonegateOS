export type TeamMutationFeedback =
  | { ok: true; message: string }
  | { ok: false; message: string };

type MutationFeedbackOptions = {
  success: string;
  failure: string;
  requireReceipt?: boolean;
};

export type TeamMutationSuccessEnvelope<T = unknown> = {
  ok: true;
  data: T;
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId?: string;
    entityType?: string;
    entityId?: string;
    version?: string | number;
    providerOperationId?: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isTeamMutationSuccessEnvelope<T = unknown>(
  value: unknown,
): value is TeamMutationSuccessEnvelope<T> {
  if (!isRecord(value) || value["ok"] !== true || !("data" in value)) {
    return false;
  }
  const receipt = value["receipt"];
  return (
    isRecord(receipt) &&
    isNonEmptyString(receipt["operationId"]) &&
    isNonEmptyString(receipt["correlationId"]) &&
    isNonEmptyString(receipt["actorId"]) &&
    isNonEmptyString(receipt["committedAt"]) &&
    !Number.isNaN(new Date(receipt["committedAt"]).getTime())
  );
}

export async function readTeamMutationSuccess<T = unknown>(
  response: Response,
): Promise<TeamMutationSuccessEnvelope<T> | null> {
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as unknown;
  return isTeamMutationSuccessEnvelope<T>(payload) ? payload : null;
}

function normalizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/_/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function appendGuidance(message: string, guidance: string): string {
  const trimmed = message.trim().replace(/[.!?]+$/u, "");
  return `${trimmed}. ${guidance}`;
}

async function readResponseDetail(response: Response): Promise<string | null> {
  const data = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;

  return normalizeMessage(data?.message) ?? normalizeMessage(data?.error);
}

export async function readTeamMutationError(
  response: Response,
  fallback: string,
): Promise<string> {
  const detail = await readResponseDetail(response);

  switch (response.status) {
    case 401:
      return "Your session expired. Sign in again, then retry. No change was confirmed.";
    case 403:
      if (detail?.toLowerCase().includes("sign in again")) {
        return appendGuidance(
          detail,
          "Your current page data is unchanged. Sign in again, reopen Partner administration, and retry with the refreshed version.",
        );
      }
      return "You do not have permission to complete this action. Ask an owner for access. No change was confirmed.";
    case 408:
    case 504:
      return appendGuidance(
        detail ?? `${fallback} timed out`,
        "The result could not be confirmed; refresh before retrying to avoid a duplicate.",
      );
    case 409:
      return appendGuidance(
        detail ?? fallback,
        "This record changed since the page loaded. Refresh it and try again.",
      );
    case 422:
      return appendGuidance(
        detail ?? fallback,
        "Check the entered values and try again. No change was confirmed.",
      );
    case 429:
      return appendGuidance(
        detail ?? "Too many attempts",
        "Wait a moment, then retry. No change was confirmed.",
      );
    default:
      if (response.status >= 500) {
        return appendGuidance(
          detail ?? fallback,
          "The service could not confirm the change. Keep your input, wait a moment, then retry.",
        );
      }
      return detail ?? fallback;
  }
}

export function readTeamMutationException(
  error: unknown,
  fallback: string,
): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    return `${fallback} timed out. The result could not be confirmed; refresh before retrying to avoid a duplicate.`;
  }

  if (error instanceof TypeError) {
    return `${fallback}. The service could not be reached. Check your connection and retry; no change was confirmed.`;
  }

  return `${fallback}. The change could not be confirmed. Keep your input and try again.`;
}

export async function resolveTeamMutationFeedback(
  responsePromise: Promise<Response>,
  options: MutationFeedbackOptions,
): Promise<TeamMutationFeedback> {
  try {
    const response = await responsePromise;
    if (!response.ok) {
      return {
        ok: false,
        message: await readTeamMutationError(response, options.failure),
      };
    }

    if (options.requireReceipt) {
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!isTeamMutationSuccessEnvelope(payload)) {
        return {
          ok: false,
          message: `${options.failure}. The service returned an unreadable success receipt, so no success is being claimed. Refresh before retrying.`,
        };
      }
    }

    return { ok: true, message: options.success };
  } catch (error) {
    return {
      ok: false,
      message: readTeamMutationException(error, options.failure),
    };
  }
}
