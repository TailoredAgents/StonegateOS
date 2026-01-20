import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import {
  createPartnerLoginToken,
  findActivePartnerUserByEmail,
  findActivePartnerUserByPhone,
  normalizeEmail,
  normalizePhoneE164,
  resolvePublicSiteBaseUrl
} from "@/lib/partner-portal-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as { email?: unknown; phone?: unknown } | null;

  const email = normalizeEmail(payload?.email);
  const phoneE164 = normalizePhoneE164(payload?.phone);
  if (!email && !phoneE164) {
    return NextResponse.json({ ok: false, error: "email_or_phone_required" }, { status: 400 });
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  const user = email
    ? await findActivePartnerUserByEmail(email)
    : phoneE164
      ? await findActivePartnerUserByPhone(phoneE164)
      : null;

  if (user?.id && siteBaseUrl) {
    try {
      const { rawToken, expiresAt } = await createPartnerLoginToken(user.id, request, 30);
      const url = new URL("/partners/auth", siteBaseUrl);
      url.searchParams.set("token", rawToken);

      const subject = "Your Stonegate Partner Portal login link";
      const body = [
        `Hi ${user.name},`,
        "",
        "Here's your secure login link for the Stonegate Partner Portal:",
        url.toString(),
        "",
        `This link expires at ${expiresAt.toISOString()}.`,
        "",
        "If you didn't request this, you can ignore this email."
      ].join("\n");

      const smsBody = `Stonegate Partner Portal login link: ${url.toString()} (expires ${expiresAt.toISOString()})`;

      await Promise.allSettled([
        sendEmailMessage(user.email, subject, body),
        user.phoneE164 ? sendSmsMessage(user.phoneE164, smsBody) : Promise.resolve()
      ]);
    } catch {
      // Intentionally ignore to avoid leaking whether an account exists.
    }
  }

  // Always return ok to avoid account enumeration.
  return NextResponse.json({ ok: true });
}
