import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendEmailMessage } from "@/lib/messaging";
import {
  createPartnerLoginToken,
  findActivePartnerUserByEmail,
  normalizeEmail,
  resolvePublicSiteBaseUrl
} from "@/lib/partner-portal-auth";

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = normalizeEmail(payload?.email);
  if (!email) {
    return NextResponse.json({ ok: false, error: "email_required" }, { status: 400 });
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl();
  const user = await findActivePartnerUserByEmail(email);

  if (user?.id && siteBaseUrl) {
    try {
      const { rawToken, expiresAt } = await createPartnerLoginToken(user.id, request, 30);
      const url = new URL("/partners/auth", siteBaseUrl);
      url.searchParams.set("token", rawToken);

      const subject = "Your Stonegate Partner Portal login link";
      const body = [
        `Hi ${user.name},`,
        "",
        "Here’s your secure login link for the Stonegate Partner Portal:",
        url.toString(),
        "",
        `This link expires at ${expiresAt.toISOString()}.`,
        "",
        "If you didn't request this, you can ignore this email."
      ].join("\n");

      await sendEmailMessage(email, subject, body);
    } catch {
      // Intentionally ignore to avoid leaking whether an email exists.
    }
  }

  // Always return ok to avoid email enumeration.
  return NextResponse.json({ ok: true });
}

