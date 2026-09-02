import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { callPartnerPublicApi } from "@/app/partners/lib/api";
import { parsePartnerInvitationActivationQueued } from "@/app/partners/lib/invitation-activation";
import { resolvePublicOrigin } from "@/app/partners/lib/origin";
import { PARTNER_INVITATION_TOKEN_COOKIE } from "@/lib/partner-application-session";

function clearInvitationToken(response: NextResponse): void {
  response.cookies.set({
    name: PARTNER_INVITATION_TOKEN_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

function invalidInvitation(origin: string): NextResponse {
  const response = NextResponse.redirect(
    new URL("/partners/invitations/accept?error=invalid", origin),
    303,
  );
  clearInvitationToken(response);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function recoverableInvitationFailure(
  origin: string,
  error: "rate_limited" | "unavailable",
): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/partners/invitations/accept?error=${error}`, origin),
    303,
  );
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

async function readBoundedForm(
  request: NextRequest,
): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) return null;
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > 2_048)
    return null;
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > 2_048) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const origin = resolvePublicOrigin(request);
  const requestOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    requestOrigin
      ? requestOrigin !== request.nextUrl.origin
      : fetchSite !== "same-origin" && fetchSite !== "none"
  ) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const form = await readBoundedForm(request);
  const exactFields = Boolean(form && [...form.keys()].length === 0);
  const token = exactFields
    ? (request.cookies.get(PARTNER_INVITATION_TOKEN_COOKIE)?.value?.trim() ??
      "")
    : "";
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    return invalidInvitation(origin);
  }

  const result = await callPartnerPublicApi(
    "/api/portal/v2/invitations/accept",
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Idempotency-Key": `partner-invitation-accept:${randomUUID()}`,
      },
      body: JSON.stringify({ token }),
    },
  ).catch(() => null);
  if (!result) {
    return recoverableInvitationFailure(origin, "unavailable");
  }
  if (!result.ok) {
    if (result.status === 429) {
      return recoverableInvitationFailure(origin, "rate_limited");
    }
    if (result.status >= 500) {
      return recoverableInvitationFailure(origin, "unavailable");
    }
    return invalidInvitation(origin);
  }
  const payload = parsePartnerInvitationActivationQueued(
    await result.json().catch(() => null),
  );
  if (!payload) {
    return recoverableInvitationFailure(origin, "unavailable");
  }

  const response = NextResponse.redirect(
    new URL("/partners/invitations/accept?accepted=1", origin),
    303,
  );
  clearInvitationToken(response);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
