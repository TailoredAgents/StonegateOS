import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import {
  createTeamLoginToken,
  findActiveTeamMemberByEmail,
  findActiveTeamMemberByPhone,
  normalizeEmail,
  normalizePhoneE164,
  resolvePublicSiteBaseUrl
} from "@/lib/team-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as
    | { email?: unknown; phone?: unknown; identifier?: unknown }
    | null;

  const email = normalizeEmail(payload?.email ?? payload?.identifier);
  const phoneE164 = normalizePhoneE164(payload?.phone ?? payload?.identifier);
  if (!email && !phoneE164) {
    return NextResponse.json({ ok: false, error: "email_or_phone_required" }, { status: 400 });
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  const member = email
    ? await findActiveTeamMemberByEmail(email)
    : phoneE164
      ? await findActiveTeamMemberByPhone(phoneE164)
      : null;

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

      const smsBody = `Stonegate Team Console login link: ${url.toString()} (expires ${expiresAt.toISOString()})`;

      await Promise.allSettled([
        member.email ? sendEmailMessage(member.email, subject, body) : Promise.resolve(),
        member.phoneE164 ? sendSmsMessage(member.phoneE164, smsBody) : Promise.resolve()
      ]);
    } catch {
      // Avoid leaking whether an account exists / email deliverability.
    }
  }

  // Always return ok to avoid account enumeration.
  return NextResponse.json({ ok: true });
}
