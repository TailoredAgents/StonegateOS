import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PartnerActivationMfaForm } from "@/app/partners/components/PartnerActivationMfaForm";
import { PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Secure partner access",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function PartnerActivationMfaPage() {
  const token = (await cookies()).get(
    PARTNER_ACTIVATION_MFA_TRANSACTION_COOKIE,
  )?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    redirect("/partners/login?error=activation_setup_expired");
  }
  return <PartnerActivationMfaForm />;
}
