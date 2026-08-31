import { NextResponse } from "next/server";
import {
  createPortalV2ErrorResponse,
  createPortalV2UnexpectedErrorResponse,
  isPortalV2ErrorCode,
  type PortalV2ErrorHttpResponse,
  type PortalV2ErrorCode,
} from "@/lib/portal-v2-contract";

const VARY_AUTHORIZATION_HEADER = { Vary: "Authorization" } as const;

function fallbackCode(status: number): PortalV2ErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 422) return "invalid_fields";
  if (status >= 500) return "internal_error";
  return "invalid_request";
}

export function createPartnerPortalV2ErrorResponse(
  error: string,
  status: number,
  correlationId: string,
): Response {
  const failure = createPortalV2ErrorResponse(
    isPortalV2ErrorCode(error) ? error : fallbackCode(status),
    correlationId,
    { status },
  );
  return NextResponse.json(failure.body, {
    status: failure.status,
    headers: { ...failure.headers, ...VARY_AUTHORIZATION_HEADER },
  });
}

export function createPartnerPortalV2UnexpectedResponse(
  correlationId: string,
  error?: unknown,
): Response {
  const failure = createPortalV2UnexpectedErrorResponse(correlationId, error);
  return NextResponse.json(failure.body, {
    status: failure.status,
    headers: { ...failure.headers, ...VARY_AUTHORIZATION_HEADER },
  });
}

export function createPartnerPortalV2DescriptorResponse(
  descriptor: PortalV2ErrorHttpResponse,
): Response {
  return NextResponse.json(descriptor.body, {
    status: descriptor.status,
    headers: { ...descriptor.headers, ...VARY_AUTHORIZATION_HEADER },
  });
}

export function createPartnerPortalV2SuccessResponse(
  body: Readonly<Record<string, unknown>>,
  correlationId: string,
  status = 200,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Response {
  return NextResponse.json(
    { ...body, correlationId },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "x-correlation-id": correlationId,
        ...VARY_AUTHORIZATION_HEADER,
        ...additionalHeaders,
      },
    },
  );
}

export function createPartnerPortalV2StoredResponse(
  stored: {
    status: number;
    body: Readonly<Record<string, unknown>>;
    headers?: Readonly<Record<string, string>>;
  },
  correlationId: string,
): Response {
  const error = stored.body["error"];
  if (stored.status >= 400 && typeof error === "string") {
    const failure = createPortalV2ErrorResponse(
      isPortalV2ErrorCode(error) ? error : fallbackCode(stored.status),
      correlationId,
      {
        status: stored.status,
        additionalHeaders: stored.headers,
      },
    );
    return createPartnerPortalV2DescriptorResponse(failure);
  }
  return createPartnerPortalV2SuccessResponse(
    stored.body,
    correlationId,
    stored.status,
    stored.headers,
  );
}
