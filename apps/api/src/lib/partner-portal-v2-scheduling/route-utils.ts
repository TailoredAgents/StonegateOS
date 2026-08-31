import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { BoundedJsonRequestError } from "@/lib/bounded-json-request";
import {
  createPortalV2ErrorResponse,
  isPortalV2ErrorCode,
  type PortalV2ErrorHttpResponse,
} from "@/lib/portal-v2-contract";
import { PartnerPortalSchedulingError } from "./errors";

const RESPONSE_HEADERS = { Vary: "Authorization" } as const;

export function portalSchedulingSuccessResponse(
  body: Readonly<Record<string, unknown>>,
  correlationId: string,
  options: {
    status?: number;
    headers?: Readonly<Record<string, string>>;
  } = {},
): Response {
  return NextResponse.json(
    { ...body, correlationId },
    {
      status: options.status ?? 200,
      headers: {
        "Cache-Control": "no-store",
        "x-correlation-id": correlationId,
        ...RESPONSE_HEADERS,
        ...options.headers,
      },
    },
  );
}

export function portalContractFailureResponse(
  failure: PortalV2ErrorHttpResponse,
): Response {
  return NextResponse.json(failure.body, {
    status: failure.status,
    headers: { ...failure.headers, ...RESPONSE_HEADERS },
  });
}

export function portalAuthorizationFailureResponse(
  failure: Readonly<{ status: number; error: string }>,
  correlationId: string,
): Response {
  const code = isPortalV2ErrorCode(failure.error)
    ? failure.error
    : failure.status === 401
      ? "unauthorized"
      : failure.status === 409
        ? "legacy_scope_unavailable"
        : "forbidden";
  return portalContractFailureResponse(
    createPortalV2ErrorResponse(code, correlationId, {
      status: failure.status,
    }),
  );
}

export function portalSchedulingExceptionResponse(
  error: unknown,
  correlationId: string,
): Response {
  if (error instanceof PartnerPortalSchedulingError) {
    const etag =
      error.additionalHeaders?.["ETag"] ?? error.additionalHeaders?.["etag"];
    return portalContractFailureResponse(
      createPortalV2ErrorResponse(error.code, correlationId, {
        status: error.status,
        retryable: error.retryable,
        publicMessage: error.message,
        fieldErrors: error.fieldErrors,
        alternatives: error.alternatives,
        ...(etag ? { additionalHeaders: { ETag: etag } } : {}),
      }),
    );
  }
  if (error instanceof BoundedJsonRequestError) {
    return portalContractFailureResponse(
      createPortalV2ErrorResponse("invalid_body", correlationId, {
        status: error.status,
        publicMessage: error.message,
      }),
    );
  }
  console.error("[partner-portal-v2-scheduling] request_failed", {
    correlationId,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : undefined,
  });
  return portalContractFailureResponse(
    createPortalV2ErrorResponse("internal_error", correlationId),
  );
}

export function requestIfMatch(request: NextRequest): string | null {
  return request.headers.get("if-match");
}
