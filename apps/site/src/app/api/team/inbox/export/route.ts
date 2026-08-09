import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import {
  canonicalConversationExportQuery,
  ConversationExportBodyTimeoutError,
  finalizeSiteConversationExport,
  isSameOriginConversationExportRequest,
  parseConversationExportError,
  parseConversationExportReceipt,
  readBoundedExportResponse,
  readSiteConversationExportConfirmation,
  SITE_CONVERSATION_EXPORT_MAX_BODY_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_ERROR_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_LINE_BYTES,
  SITE_CONVERSATION_EXPORT_MAX_MESSAGES,
  SITE_CONVERSATION_EXPORT_MAX_THREADS,
  validateConversationJsonl,
  type SiteConversationExportFinalizationReason,
  type SiteConversationExportReceipt,
} from "@/app/team/lib/conversation-export";
import type { TeamRequestPrincipal } from "@/lib/team-principal";

export const dynamic = "force-dynamic";

const EXPORT_DEADLINE_MS = 60_000;

function proxyError(
  status: number,
  error: string,
  message: string,
  correlationId: string,
  retryable: boolean,
): NextResponse {
  return NextResponse.json(
    {
      error,
      message,
      correlationId,
      supportId: correlationId,
      retryable,
      truncated: false,
    },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Audit-Correlation-Id": correlationId,
      },
    },
  );
}

function millisecondsRemaining(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function cancelUpstreamBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best-effort only; the proxy still refuses to release any bytes.
  }
}

async function finalizeExport(input: {
  principal: TeamRequestPrincipal;
  correlationId: string;
  exportId: string | null;
  outcome: "released" | "failed";
  reason: SiteConversationExportFinalizationReason;
  deadlineAt: number;
}): Promise<boolean> {
  return finalizeSiteConversationExport({
    correlationId: input.correlationId,
    exportId: input.exportId,
    outcome: input.outcome,
    reason: input.reason,
    deadlineAt: input.deadlineAt,
    invoke: ({ body, correlationId, timeoutMs }) =>
      callAdminApiAs(input.principal, "/api/admin/inbox/export/jsonl", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "x-request-id": correlationId,
        },
        body,
        timeoutMs,
      }),
  });
}

async function bestEffortFailedFinalization(input: {
  principal: TeamRequestPrincipal;
  correlationId: string;
  exportId: string | null;
  reason: Exclude<SiteConversationExportFinalizationReason, null>;
}): Promise<void> {
  // Failure evidence must not delay a truthful error indefinitely. It gets a
  // fresh, tightly bounded window after the export body has already been
  // cancelled or rejected.
  await finalizeExport({
    ...input,
    outcome: "failed",
    deadlineAt: Date.now() + 3_000,
  });
}

function releasedHeaders(receipt: SiteConversationExportReceipt): HeadersInit {
  return {
    "Content-Type": receipt.contentType,
    "Content-Disposition": receipt.contentDisposition,
    "Content-Length": String(receipt.byteCount),
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "X-Download-Options": "noopen",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Export-Format-Version": "1",
    "X-Export-Receipt-Id": receipt.receiptId,
    "X-Export-Row-Count": String(receipt.rowCount),
    "X-Export-Thread-Count": String(receipt.threadCount),
    "X-Export-Message-Count": String(receipt.messageCount),
    "X-Export-Byte-Count": String(receipt.byteCount),
    "X-Export-Maximum-Messages": String(SITE_CONVERSATION_EXPORT_MAX_MESSAGES),
    "X-Export-Maximum-Threads": String(SITE_CONVERSATION_EXPORT_MAX_THREADS),
    "X-Export-Maximum-Body-Bytes": String(
      SITE_CONVERSATION_EXPORT_MAX_BODY_BYTES,
    ),
    "X-Export-Maximum-Line-Bytes": String(
      SITE_CONVERSATION_EXPORT_MAX_LINE_BYTES,
    ),
    "X-Export-Maximum-Bytes": String(SITE_CONVERSATION_EXPORT_MAX_BYTES),
    "X-Export-Truncated": "false",
    "X-Export-Audit-State": "released",
    "X-Audit-Correlation-Id": receipt.correlationId,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = crypto.randomUUID();
  const deadlineAt = Date.now() + EXPORT_DEADLINE_MS;

  if (!isSameOriginConversationExportRequest(request)) {
    return proxyError(
      403,
      "invalid_origin",
      "The export request origin could not be verified. No file was released.",
      correlationId,
      false,
    );
  }

  const auth = await requireTeamPrincipal(request, {
    permissions: "messages.export",
    returnJson: true,
  });
  if (!auth.ok) {
    return proxyError(
      auth.response.status === 403 ? 403 : 401,
      auth.response.status === 403 ? "forbidden" : "unauthorized",
      auth.response.status === 403
        ? "You do not have permission to export conversation data."
        : "Sign in again before exporting conversation data.",
      correlationId,
      false,
    );
  }

  let confirmed: boolean;
  try {
    confirmed = await readSiteConversationExportConfirmation(request, {
      deadlineAt,
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof ConversationExportBodyTimeoutError) {
      return proxyError(
        408,
        "confirmation_timeout",
        "The export confirmation timed out. No file was released.",
        correlationId,
        true,
      );
    }
    confirmed = false;
  }
  if (!confirmed) {
    return proxyError(
      422,
      "confirmation_required",
      "Confirm the sensitive export before requesting it.",
      correlationId,
      false,
    );
  }

  const canonical = canonicalConversationExportQuery(
    request.nextUrl.searchParams,
  );
  if (!canonical.ok) {
    return proxyError(
      422,
      "invalid_filter",
      canonical.message,
      correlationId,
      false,
    );
  }

  let upstream: Response;
  try {
    upstream = await callAdminApiAs(
      auth.principal,
      `/api/admin/inbox/export/jsonl?${canonical.query}`,
      {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "x-request-id": correlationId,
        },
        body: JSON.stringify({ confirmed: true }),
        timeoutMs: millisecondsRemaining(deadlineAt),
      },
    );
  } catch {
    return proxyError(
      Date.now() >= deadlineAt ? 504 : 502,
      Date.now() >= deadlineAt
        ? "conversation_export_timeout"
        : "conversation_export_unavailable",
      Date.now() >= deadlineAt
        ? "The conversation export timed out. No file was released."
        : "The conversation export service could not be reached. No file was released.",
      correlationId,
      true,
    );
  }

  if (!upstream.ok) {
    let errorBytes: Uint8Array | null;
    try {
      errorBytes = await readBoundedExportResponse(
        upstream,
        SITE_CONVERSATION_EXPORT_MAX_ERROR_BYTES,
        undefined,
        { deadlineAt, signal: request.signal },
      );
    } catch (error) {
      if (error instanceof ConversationExportBodyTimeoutError) {
        return proxyError(
          504,
          "conversation_export_error_timeout",
          "The export service error response timed out. No file was released.",
          correlationId,
          true,
        );
      }
      errorBytes = null;
    }
    const error = parseConversationExportError(
      errorBytes,
      upstream.headers,
      correlationId,
    );
    if (!error) {
      return proxyError(
        502,
        "malformed_conversation_export_error",
        "The conversation service returned an invalid error response. No file was released.",
        correlationId,
        true,
      );
    }
    return proxyError(
      upstream.status,
      error.error,
      error.message,
      error.correlationId,
      error.retryable,
    );
  }

  const receipt = parseConversationExportReceipt(
    upstream.headers,
    correlationId,
    "prepared",
  );
  if (!receipt) {
    cancelUpstreamBody(upstream);
    await bestEffortFailedFinalization({
      principal: auth.principal,
      correlationId,
      exportId: null,
      reason: "invalid_receipt",
    });
    return proxyError(
      502,
      "malformed_conversation_export_receipt",
      "The conversation service returned an invalid export receipt. No file was released.",
      correlationId,
      true,
    );
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedExportResponse(
      upstream,
      SITE_CONVERSATION_EXPORT_MAX_BYTES,
      receipt.byteCount,
      { deadlineAt, signal: request.signal },
    );
  } catch (error) {
    if (error instanceof ConversationExportBodyTimeoutError) {
      await bestEffortFailedFinalization({
        principal: auth.principal,
        correlationId,
        exportId: receipt.receiptId,
        reason: "body_timeout",
      });
      return proxyError(
        504,
        "conversation_export_body_timeout",
        "The export body timed out before it was complete. No file was released.",
        correlationId,
        true,
      );
    }
    bytes = null;
  }
  if (!bytes || !validateConversationJsonl(bytes, receipt)) {
    await bestEffortFailedFinalization({
      principal: auth.principal,
      correlationId,
      exportId: receipt.receiptId,
      reason: "invalid_body",
    });
    return proxyError(
      502,
      "malformed_conversation_export",
      "The conversation service returned an invalid or oversized JSONL file. No file was released.",
      correlationId,
      true,
    );
  }

  const released = await finalizeExport({
    principal: auth.principal,
    correlationId,
    exportId: receipt.receiptId,
    outcome: "released",
    reason: null,
    deadlineAt,
  });
  if (!released) {
    return proxyError(
      502,
      "conversation_export_release_audit_failed",
      "The complete file could not be paired with a released audit receipt. No file was released.",
      correlationId,
      true,
    );
  }

  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: releasedHeaders({ ...receipt, auditState: "released" }),
  });
}
