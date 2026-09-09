import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { partnerPublicFormErrorMessage } from "@/app/partners/lib/public-form-policy";
import { cookies } from "next/headers";
import { PartnerCredentialSetupForm } from "@/app/partners/components/PartnerCredentialSetupForm";
import { PARTNER_PASSWORD_RESET_TOKEN_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Create a new partner password",
  robots: { index: false, follow: false, nocache: true },
  referrer: "same-origin",
};
export const dynamic = "force-dynamic";

export default async function PartnerResetPasswordPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const token = (await cookies()).get(
    PARTNER_PASSWORD_RESET_TOKEN_COOKIE,
  )?.value;
  return (
    <PartnerCredentialSetupForm
      mode="reset"
      hasToken={Boolean(token)}
      operationKey={randomUUID()}
      initialError={partnerPublicFormErrorMessage((await searchParams)?.error)}
    />
  );
}
