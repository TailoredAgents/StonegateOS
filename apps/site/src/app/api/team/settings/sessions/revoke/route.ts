import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";
import { callAdminApiAs } from "@/app/team/lib/api";

export const dynamic = "force-dynamic";

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function redirectWithFlash(
  target: URL,
  kind: "ok" | "error",
  message: string,
): NextResponse {
  const response = NextResponse.redirect(target, 303);
  response.cookies.set({
    name: kind === "ok" ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/",
    sameSite: "lax",
    httpOnly: true,
  });
  return response;
}

function isConfirmedMutationPayload(value: unknown): value is {
  ok: true;
  data: { revokedSessionCount: number; currentSessionPreserved: true };
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId: string;
    version: string;
  };
} {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  const data = payload["data"] as Record<string, unknown> | undefined;
  const receipt = payload["receipt"] as Record<string, unknown> | undefined;
  return (
    payload["ok"] === true &&
    Boolean(data) &&
    Number.isInteger(data?.["revokedSessionCount"]) &&
    Number(data?.["revokedSessionCount"]) >= 0 &&
    data?.["currentSessionPreserved"] === true &&
    Boolean(receipt) &&
    [
      "operationId",
      "correlationId",
      "actorId",
      "committedAt",
      "auditEventId",
      "version",
    ].every(
      (field) =>
        typeof receipt?.[field] === "string" &&
        String(receipt[field]).trim().length > 0,
    )
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const redirectTo = getSafeRedirectUrl(request, "/team/settings#sessions");
  redirectTo.pathname = "/team/settings";
  redirectTo.search = "";
  redirectTo.hash = "sessions";
  const auth = await requireTeamPrincipal(request, {
    permissions: "sessions.manage_self",
    redirectTo,
  });
  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const idempotencyKey = readString(formData, "idempotencyKey");
  const expectedVersion = readString(formData, "expectedVersion");
  const confirmation = readString(formData, "confirm").toUpperCase();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotencyKey) ||
    !/^[a-f0-9]{64}$/u.test(expectedVersion) ||
    confirmation !== "REVOKE"
  ) {
    return redirectWithFlash(
      redirectTo,
      "error",
      'Refresh the session list and type "REVOKE" to confirm.',
    );
  }

  const apiResponse = await callAdminApiAs(
    auth.principal,
    "/api/admin/team/sessions/self/revoke",
    {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": `"${expectedVersion}"`,
      },
      body: JSON.stringify({ scope: "others" }),
    },
  );
  const payload: unknown = await apiResponse.json().catch(() => null);
  if (!apiResponse.ok || !isConfirmedMutationPayload(payload)) {
    const message =
      payload &&
      typeof payload === "object" &&
      typeof (payload as Record<string, unknown>)["message"] === "string"
        ? String((payload as Record<string, unknown>)["message"])
        : "Other sessions could not be revoked safely. Refresh and try again.";
    return redirectWithFlash(redirectTo, "error", message);
  }

  const count = payload.data.revokedSessionCount;
  return redirectWithFlash(
    redirectTo,
    "ok",
    count === 0
      ? "No other active sessions needed revocation."
      : `${count} other session${count === 1 ? "" : "s"} revoked.`,
  );
}
