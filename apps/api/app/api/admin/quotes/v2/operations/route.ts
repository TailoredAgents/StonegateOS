import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  loadQuoteV2OperationalSnapshot,
  parseQuoteV2OperationsQuery,
  QuoteV2OperationsInputError,
} from "@/lib/quote-v2-operations";
import {
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
} from "@/lib/quote-v2-http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = quoteV2CorrelationId(request);
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;

  try {
    const query = parseQuoteV2OperationsQuery(request.nextUrl.searchParams);
    const snapshot = await loadQuoteV2OperationalSnapshot(getDb(), query);
    return NextResponse.json(
      { ok: true, correlationId, snapshot },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Correlation-Id": correlationId,
        },
      },
    );
  } catch (error) {
    if (error instanceof QuoteV2OperationsInputError) {
      return quoteV2ErrorResponse(
        "invalid",
        error.message,
        {
          correlationId,
          fieldErrors: { lookbackDays: error.message },
        },
      );
    }
    return quoteV2ErrorResponse(
      "provider_unavailable",
      "Quote operations could not be loaded. Try again.",
      { correlationId, retryable: true },
    );
  }
}
