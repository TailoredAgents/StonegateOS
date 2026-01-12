import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApi } from "@/app/team/lib/api";
import { getSafeRedirectUrl } from "@/app/api/team/redirects";

const ADMIN_COOKIE = "myst-admin-session";

export const dynamic = "force-dynamic";

function parsePercentToBps(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100);
}

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
  const marketingMemberId = formData.get("marketingMemberId");
  const salesRateBps = parsePercentToBps(formData.get("salesRatePercent"));
  const marketingRateBps = parsePercentToBps(formData.get("marketingRatePercent"));
  const crewPoolRateBps = parsePercentToBps(formData.get("crewPoolRatePercent"));

  if (salesRateBps === null || marketingRateBps === null || crewPoolRateBps === null) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Commission rates must be between 0 and 100",
      path: "/"
    });
    return response;
  }

  const payload: Record<string, unknown> = {
    timezone: "America/New_York",
    payoutWeekday: 5,
    payoutHour: 12,
    payoutMinute: 0,
    salesRateBps,
    marketingRateBps,
    crewPoolRateBps,
    marketingMemberId: typeof marketingMemberId === "string" && marketingMemberId.trim().length > 0 ? marketingMemberId.trim() : null
  };

  const apiResponse = await callAdminApi("/api/admin/commissions/settings", {
    method: "PUT",
    body: JSON.stringify(payload)
  });

  const response = NextResponse.redirect(redirectTo, 303);
  if (!apiResponse.ok) {
    response.cookies.set({
      name: "myst-flash-error",
      value: "Unable to save commission settings",
      path: "/"
    });
    return response;
  }

  response.cookies.set({ name: "myst-flash", value: "Commission settings saved", path: "/" });
  return response;
}
