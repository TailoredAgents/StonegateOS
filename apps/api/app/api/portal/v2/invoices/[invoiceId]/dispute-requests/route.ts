import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { getDb } from "@/db";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  createPartnerBillingDisputeRequest,
  isPartnerBillingDisputeUuid,
  listPartnerBillingDisputeRequests,
  parsePartnerBillingDisputeHistoryCursor,
  PartnerBillingDisputeError,
  PartnerBillingDisputeRequestBodySchema,
  partnerInvoiceEtag,
} from "@/lib/partner-billing-dispute-requests";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
} from "@/lib/partner-portal-feature-flags";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import { requireRecentPartnerMfaCapability } from "@/lib/partner-recent-mfa";
import {
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

type RouteContext = { params: Promise<{ invoiceId?: string }> };

function errorResponse(error: unknown, correlationId: string): Response {
  if (error instanceof PartnerBillingDisputeError) {
    return createPartnerPortalV2ErrorResponse(
      error.code,
      error.status,
      correlationId,
    );
  }
  return createPartnerPortalV2UnexpectedResponse(correlationId, error);
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "invoices.read",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const invoiceId =
    (await context.params).invoiceId?.trim().toLowerCase() ?? "";
  const { principal } = authorization;
  if (!principal.accountId || !isPartnerBillingDisputeUuid(invoiceId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const cursor = parsePartnerBillingDisputeHistoryCursor(
    request.nextUrl.searchParams.get("cursor"),
    invoiceId,
  );
  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (
    cursor === "invalid" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    return createPartnerPortalV2ErrorResponse(
      cursor === "invalid" ? "invalid_cursor" : "invalid_fields",
      422,
      correlationId,
    );
  }
  try {
    const result = await getDb().transaction((tx) =>
      listPartnerBillingDisputeRequests(tx, {
        principal,
        invoiceId,
        cursor,
        limit,
      }),
    );
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        invoice: {
          id: result.invoice.id,
          number: result.invoice.invoiceNumber.slice(0, 120),
          status: result.invoice.status,
          currency: result.invoice.currency,
          totalMinor: result.invoice.totalCents,
          paidMinor: result.invoice.paidCents,
          balanceMinor: result.invoice.balanceCents,
          revision: result.invoice.version,
        },
        requests: result.items,
        page: {
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        },
      },
      correlationId,
      200,
      {
        ETag: partnerInvoiceEtag({
          invoiceId: result.invoice.id,
          revision: result.invoice.version,
          updatedAt: result.invoice.updatedAt,
        }),
      },
    );
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requireRecentPartnerMfaCapability(
    request,
    "invoices.disputes.request",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const invoiceId =
    (await context.params).invoiceId?.trim().toLowerCase() ?? "";
  const { principal } = authorization;
  if (!principal.accountId || !isPartnerBillingDisputeUuid(invoiceId)) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2ErrorResponse(
      idempotency.reason === "required"
        ? "idempotency_key_required"
        : "invalid_idempotency_key",
      400,
      correlationId,
    );
  }
  if (!idempotency.keyHash) {
    return createPartnerPortalV2ErrorResponse(
      "idempotency_key_required",
      400,
      correlationId,
    );
  }
  const operationKeyHash = idempotency.keyHash;
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 12 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PartnerBillingDisputeRequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        invoiceId,
        category: parsed.data.category,
        reason: parsed.data.reason,
        evidence: parsed.data.evidence,
      }),
      "utf8",
    )
    .digest("hex");
  try {
    const result = await getDb().transaction((tx) =>
      createPartnerBillingDisputeRequest(tx, {
        principal,
        invoiceId,
        payload: parsed.data,
        operationKeyHash,
        requestHash,
        ifMatch: request.headers.get("if-match"),
        correlationId,
      }),
    );
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        request: result.item,
        outcome: {
          state: result.item.state,
          automaticAdjustment: false,
          automaticRefund: false,
          message: result.response.message,
        },
      },
      result.response.correlationId,
      result.response.status,
      {
        ETag: result.response.etag,
        ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
      },
    );
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}
