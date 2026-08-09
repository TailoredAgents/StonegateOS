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
  });
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  const redirectTo = getSafeRedirectUrl(request, "/team/admin/access#sessions");
  const auth = await requireTeamPrincipal(request, {
    permissions: "access.manage",
    redirectTo,
  });
  if (!auth.ok) return auth.response;

  const formData = await request.formData();
  const scope = readString(formData, "scope");
  const sessionId = readString(formData, "sessionId");
  const memberId = readString(formData, "memberId");
  const idempotencyKey = readString(formData, "idempotencyKey");
  const confirmation = readString(formData, "confirm").toUpperCase();
  if (
    (scope !== "session" && scope !== "member") ||
    (scope === "session" ? !sessionId : !memberId) ||
    !idempotencyKey ||
    confirmation !== "REVOKE"
  ) {
    return redirectWithFlash(
      redirectTo,
      "error",
      'Choose a valid target and type "REVOKE" to confirm.',
    );
  }

  const preserveCurrent =
    scope === "member" &&
    memberId === auth.principal.memberId &&
    formData.get("preserveCurrent") === "1";
  const apiResponse = await callAdminApiAs(
    auth.principal,
    "/api/admin/team/sessions/revoke",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        scope,
        ...(scope === "session" ? { sessionId } : { memberId }),
        preserveCurrent,
      }),
    },
  );
  const payload = (await apiResponse.json().catch(() => null)) as {
    ok?: boolean;
    message?: string;
    data?: { revokedSessionCount?: number };
  } | null;
  if (!apiResponse.ok || payload?.ok !== true) {
    return redirectWithFlash(
      redirectTo,
      "error",
      payload?.message ?? "Sessions could not be revoked safely.",
    );
  }

  const count = Number(payload.data?.revokedSessionCount ?? 0);
  return redirectWithFlash(
    redirectTo,
    "ok",
    count === 0
      ? "Those sessions were already inactive."
      : `${count} session${count === 1 ? "" : "s"} revoked.`,
  );
}
