import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { callPartnerPublicApi } from "@/app/partners/lib/api";
import { resolvePublicOrigin } from "@/app/partners/lib/origin";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";

async function readBoundedForm(request: NextRequest): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) return null;
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > 2_048) return null;
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
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const origin = resolvePublicOrigin(request);
  const requestOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    (requestOrigin && requestOrigin !== request.nextUrl.origin) ||
    (!requestOrigin && fetchSite && !["same-origin", "none"].includes(fetchSite))
  ) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const form = await readBoundedForm(request);
  const tokenValues = form?.getAll("token") ?? [];
  const rememberValues = form?.getAll("rememberMe") ?? [];
  const exactFields = Boolean(
    form &&
      [...form.keys()].every((key) => ["token", "rememberMe"].includes(key)) &&
      tokenValues.length === 1 &&
      rememberValues.length <= 1,
  );
  const token = exactFields ? (tokenValues[0]?.trim() ?? "") : "";
  const rememberMe = exactFields && rememberValues.length === 1 && rememberValues[0] === "1";
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    return NextResponse.redirect(new URL("/partners/invitations/accept?error=invalid", origin), 303);
  }

  const result = await callPartnerPublicApi("/api/portal/v2/invitations/accept", {
    method: "POST",
    headers: { Origin: origin },
    body: JSON.stringify({ token, rememberMe }),
  }).catch(() => null);
  if (!result?.ok) {
    return NextResponse.redirect(new URL("/partners/invitations/accept?error=invalid", origin), 303);
  }
  const payload = (await result.json().catch(() => null)) as {
    sessionToken?: string;
    expiresAt?: string;
    needsPasswordSetup?: boolean;
  } | null;
  const expiresAt = new Date(payload?.expiresAt ?? "");
  if (!payload?.sessionToken || !Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
    return NextResponse.redirect(new URL("/partners/invitations/accept?error=invalid", origin), 303);
  }
  const destination = new URL("/partners", origin);
  destination.searchParams.set("invited", "1");
  if (payload.needsPasswordSetup) destination.searchParams.set("setup", "1");
  const response = NextResponse.redirect(destination, 303);
  response.cookies.set({
    name: PARTNER_SESSION_COOKIE,
    value: payload.sessionToken,
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
