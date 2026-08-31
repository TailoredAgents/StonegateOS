import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import {
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
  quoteV2PublicJson,
} from "@/lib/quote-v2-http";
import { getQuoteV2StaffPreview } from "@/lib/quote-v2-management";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return quoteV2ErrorResponse(
      "unauthorized",
      "Your team session is no longer active.",
      { correlationId: quoteV2CorrelationId(request) },
    );
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;
  const correlationId = quoteV2CorrelationId(request);
  if (!isQuoteV2FeatureEnabled("staff")) {
    return quoteV2ErrorResponse(
      "not_found",
      "The versioned quote workspace is not enabled for this cohort.",
      { correlationId },
    );
  }
  const versionId = (await context.params).id?.trim() ?? "";
  if (!UUID_PATTERN.test(versionId)) {
    return quoteV2ErrorResponse(
      "invalid",
      "A valid quote version is required.",
      {
        correlationId,
        fieldErrors: { versionId: "Open a valid proposal version." },
      },
    );
  }
  try {
    const preview = await getQuoteV2StaffPreview(getDb(), versionId);
    if (!preview) {
      return quoteV2ErrorResponse(
        "not_found",
        "The proposal version was not found.",
        {
          correlationId,
        },
      );
    }
    return quoteV2PublicJson({ ok: true, preview }, { correlationId });
  } catch {
    return quoteV2ErrorResponse(
      "internal",
      "The proposal preview could not be loaded. Try again shortly.",
      { correlationId, retryable: true },
    );
  }
}
