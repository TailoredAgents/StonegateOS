import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PartnerCredentialSetupForm } from "@/app/partners/components/PartnerCredentialSetupForm";
import { PARTNER_ACTIVATION_TOKEN_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Activate partner access",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function PartnerActivationPage() {
  const token = (await cookies()).get(PARTNER_ACTIVATION_TOKEN_COOKIE)?.value;
  return (
    <PartnerCredentialSetupForm mode="activation" hasToken={Boolean(token)} />
  );
}
