import {
  normalizeQuoteV2Availability,
  type QuoteV2AvailabilityState,
} from "./quote-v2-customer-model";

export type QuoteV2ActionResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | {
      ok: false;
      message: string;
      fieldErrors: Record<string, string>;
      retryable: boolean;
      status: number;
    };

export interface QuoteV2ChangeInput {
  quoteId: string;
  versionId: string;
  category: "scope" | "pricing" | "timing" | "terms" | "other";
  message: string;
}

export interface QuoteV2RefreshInput {
  quoteId: string;
  versionId: string;
  message?: string | null;
}

export interface QuoteV2AcceptInput {
  decision: "accepted";
  quoteId: string;
  versionId: string;
  selectedOptionIds: string[];
  signer: {
    name: string;
    title: string;
    company?: string | null;
    authorityAffirmed: true;
  };
  consentVersion: string;
  consentAffirmed: true;
  requestedStartAt?: string | null;
  holdId?: string | null;
}

export interface QuoteV2DeclineInput {
  decision: "declined";
  quoteId: string;
  versionId: string;
  category: "price" | "scope" | "timing" | "competitor" | "other";
  notes?: string | null;
  signerName: string;
}

export interface QuoteV2PublicHandlers {
  recordVisibleEngagement(input: {
    quoteId: string;
    versionId: string;
    event: "visible";
    visibleMs: number;
  }): Promise<QuoteV2ActionResult>;
  requestChanges(input: QuoteV2ChangeInput): Promise<QuoteV2ActionResult>;
  requestUpdatedProposal(
    input: QuoteV2RefreshInput,
  ): Promise<QuoteV2ActionResult>;
  accept(input: QuoteV2AcceptInput): Promise<QuoteV2ActionResult>;
  decline(input: QuoteV2DeclineInput): Promise<QuoteV2ActionResult>;
  loadAvailability(): Promise<QuoteV2AvailabilityState>;
  createHold(input: {
    quoteId: string;
    versionId: string;
    responseId?: string | null;
    startAt: string;
    timezone: string;
  }): Promise<QuoteV2ActionResult>;
  createCheckout(input: {
    quoteId: string;
    versionId: string;
    responseId: string;
    holdId?: string | null;
  }): Promise<QuoteV2ActionResult<{ checkoutUrl?: string }>>;
  book(input: {
    quoteId: string;
    versionId: string;
    responseId: string;
    holdId?: string | null;
  }): Promise<QuoteV2ActionResult>;
}

function idempotencyKey(scope: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `quote-v2:${scope}:${uuid}`;
}

function correlationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `quote-v2-${Date.now()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorResult(
  status: number,
  payload: unknown,
): Extract<QuoteV2ActionResult<never>, { ok: false }> {
  if (isRecord(payload)) {
    const rawFieldErrors = payload["fieldErrors"];
    const fieldErrors: Record<string, string> = {};
    if (isRecord(rawFieldErrors)) {
      for (const [key, value] of Object.entries(rawFieldErrors)) {
        if (typeof value === "string") fieldErrors[key] = value;
      }
    }
    return {
      ok: false,
      message:
        typeof payload["message"] === "string"
          ? payload["message"]
          : "We could not complete that request. Please try again.",
      fieldErrors,
      retryable: payload["retryable"] === true,
      status,
    };
  }
  return {
    ok: false,
    message: "We could not complete that request. Please try again.",
    fieldErrors: {},
    retryable: status >= 500,
    status,
  };
}

function unwrapSuccess<T>(payload: unknown): T {
  if (isRecord(payload) && payload["ok"] === true) {
    if (payload["data"] !== undefined) return payload["data"] as T;
    return payload as T;
  }
  if (isRecord(payload) && payload["data"] !== undefined) {
    return payload["data"] as T;
  }
  return (isRecord(payload) ? payload : {}) as T;
}

export function createQuoteV2PublicHandlers(input: {
  token: string;
  fetcher?: typeof fetch;
  basePath?: string;
}): QuoteV2PublicHandlers {
  const fetcher = input.fetcher ?? fetch;
  const basePath =
    input.basePath ?? `/api/public/quotes/${encodeURIComponent(input.token)}`;
  // Keep the same key while the outcome is ambiguous. A lost response may
  // arrive after the server committed, so generating a fresh key on retry
  // would turn one customer action into two records.
  const pendingIdempotencyKeys = new Map<string, string>();

  const post = async <T>(
    path: string,
    scope: string,
    body: object,
  ): Promise<QuoteV2ActionResult<T>> => {
    const serializedBody = JSON.stringify(body);
    const logicalOperation = `${scope}:${serializedBody}`;
    const requestIdempotencyKey =
      pendingIdempotencyKeys.get(logicalOperation) ?? idempotencyKey(scope);
    pendingIdempotencyKeys.set(logicalOperation, requestIdempotencyKey);
    let response: Response;
    try {
      response = await fetcher(`${basePath}${path}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestIdempotencyKey,
          "x-correlation-id": correlationId(),
        },
        body: serializedBody,
      });
    } catch {
      return {
        ok: false,
        message:
          "We could not reach the server. Your information is still here; try again.",
        fieldErrors: {},
        retryable: true,
        status: 503,
      };
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const result = errorResult(response.status, payload);
      if (!result.retryable) pendingIdempotencyKeys.delete(logicalOperation);
      return result;
    }
    pendingIdempotencyKeys.delete(logicalOperation);
    return { ok: true, data: unwrapSuccess<T>(payload) };
  };

  return {
    recordVisibleEngagement: (body) => post("/engagement", "engagement", body),
    requestChanges: (body) => post("/changes", "change", body),
    requestUpdatedProposal: (body) => post("/refresh", "refresh", body),
    accept: (body) => post("", "accept", body),
    decline: (body) => post("", "decline", body),
    createHold: (body) => post("/hold", "hold", body),
    createCheckout: (body) => post("/checkout", "checkout", body),
    book: (body) => post("/book", "book", body),
    async loadAvailability() {
      try {
        const response = await fetcher(`${basePath}/availability`, {
          cache: "no-store",
          headers: { "x-correlation-id": correlationId() },
        });
        if (!response.ok) {
          return {
            kind: "unavailable",
            message:
              "We could not check the calendar. This does not mean appointment windows are full.",
          };
        }
        return normalizeQuoteV2Availability(
          await response.json().catch(() => null),
        );
      } catch {
        return {
          kind: "unavailable",
          message:
            "We could not check the calendar. This does not mean appointment windows are full.",
        };
      }
    },
  };
}
