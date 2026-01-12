import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

const ADMIN_COOKIE = "myst-admin-session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const jar = request.cookies;
  const hasOwner = Boolean(jar.get(ADMIN_COOKIE)?.value);
  const redirectTo = getSafeRedirectUrl(request, "/team?tab=commissions");

  if (!hasOwner) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Owner login required.",
      path: "/"
    });
    return response;
  }

  const formData = await request.formData();
  const action = formData.get("action");
  const payoutRunId = formData.get("payoutRunId");

  if (action === "create") {
    const res = await callAdminApi("/api/admin/commissions/payout-runs", { method: "POST" });
    const response = NextResponse.redirect(redirectTo, 303);
    if (!res.ok) {
      response.cookies.set({ name: "myst-flash-error", value: "Unable to create payout run", path: "/" });
      return response;
    }
    response.cookies.set({ name: "myst-flash", value: "Payout run created", path: "/" });
    return response;
  }

  if (typeof payoutRunId !== "string" || payoutRunId.trim().length === 0) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({ name: "myst-flash-error", value: "Payout run ID missing", path: "/" });
    return response;
  }

  if (action === "lock") {
    const res = await callAdminApi(`/api/admin/commissions/payout-runs/${payoutRunId.trim()}/lock`, {
      method: "POST"
    });
    const response = NextResponse.redirect(redirectTo, 303);
    if (!res.ok) {
      response.cookies.set({ name: "myst-flash-error", value: "Unable to lock payout run", path: "/" });
      return response;
    }
    response.cookies.set({ name: "myst-flash", value: "Payout run locked", path: "/" });
    return response;
  }

  if (action === "paid") {
    const res = await callAdminApi(`/api/admin/commissions/payout-runs/${payoutRunId.trim()}/mark-paid`, {
      method: "POST"
    });
    const response = NextResponse.redirect(redirectTo, 303);
    if (!res.ok) {
      response.cookies.set({ name: "myst-flash-error", value: "Unable to mark payout run paid", path: "/" });
      return response;
    }
    response.cookies.set({ name: "myst-flash", value: "Payout run marked paid", path: "/" });
    return response;
  }

  const response = NextResponse.redirect(redirectTo, 303);
  response.cookies.set({ name: "myst-flash-error", value: "Unknown payout action", path: "/" });
  return response;
}
