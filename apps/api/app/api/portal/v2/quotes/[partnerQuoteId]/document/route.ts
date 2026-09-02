import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { getDb, quotePdfDownloads } from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { getMediaObject } from "@/lib/media-storage";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import { loadCanonicalPartnerQuoteDocument } from "@/lib/partner-portal-v2-quotes";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

function safePdfFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 160);
  return normalized.toLowerCase().endsWith(".pdf")
    ? normalized
    : `${normalized || "proposal"}.pdf`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ partnerQuoteId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "quotes.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  const { partnerQuoteId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(partnerQuoteId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    const document = await loadCanonicalPartnerQuoteDocument({
      principal,
      partnerQuoteId,
    });
    if (
      !document ||
      document.contentType !== "application/pdf" ||
      document.byteSize < 1 ||
      document.byteSize > 50 * 1024 * 1024
    ) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const bytes = await getMediaObject(
      document.storageObjectKey,
      document.byteSize,
    );
    if (
      bytes.byteLength !== document.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== document.sha256
    ) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    await getDb().insert(quotePdfDownloads).values({
      quoteId: document.quoteId,
      quoteVersionId: document.versionId,
      createdAt: new Date(),
    });
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${safePdfFilename(document.filename)}"`,
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
        "x-correlation-id": correlationId,
      },
    });
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
