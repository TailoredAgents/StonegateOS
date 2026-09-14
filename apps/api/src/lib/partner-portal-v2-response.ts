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
  operation = "portal_request",
): Response {
  // Database wrappers can contain SQL, credentials and submitted values. Log
  // only a fixed classification, never exception text, stack or request data.
  let category = "unexpected";
  let errorType: string | null = null;
  let errorCode: string | null = null;
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === "object";
    depth += 1
  ) {
    const record = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const code = typeof record.code === "string" ? record.code : "";
    if (
      typeof record.name === "string" &&
      [
        "TypeError",
        "RangeError",
        "SyntaxError",
        "ReferenceError",
        "PostgresError",
        "DrizzleQueryError",
      ].includes(record.name)
    ) {
      errorType = record.name;
    }
    if (
      [
        "ERR_INVALID_ARG_TYPE",
        "ERR_OUT_OF_RANGE",
        "ERR_INVALID_URL",
        "22007",
        "22008",
        "22P02",
        "23502",
        "23503",
        "23505",
        "23514",
        "40001",
        "40P01",
        "42601",
        "42804",
        "42P01",
        "42703",
        "42883",
        "08000",
        "08001",
        "08003",
        "08006",
        "53300",
        "57P01",
        "57014",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
      ].includes(code)
    ) {
      errorCode = code;
    }
    if (["42P01", "42703", "42883"].includes(code)) {
      category = "database_schema";
      break;
    }
    if (
      [
        "08000",
        "08001",
        "08003",
        "08006",
        "53300",
        "57P01",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
      ].includes(code)
    ) {
      category = "database_connection";
      break;
    }
    if (record.code === "57014") {
      category = "database_timeout";
      break;
    }
    current = record.cause;
  }
  console.error("[partner-portal-v2] request failed", {
    correlationId,
    operation,
    category,
    ...(errorType ? { errorType } : {}),
    ...(errorCode ? { errorCode } : {}),
  });
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
