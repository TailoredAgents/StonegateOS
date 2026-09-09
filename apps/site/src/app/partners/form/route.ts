import { NextRequest, NextResponse } from "next/server";
import { resolvePublicOrigin } from "../lib/origin";
import { POST as onboardingProxy } from "@/app/api/partners/onboarding/[...segments]/route";
import {
  PARTNER_PUBLIC_FORM_ACTIONS,
  parsePartnerPublicForm,
  partnerPublicFormError,
} from "../lib/public-form-policy";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

/** Progressive enhancement fallback. Credentials only travel in bounded POST bodies. */
export async function POST(request: NextRequest): Promise<Response> {
  const browserOrigin = resolvePublicOrigin(request);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    origin
      ? origin !== browserOrigin
      : site !== "same-origin" && site !== "none"
  ) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers: PRIVATE_HEADERS },
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 415, headers: PRIVATE_HEADERS },
    );
  }
  const reader = request.body?.getReader();
  if (!reader)
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => undefined);
        reject(new Error("body_timeout"));
      }, 10_000);
    });
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        failed = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (failed)
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 413, headers: PRIVATE_HEADERS },
    );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: ReturnType<typeof parsePartnerPublicForm> = null;
  let failurePage = "/partners/request-access";
  try {
    const form = new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const operation = form.get("operation") ?? "";
    if (
      Object.prototype.hasOwnProperty.call(
        PARTNER_PUBLIC_FORM_ACTIONS,
        operation,
      )
    )
      failurePage =
        PARTNER_PUBLIC_FORM_ACTIONS[
          operation as keyof typeof PARTNER_PUBLIC_FORM_ACTIONS
        ].page;
    parsed = parsePartnerPublicForm(form);
  } catch {
    /* Never echo credential bodies. */
  }
  if (!parsed)
    return NextResponse.redirect(
      new URL(`${failurePage}?error=invalid_fields`, browserOrigin),
      { status: 303, headers: PRIVATE_HEADERS },
    );
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("idempotency-key", `partner-public-form:${parsed.key}`);
  const upstream = await onboardingProxy(
    new NextRequest(
      new URL(`/api/partners/onboarding/${parsed.endpoint}`, browserOrigin),
      { method: "POST", headers, body: JSON.stringify(parsed.body) },
    ),
    { params: Promise.resolve({ segments: parsed.endpoint.split("/") }) },
  ).catch(() => null);
  const destination = upstream?.ok
    ? parsed.success
    : `${parsed.page}?error=${partnerPublicFormError(upstream?.status ?? 503)}`;
  const response = NextResponse.redirect(new URL(destination, browserOrigin), {
    status: 303,
    headers: PRIVATE_HEADERS,
  });
  // Forward BFF cookie rotation/deletion without exposing returned credentials to HTML.
  if (upstream)
    for (const cookie of upstream.headers.getSetCookie())
      response.headers.append("set-cookie", cookie);
  return response;
}
