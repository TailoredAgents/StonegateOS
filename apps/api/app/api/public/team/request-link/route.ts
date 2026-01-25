import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendEmailMessage } from "@/lib/messaging";
import { createTeamLoginToken, findActiveTeamMemberByEmail, normalizeEmail, resolvePublicSiteBaseUrl } from "@/lib/team-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = normalizeEmail(payload?.email);
  if (!email) {
    return NextResponse.json({ ok: false, error: "email_required" }, { status: 400 });
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  const member = await findActiveTeamMemberByEmail(email);

  if (member?.id && siteBaseUrl) {
    try {
      const { rawToken, expiresAt } = await createTeamLoginToken(member.id, request, 30);
      const url = new URL("/team/auth", siteBaseUrl);
      url.searchParams.set("token", rawToken);

      const subject = "Your Stonegate Team Console login link";
      const body = [
        `Hi ${member.name},`,
        "",
        "Here's your secure login link for the Stonegate Team Console:",
        url.toString(),
        "",
        `This link expires at ${expiresAt.toISOString()}.`,
        "",
        "If you didn't request this, you can ignore this email."
      ].join("\n");

      await sendEmailMessage(email, subject, body);
    } catch {
      // Avoid leaking whether an account exists / email deliverability.
    }
  }

  // Always return ok to avoid account enumeration.
  return NextResponse.json({ ok: true });
}

