import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createQuoteAppointmentHold,
  loadPublicQuoteForScheduling,
  PublicQuoteSchedulingError,
} from "@/lib/quote-scheduling";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { normalizePublicQuoteIdempotencyKey } from "@/lib/public-quote-mutation";

const HoldSchema = z
  .object({
    quoteId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    startAt: z.string().datetime(),
  })
  .strict();

function errorResponse(error: unknown, correlationId: string): NextResponse {
  const failure =
    error instanceof PublicQuoteSchedulingError
      ? error
      : new PublicQuoteSchedulingError(
          "internal",
          "The booking time could not be reserved. Try again with the same request.",
        );
  return NextResponse.json(
    {
      ok: false,
      error: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    },
    {
      status: failure.status,
      headers: { "x-correlation-id": correlationId },
    },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const correlationId = randomUUID();
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "missing_token", retryable: false },
      { status: 400, headers: { "x-correlation-id": correlationId } },
    );
  }
  const idempotencyKey = normalizePublicQuoteIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "idempotency_key_required",
        message: "Refresh the quote page before choosing this time again.",
        retryable: false,
      },
      { status: 422, headers: { "x-correlation-id": correlationId } },
    );
  }
  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 2 * 1024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The request could not be read.",
            400,
          );
    return NextResponse.json(
      {
        ok: false,
        error: failure.code,
        message: failure.message,
        retryable: false,
      },
      {
        status: failure.status,
        headers: { "x-correlation-id": correlationId },
      },
    );
  }
  const parsed = HoldSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message:
          "The quote or selected time is invalid. Refresh and try again.",
        retryable: false,
        details: parsed.error.flatten(),
      },
      { status: 422, headers: { "x-correlation-id": correlationId } },
    );
  }

  const quote = await loadPublicQuoteForScheduling(token);
  if (!quote) {
    return NextResponse.json(
      { ok: false, error: "not_found", retryable: false },
      { status: 404, headers: { "x-correlation-id": correlationId } },
    );
  }
  if (quote.id !== parsed.data.quoteId) {
    return NextResponse.json(
      { ok: false, error: "not_found", retryable: false },
      { status: 404, headers: { "x-correlation-id": correlationId } },
    );
  }
  try {
    const result = await createQuoteAppointmentHold({
      quote,
      capabilityToken: token,
      expectedRevision: parsed.data.expectedRevision,
      startAtIso: parsed.data.startAt,
      idempotencyKey,
      correlationId,
    });
    return NextResponse.json(result.data, {
      status: result.responseStatus,
      headers: {
        "x-correlation-id": correlationId,
        ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
      },
    });
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}
