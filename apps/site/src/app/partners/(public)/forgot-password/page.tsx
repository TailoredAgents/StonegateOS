import type { Metadata } from "next";
import { PartnerPasswordRecoveryForm } from "@/app/partners/components/PartnerPasswordRecoveryForm";

export const metadata: Metadata = {
  title: "Get back into your partner account",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PartnerForgotPasswordPage() {
  return <PartnerPasswordRecoveryForm />;
}
