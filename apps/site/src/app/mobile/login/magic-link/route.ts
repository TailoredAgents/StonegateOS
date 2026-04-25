import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callTeamPublicApi } from "../../../team/login/lib/api";
import { mobileLoginRedirectUrl } from "../lib/redirect";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const formData = await request.formData();
  const identifierRaw = formData.get("identifier");
  const identifier = typeof identifierRaw === "string" ? identifierRaw.trim() : "";
  if (!identifier) {
    return NextResponse.redirect(mobileLoginRedirectUrl(request, "/mobile/login?error=email_or_phone_required"), 303);
  }

  const isEmail = identifier.includes("@");
  await callTeamPublicApi("/api/public/team/request-link", {
    method: "POST",
    body: JSON.stringify({
      ...(isEmail ? { email: identifier } : { phone: identifier }),
      redirectPath: "/mobile/auth"
    })
  });

  return NextResponse.redirect(mobileLoginRedirectUrl(request, "/mobile/login?sent=1"), 303);
}
