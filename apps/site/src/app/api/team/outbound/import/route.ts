import { Buffer } from "node:buffer";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamRequestPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import {
  parseOutboundImportMutationSuccess,
  parseOutboundImportPreviewEnvelope,
} from "@/app/team/lib/outbound-import-result";
import {
  BoundedRequestBodyError,
  readBoundedRequestBytes,
} from "@/app/team/lib/bounded-request";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function readString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function errorResponse(
  status: number,
  code: "invalid" | "timeout" | "internal",
  message: string,
  field?: string,
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code,
      message,
      retryable: code === "timeout" || code === "internal",
      ...(field ? { fieldErrors: { [field]: message } } : {}),
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const correlationId = upstream.headers.get("x-correlation-id");
  const replayed = upstream.headers.get("idempotency-replayed");
  const retryAfter = upstream.headers.get("retry-after");
  if (correlationId) headers.set("x-correlation-id", correlationId);
  if (replayed) headers.set("idempotency-replayed", replayed);
  if (retryAfter) headers.set("retry-after", retryAfter);
  return headers;
}

async function csvBytes(form: FormData): Promise<Uint8Array> {
  const pasted = readString(form, "csv");
  const file = form.get("file");
  const hasFile = file instanceof File && file.size > 0;
  if (pasted && hasFile) {
    throw new Error("choose_one_csv_source");
  }
  if (pasted) return Buffer.from(pasted, "utf8");
  if (hasFile) {
    if (file.size > MAX_BYTES) throw new Error("csv_too_large");
    return new Uint8Array(await file.arrayBuffer());
  }
  throw new Error("csv_required");
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamRequestPrincipal(request, {
    returnJson: true,
    permissions: "outbound.import",
    flashError: "Please sign in again to import outbound prospects.",
  });
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    const body = await readBoundedRequestBytes(request, MAX_REQUEST_BYTES);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return errorResponse(
        422,
        "invalid",
        "The import request must use multipart form data.",
      );
    }
    const formBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(formBody).set(body);
    form = await new Response(formBody, {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch (error) {
    if (
      error instanceof BoundedRequestBodyError &&
      error.reason === "too_large"
    ) {
      return errorResponse(
        413,
        "invalid",
        `The import request exceeds the ${MAX_REQUEST_BYTES.toLocaleString()} byte limit.`,
      );
    }
    return errorResponse(422, "invalid", "The import form is unreadable.");
  }
  const mode = readString(form, "mode");
  if (mode !== "preview" && mode !== "execute") {
    return errorResponse(422, "invalid", "Choose Preview or Import.", "mode");
  }

  let bytes: Uint8Array;
  try {
    bytes = await csvBytes(form);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "csv_required";
    if (reason === "csv_too_large") {
      return errorResponse(
        413,
        "invalid",
        `The CSV exceeds the ${MAX_BYTES.toLocaleString()} byte limit.`,
        "csv",
      );
    }
    if (reason === "choose_one_csv_source") {
      return errorResponse(
        422,
        "invalid",
        "Paste CSV text or upload a file, not both.",
        "csv",
      );
    }
    return errorResponse(
      422,
      "invalid",
      "Paste or upload a CSV file first.",
      "csv",
    );
  }
  if (bytes.length > MAX_BYTES) {
    return errorResponse(
      413,
      "invalid",
      `The CSV exceeds the ${MAX_BYTES.toLocaleString()} byte limit.`,
      "csv",
    );
  }

  const payload: Record<string, unknown> = {
    csvBase64: Buffer.from(bytes).toString("base64"),
    campaign: readString(form, "campaign"),
    assignedToMemberId: readString(form, "assignedToMemberId") || null,
  };
  let endpoint = "/api/admin/outbound/import/preview";
  const headers = new Headers();
  let previewHash = "";
  if (mode === "execute") {
    previewHash = readString(form, "previewHash");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!HASH_PATTERN.test(previewHash)) {
      return errorResponse(
        422,
        "invalid",
        "Preview this exact import again before confirming.",
        "previewHash",
      );
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return errorResponse(
        422,
        "invalid",
        "A stable import request key is required. Preview again.",
        "idempotencyKey",
      );
    }
    payload["previewHash"] = previewHash;
    payload["confirmation"] = readString(form, "confirmation");
    endpoint = "/api/admin/outbound/import";
    headers.set("Idempotency-Key", idempotencyKey);
    headers.set("If-Match", `"${previewHash}"`);
  }

  let upstream: Response;
  try {
    upstream = await callAdminApiAs(auth.principal, endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      timeoutMs: mode === "execute" ? 5 * 60 * 1_000 : 60_000,
    });
  } catch {
    return errorResponse(
      504,
      "timeout",
      mode === "execute"
        ? "The import result could not be confirmed. Keep this preview open and retry with the same request key after checking Outbound."
        : "The preview timed out. No import changes were requested; retry when ready.",
    );
  }

  const upstreamPayload = (await upstream.json().catch(() => null)) as unknown;
  if (!upstream.ok) {
    return NextResponse.json(
      upstreamPayload && typeof upstreamPayload === "object"
        ? upstreamPayload
        : {
            ok: false,
            code: "internal",
            message: "The import service returned an unreadable error.",
            retryable: true,
          },
      { status: upstream.status, headers: responseHeaders(upstream) },
    );
  }

  const valid =
    mode === "preview"
      ? parseOutboundImportPreviewEnvelope(upstreamPayload)
      : parseOutboundImportMutationSuccess(upstreamPayload, previewHash);
  if (!valid) {
    return errorResponse(
      502,
      "internal",
      mode === "execute"
        ? "The service returned an unreadable import receipt. No success is being claimed; check Outbound and Audit before retrying."
        : "The service returned an incomplete preview. No import was requested.",
    );
  }
  return NextResponse.json(upstreamPayload, {
    status: upstream.status,
    headers: responseHeaders(upstream),
  });
}
