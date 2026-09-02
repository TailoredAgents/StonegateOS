import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function upstreamPath(segments: string[]): string | null {
  if (segments.length === 1 && segments[0] === "enrollment") {
    return "/api/admin/team/mfa/totp/enrollment";
  }
  if (segments.length === 1 && segments[0] === "step-up") {
    return "/api/admin/team/mfa/step-up";
  }
  if (segments.length === 1 && segments[0] === "revoke") {
    return "/api/admin/team/mfa/revoke";
  }
  if (
    segments.length === 3 &&
    segments[0] === "enrollment" &&
    UUID_PATTERN.test(segments[1] ?? "") &&
    segments[2] === "confirm"
  ) {
    return `/api/admin/team/mfa/totp/enrollment/${segments[1]}/confirm`;
  }
  return null;
}

function proxyResponse(response: Response, body: string): Response {
  return new Response(body, {
    status: response.status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      ...(response.headers.get("retry-after")
        ? { "Retry-After": response.headers.get("retry-after")! }
        : {}),
      ...(response.headers.get("x-correlation-id")
        ? { "x-correlation-id": response.headers.get("x-correlation-id")! }
        : {}),
    },
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "sessions.manage_self",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;
  const path = upstreamPath((await context.params).segments);
  if (!path) {
    return NextResponse.json(
      { ok: false, code: "not_found", message: "Unknown security action." },
      { status: 404 },
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 4_096) {
    return NextResponse.json(
      { ok: false, code: "invalid", message: "Security request is too large." },
      { status: 413 },
    );
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 4_096) {
    return NextResponse.json(
      { ok: false, code: "invalid", message: "Security request is too large." },
      { status: 413 },
    );
  }
  let canonicalBody = "{}";
  try {
    const parsed = body ? (JSON.parse(body) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("invalid body");
    }
    canonicalBody = JSON.stringify(parsed);
  } catch {
    return NextResponse.json(
      { ok: false, code: "invalid", message: "Use a valid security request." },
      { status: 422 },
    );
  }
  try {
    const response = await callAdminApiAs(auth.principal, path, {
      method: "POST",
      body: canonicalBody,
      timeoutMs: 10_000,
    });
    return proxyResponse(response, await response.text());
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "mfa_unavailable",
        message: "Team security is temporarily unavailable.",
        retryable: true,
      },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }
}
