import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PartnerCredentialSetupForm } from "@/app/partners/components/PartnerCredentialSetupForm";
import { PARTNER_PASSWORD_RESET_TOKEN_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Choose a new partner password",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function PartnerResetPasswordPage() {
  const token = (await cookies()).get(
    PARTNER_PASSWORD_RESET_TOKEN_COOKIE,
  )?.value;
  return <PartnerCredentialSetupForm mode="reset" hasToken={Boolean(token)} />;
}
