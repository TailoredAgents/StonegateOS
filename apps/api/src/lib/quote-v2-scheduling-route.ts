import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import {
  normalizePublicQuoteIdempotencyKey,
  publicQuoteMutationKeyHash,
} from "@/lib/public-quote-mutation";
import {
  PublicQuoteAvailabilityResponseSchema,
  PublicQuoteBookingCommandSchema,
  PublicQuoteHoldCommandSchema,
  type PublicQuoteAvailabilityResponse,
} from "@/lib/quote-v2-contract";
import {
  PUBLIC_QUOTE_HEADERS,
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
  quoteV2PublicJson,
} from "@/lib/quote-v2-http";
import {
  quoteV2PublicRequestHash,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import { limitQuoteV2PublicCandidate } from "@/lib/quote-v2-public-rate-limit";
import { loadQuoteV2CapabilityByHash } from "@/lib/quote-v2-public-service";
import {
  bookQuoteV2AcceptedResponse,
  createQuoteV2AppointmentHold,
  getQuoteV2Availability,
  type QuoteV2Availability,
} from "@/lib/quote-v2-scheduling-service";

export type QuoteV2SchedulingRouteResult =
  | { handled: false }
  | { handled: true; response: Response };

type SchedulingScope = "availability" | "hold" | "book";

const AvailabilityQuerySchema = z
  .object({
    quoteId: z.string().uuid().optional(),
    versionId: z.string().uuid().optional(),
    responseId: z.string().uuid().optional(),
  })
  .strict();

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    fields[issue.path.join(".") || "request"] ??= issue.message;
  }
  return fields;
}

function stateError(
  error: QuoteV2PublicStateError,
  correlationId: string,
): Response {
  return quoteV2ErrorResponse(error.code, error.message, {
    correlationId,
    fieldErrors:
      Object.keys(error.fieldErrors).length > 0 ? error.fieldErrors : undefined,
    retryable: error.code === "provider_unavailable",
  });
}

function unavailableAvailability(
  correlationId: string,
  quoteId: string,
  versionId: string,
): Response {
  return quoteV2PublicJson(
    {
      ok: false,
      code: "provider_unavailable",
      message: "Appointment availability is temporarily unavailable.",
      retryable: true,
      correlationId,
      availability: {
        state: "unavailable",
        quoteId,
        versionId,
        recommendedSlots: [],
        days: [],
      },
    },
    { status: 503, correlationId },
  );
}

function schedulingSuccess(
  body: unknown,
  input: { correlationId: string; status: number; replayed?: boolean },
): Response {
  const headers = new Headers(PUBLIC_QUOTE_HEADERS);
  headers.set("x-correlation-id", input.correlationId);
  if (input.replayed) headers.set("idempotency-replayed", "true");
  return Response.json(body, { status: input.status, headers });
}

/**
 * The Site consumes this exact response shape. Parsing at the API boundary
 * prevents a successful provider result from drifting into an unusable public
 * payload while route/client tests exercise this same production serializer.
 */
export function quoteV2AvailabilityResponseBody(
  availability: QuoteV2Availability,
): PublicQuoteAvailabilityResponse {
  return PublicQuoteAvailabilityResponseSchema.parse({ availability });
}

async function identifyAndLimit(input: {
  request: NextRequest;
  token: string;
  scope: SchedulingScope;
  mutation: boolean;
}): Promise<
  | { handled: false }
  | {
      handled: true;
      response?: Response;
      tokenHash?: string;
      capability?: NonNullable<
        Awaited<ReturnType<typeof loadQuoteV2CapabilityByHash>>
      >;
      correlationId: string;
    }
> {
  const correlationId = quoteV2CorrelationId(input.request);
  const limited = await limitQuoteV2PublicCandidate({
    request: input.request,
    token: input.token,
    scope: input.scope,
    correlationId,
    candidateTokenLimit: input.mutation ? 20 : 120,
    networkLimit: input.mutation ? 120 : 600,
    windowSeconds: input.mutation ? 15 * 60 : 60,
    blockSeconds: input.mutation ? 30 * 60 : 5 * 60,
  });
  if (limited.response) {
    return { handled: true, correlationId, response: limited.response };
  }
  if (!limited.candidate) return { handled: false };
  if (!limited.tokenHash) {
    return {
      handled: true,
      correlationId,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "Proposal scheduling is temporarily unavailable.",
        { correlationId, retryable: true },
      ),
    };
  }
  const tokenHash = limited.tokenHash;
  let capability: Awaited<ReturnType<typeof loadQuoteV2CapabilityByHash>>;
  try {
    capability = await loadQuoteV2CapabilityByHash(getDb(), { tokenHash });
  } catch {
    return {
      handled: true,
      correlationId,
      response: quoteV2ErrorResponse(
        "provider_unavailable",
        "Proposal scheduling is temporarily unavailable.",
        { correlationId, retryable: true },
      ),
    };
  }
  if (!capability) return { handled: false };
  if (
    !isQuoteV2FeatureEnabled("public") ||
    !isQuoteV2FeatureEnabled("booking") ||
    (input.mutation && !isQuoteV2FeatureEnabled("mutations"))
  ) {
    return {
      handled: true,
      correlationId,
      response: quoteV2ErrorResponse(
        "not_found",
        "Proposal scheduling was not found.",
        { correlationId },
      ),
    };
  }
  return {
    handled: true,
    correlationId,
    tokenHash,
    capability,
  };
}

async function readBody(
  request: NextRequest,
  correlationId: string,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return {
      ok: true,
      body: await readBoundedJsonRequest(request, {
        maximumBytes: 8 * 1024,
        rejectDuplicateObjectKeys: true,
      }),
    };
  } catch (error) {
    const message =
      error instanceof BoundedJsonRequestError
        ? error.message
        : "The scheduling request could not be read.";
    return {
      ok: false,
      response: quoteV2ErrorResponse("invalid", message, { correlationId }),
    };
  }
}

function idempotency(
  request: NextRequest,
  correlationId: string,
): { keyHash: string } | { response: Response } {
  const normalized = normalizePublicQuoteIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  if (!normalized) {
    return {
      response: quoteV2ErrorResponse(
        "invalid",
        "An idempotency key is required for this scheduling action.",
        {
          correlationId,
          fieldErrors: {
            idempotencyKey: "Refresh the proposal before trying again.",
          },
        },
      ),
    };
  }
  return { keyHash: publicQuoteMutationKeyHash(normalized) };
}

export async function maybeHandleQuoteV2Availability(
  request: NextRequest,
  token: string,
): Promise<QuoteV2SchedulingRouteResult> {
  const identity = await identifyAndLimit({
    request,
    token,
    scope: "availability",
    mutation: false,
  });
  if (!identity.handled) return identity;
  if (identity.response || !identity.capability || !identity.tokenHash) {
    return {
      handled: true,
      response:
        identity.response ??
        quoteV2ErrorResponse("internal", "Availability could not be loaded.", {
          correlationId: identity.correlationId,
        }),
    };
  }
  const parsed = AvailabilityQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "invalid",
        "The availability request does not match this proposal.",
        {
          correlationId: identity.correlationId,
          fieldErrors: zodFieldErrors(parsed.error),
        },
      ),
    };
  }
  const quoteId = parsed.data.quoteId ?? identity.capability.quoteId;
  const versionId = parsed.data.versionId ?? identity.capability.versionId;
  try {
    const availability = await getQuoteV2Availability({
      tokenHash: identity.tokenHash,
      quoteId,
      versionId,
      responseId: parsed.data.responseId,
    });
    return {
      handled: true,
      response: quoteV2PublicJson(
        quoteV2AvailabilityResponseBody(availability),
        { correlationId: identity.correlationId },
      ),
    };
  } catch (error) {
    if (error instanceof QuoteV2PublicStateError) {
      return {
        handled: true,
        response:
          error.code === "provider_unavailable"
            ? unavailableAvailability(
                identity.correlationId,
                quoteId,
                versionId,
              )
            : stateError(error, identity.correlationId),
      };
    }
    return {
      handled: true,
      response: unavailableAvailability(
        identity.correlationId,
        quoteId,
        versionId,
      ),
    };
  }
}

export async function maybeHandleQuoteV2Hold(
  request: NextRequest,
  token: string,
): Promise<QuoteV2SchedulingRouteResult> {
  const identity = await identifyAndLimit({
    request,
    token,
    scope: "hold",
    mutation: true,
  });
  if (!identity.handled) return identity;
  if (identity.response || !identity.tokenHash) {
    return {
      handled: true,
      response:
        identity.response ??
        quoteV2ErrorResponse("internal", "The hold could not be created.", {
          correlationId: identity.correlationId,
        }),
    };
  }
  const requestIdempotency = idempotency(request, identity.correlationId);
  if ("response" in requestIdempotency) {
    return { handled: true, response: requestIdempotency.response };
  }
  const body = await readBody(request, identity.correlationId);
  if (!body.ok) return { handled: true, response: body.response };
  const parsed = PublicQuoteHoldCommandSchema.safeParse(body.body);
  if (!parsed.success) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "invalid",
        "Choose a current appointment time before continuing.",
        {
          correlationId: identity.correlationId,
          fieldErrors: zodFieldErrors(parsed.error),
        },
      ),
    };
  }
  try {
    const receipt = await createQuoteV2AppointmentHold({
      tokenHash: identity.tokenHash,
      ...parsed.data,
      idempotencyKeyHash: requestIdempotency.keyHash,
      requestHash: quoteV2PublicRequestHash({
        action: "hold",
        command: parsed.data,
      }),
      correlationId: identity.correlationId,
    });
    return {
      handled: true,
      response: schedulingSuccess(
        { hold: receipt },
        {
          status: receipt.replayed ? 200 : 201,
          correlationId: identity.correlationId,
          replayed: receipt.replayed,
        },
      ),
    };
  } catch (error) {
    return {
      handled: true,
      response:
        error instanceof QuoteV2PublicStateError
          ? stateError(error, identity.correlationId)
          : quoteV2ErrorResponse(
              "provider_unavailable",
              "The appointment hold could not be created. Try again shortly.",
              { correlationId: identity.correlationId, retryable: true },
            ),
    };
  }
}

export async function maybeHandleQuoteV2Book(
  request: NextRequest,
  token: string,
): Promise<QuoteV2SchedulingRouteResult> {
  const identity = await identifyAndLimit({
    request,
    token,
    scope: "book",
    mutation: true,
  });
  if (!identity.handled) return identity;
  if (identity.response || !identity.tokenHash) {
    return {
      handled: true,
      response:
        identity.response ??
        quoteV2ErrorResponse(
          "internal",
          "The booking could not be completed.",
          {
            correlationId: identity.correlationId,
          },
        ),
    };
  }
  const requestIdempotency = idempotency(request, identity.correlationId);
  if ("response" in requestIdempotency) {
    return { handled: true, response: requestIdempotency.response };
  }
  const body = await readBody(request, identity.correlationId);
  if (!body.ok) return { handled: true, response: body.response };
  const parsed = PublicQuoteBookingCommandSchema.safeParse(body.body);
  if (!parsed.success) {
    return {
      handled: true,
      response: quoteV2ErrorResponse(
        "invalid",
        "The accepted proposal or appointment hold is incomplete.",
        {
          correlationId: identity.correlationId,
          fieldErrors: zodFieldErrors(parsed.error),
        },
      ),
    };
  }
  try {
    const receipt = await bookQuoteV2AcceptedResponse({
      tokenHash: identity.tokenHash,
      ...parsed.data,
      idempotencyKeyHash: requestIdempotency.keyHash,
      requestHash: quoteV2PublicRequestHash({
        action: "book",
        command: parsed.data,
      }),
      correlationId: identity.correlationId,
    });
    return {
      handled: true,
      response: schedulingSuccess(
        { booking: receipt },
        {
          status: receipt.replayed ? 200 : 201,
          correlationId: identity.correlationId,
          replayed: receipt.replayed,
        },
      ),
    };
  } catch (error) {
    return {
      handled: true,
      response:
        error instanceof QuoteV2PublicStateError
          ? stateError(error, identity.correlationId)
          : quoteV2ErrorResponse(
              "provider_unavailable",
              "The appointment could not be confirmed. Retry with the same request key.",
              { correlationId: identity.correlationId, retryable: true },
            ),
    };
  }
}
