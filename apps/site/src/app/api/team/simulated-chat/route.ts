import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import {
  BoundedRequestBodyError,
  readBoundedRequestBytes,
} from "@/app/team/lib/bounded-request";

export const dynamic = "force-dynamic";

const MAX_SIMULATED_CHAT_REQUEST_BYTES = 96 * 1024;
const PRIVATE_NO_STORE = "private, no-store, max-age=0";

function proxyError(
  status: number,
  error: string,
  message: string,
): NextResponse {
  return NextResponse.json(
    { ok: false, error, message },
    { status, headers: { "Cache-Control": PRIVATE_NO_STORE } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "automation.simulate",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    return proxyError(
      415,
      "unsupported_media_type",
      "This endpoint accepts application/json only.",
    );
  }
  const contentEncoding =
    request.headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    return proxyError(
      415,
      "unsupported_media_type",
      "Compressed request bodies are not supported.",
    );
  }

  let body: string;
  try {
    const bytes = await readBoundedRequestBytes(
      request,
      MAX_SIMULATED_CHAT_REQUEST_BYTES,
    );
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const tooLarge =
      error instanceof BoundedRequestBodyError && error.reason === "too_large";
    return proxyError(
      tooLarge ? 413 : 400,
      tooLarge ? "body_too_large" : "invalid_body",
      tooLarge
        ? "The simulation request is too large."
        : "The simulation request could not be read.",
    );
  }

  let apiResponse: Response;
  try {
    apiResponse = await callAdminApiAs(
      auth.principal,
      "/api/admin/sales/simulated-chat",
      {
        method: "POST",
        body,
        timeoutMs: 10_000,
      },
    );
  } catch (error) {
    const timeout = error instanceof Error && error.name === "AbortError";
    return proxyError(
      timeout ? 504 : 502,
      timeout ? "simulation_timeout" : "simulation_unavailable",
      timeout
        ? "The simulation timed out. No CRM changes were made."
        : "The simulation service is unavailable. No CRM changes were made.",
    );
  }
  const payload = (await apiResponse.json().catch(() => null)) as unknown;
  const validSuccess =
    isRecord(payload) && payload["ok"] === true && isRecord(payload["result"]);
  const validFailure =
    isRecord(payload) &&
    payload["ok"] !== true &&
    typeof payload["error"] === "string";
  if ((!apiResponse.ok && !validFailure) || (apiResponse.ok && !validSuccess)) {
    return proxyError(
      502,
      "invalid_simulation_response",
      "The simulation service returned an invalid response. No CRM changes were made.",
    );
  }

  return NextResponse.json(payload, {
    status: apiResponse.status,
    headers: {
      "Cache-Control": PRIVATE_NO_STORE,
    },
  });
}
