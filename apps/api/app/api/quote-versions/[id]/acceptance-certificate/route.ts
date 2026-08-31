import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { getMediaObject } from "@/lib/media-storage";
import {
  ensureQuoteAcceptanceCertificateForVersion,
  getQuoteAcceptanceCertificateDocument,
  QuoteAcceptanceCertificateError,
} from "@/lib/quote-v2-acceptance-certificate";
import {
  PUBLIC_QUOTE_HEADERS,
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
} from "@/lib/quote-v2-http";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_CERTIFICATE_BYTES = 25 * 1024 * 1024;

function safeFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 160);
  return normalized.toLowerCase().endsWith(".pdf")
    ? normalized
    : `${normalized || "acceptance-certificate"}.pdf`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const correlationId = quoteV2CorrelationId(request);
  if (!isAdminRequest(request)) {
    return quoteV2ErrorResponse(
      "unauthorized",
      "Your team session is no longer active.",
      { correlationId },
    );
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;
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
        fieldErrors: { versionId: "Open a valid accepted proposal version." },
      },
    );
  }

  try {
    const db = getDb();
    let document = await getQuoteAcceptanceCertificateDocument(db, versionId);
    if (!document) {
      await ensureQuoteAcceptanceCertificateForVersion(db, {
        versionId,
        correlationId,
      });
      document = await getQuoteAcceptanceCertificateDocument(db, versionId);
    }
    if (!document) {
      return quoteV2ErrorResponse(
        "not_found",
        "No acceptance certificate is available for this proposal version.",
        { correlationId },
      );
    }
    if (
      document.contentType !== "application/pdf" ||
      document.byteSize < 1 ||
      document.byteSize > MAX_CERTIFICATE_BYTES
    ) {
      return quoteV2ErrorResponse(
        "provider_unavailable",
        "The acceptance certificate metadata requires reconciliation.",
        { correlationId, retryable: false },
      );
    }
    const bytes = await getMediaObject(
      document.storageObjectKey,
      document.byteSize,
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== document.byteSize || sha256 !== document.sha256) {
      return quoteV2ErrorResponse(
        "provider_unavailable",
        "The acceptance certificate could not be verified.",
        { correlationId, retryable: false },
      );
    }
    const headers = new Headers(PUBLIC_QUOTE_HEADERS);
    headers.set("x-correlation-id", correlationId);
    headers.set("content-type", "application/pdf");
    headers.set("content-length", String(bytes.byteLength));
    headers.set(
      "content-disposition",
      `attachment; filename="${safeFilename(document.filename)}"`,
    );
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  } catch (error) {
    if (
      error instanceof QuoteAcceptanceCertificateError &&
      (error.code === "not_found" || error.code === "not_accepted")
    ) {
      return quoteV2ErrorResponse(
        "not_found",
        "No acceptance certificate is available for this proposal version.",
        { correlationId },
      );
    }
    if (
      error instanceof QuoteAcceptanceCertificateError &&
      error.code === "evidence_mismatch"
    ) {
      return quoteV2ErrorResponse(
        "provider_unavailable",
        "The acceptance certificate evidence requires reconciliation.",
        { correlationId, retryable: false },
      );
    }
    return quoteV2ErrorResponse(
      "provider_unavailable",
      "The acceptance certificate cannot be loaded right now.",
      { correlationId, retryable: true },
    );
  }
}
