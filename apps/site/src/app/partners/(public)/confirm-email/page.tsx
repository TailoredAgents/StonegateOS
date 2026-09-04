import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PartnerEmailChangeConfirmation } from "@/app/partners/components/PartnerEmailChangeConfirmation";
import { PARTNER_EMAIL_CHANGE_TOKEN_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Confirm your partner sign-in email",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function PartnerConfirmEmailPage() {
  const token = (await cookies()).get(PARTNER_EMAIL_CHANGE_TOKEN_COOKIE)?.value;
  return <PartnerEmailChangeConfirmation hasToken={Boolean(token)} />;
}
