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
      path: "/",
    });
    return response;
  }

  const formData = await request.formData();
  const action =
    typeof formData.get("action") === "string"
      ? formData.get("action")!.toString().trim()
      : "";
  const localDate =
    typeof formData.get("localDate") === "string"
      ? formData.get("localDate")!.toString().trim()
      : "";

  if (!localDate) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Override date is required.",
      path: "/",
    });
    return response;
  }

  if (action === "delete") {
    const apiResponse = await callAdminApi(
      "/api/admin/commissions/crew-pool-overrides",
      {
        method: "DELETE",
        body: JSON.stringify({ localDate }),
      },
    );

    const response = NextResponse.redirect(redirectTo, 303);
    if (!apiResponse.ok) {
      let message = "Unable to delete labor override day.";
      try {
        const payload = (await apiResponse.json()) as {
          error?: string;
          message?: string;
        };
        const candidate = payload.message ?? payload.error;
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          message = candidate;
        }
      } catch {
        // ignore
      }
      response.cookies.set({
        name: "myst-flash-error",
        value: message,
        path: "/",
      });
      return response;
    }

    response.cookies.set({
      name: "myst-flash",
      value: "Labor override day deleted.",
      path: "/",
    });
    return response;
  }

  const crewPoolRateBps = parsePercentToBps(
    formData.get("crewPoolRatePercent"),
  );
  if (crewPoolRateBps === null) {
    const response = NextResponse.redirect(redirectTo, 303);
    response.cookies.set({
      name: "myst-flash-error",
      value: "Labor override percent must be between 0 and 100.",
      path: "/",
    });
    return response;
  }

  const note =
    typeof formData.get("note") === "string"
      ? formData.get("note")!.toString().trim()
      : "";

  const apiResponse = await callAdminApi(
    "/api/admin/commissions/crew-pool-overrides",
    {
      method: "POST",
      body: JSON.stringify({
        localDate,
        crewPoolRateBps,
        note: note.length > 0 ? note : null,
      }),
    },
  );

  const response = NextResponse.redirect(redirectTo, 303);
  if (!apiResponse.ok) {
    let message = "Unable to save labor override day.";
    try {
      const payload = (await apiResponse.json()) as {
        error?: string;
        message?: string;
      };
      const candidate = payload.message ?? payload.error;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        message = candidate;
      }
    } catch {
      // ignore
    }
    response.cookies.set({
      name: "myst-flash-error",
      value: message,
      path: "/",
    });
    return response;
  }

  response.cookies.set({
    name: "myst-flash",
    value: "Labor override day saved and payouts recalculated.",
    path: "/",
  });
  return response;
}
