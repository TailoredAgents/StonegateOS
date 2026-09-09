import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { partnerPublicFormErrorMessage } from "@/app/partners/lib/public-form-policy";
import { PartnerPasswordRecoveryForm } from "@/app/partners/components/PartnerPasswordRecoveryForm";

export const metadata: Metadata = {
  title: "Get back into your partner account",
  robots: { index: false, follow: false, nocache: true },
  referrer: "same-origin",
};

export const dynamic = "force-dynamic";

export default async function PartnerForgotPasswordPage({
  searchParams,
}: {
  searchParams?: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <PartnerPasswordRecoveryForm
      operationKey={randomUUID()}
      sent={params?.sent === "1"}
      initialError={partnerPublicFormErrorMessage(params?.error)}
    />
  );
}
