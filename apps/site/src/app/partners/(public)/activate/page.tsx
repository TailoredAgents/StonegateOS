import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { callPartnerPublicApi } from "@/app/partners/lib/api";
import { resolvePartnerApiUrl } from "@/app/partners/lib/api-origin";
import { partnerPublicFormErrorMessage } from "@/app/partners/lib/public-form-policy";
import { cookies, headers } from "next/headers";
import {
  activationInspectionHeaders,
  resolveActivationInspectionOrigin,
} from "@/app/partners/lib/activation-inspection";
import { PartnerCredentialSetupForm } from "@/app/partners/components/PartnerCredentialSetupForm";
import { PARTNER_ACTIVATION_TOKEN_COOKIE } from "@/lib/partner-application-session";

export const metadata: Metadata = {
  title: "Finish setting up partner access",
  robots: { index: false, follow: false, nocache: true },
  referrer: "same-origin",
};
export const dynamic = "force-dynamic";

export default async function PartnerActivationPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const token = (await cookies()).get(PARTNER_ACTIVATION_TOKEN_COOKIE)?.value;
  const inspectionUrl = resolvePartnerApiUrl(
    "/api/portal/v2/onboarding/activation/inspect",
  );
  const inspectionOrigin = resolveActivationInspectionOrigin();
  const response =
    token && inspectionUrl && inspectionOrigin
      ? await callPartnerPublicApi(
          "/api/portal/v2/onboarding/activation/inspect",
          {
            method: "POST",
            // Assert the operator-configured Site origin, not the API's
            // external transport origin or caller-controlled browser headers.
            headers: activationInspectionHeaders(
              await headers(),
              inspectionOrigin,
            ),
            body: JSON.stringify({ token }),
            timeoutMs: 10_000,
          },
        ).catch(() => null)
      : null;
  const payload = response?.ok
    ? ((await response.json().catch(() => null)) as {
        activation?: {
          accountName?: string;
          email?: string;
          name?: string;
          passwordAlreadySet?: boolean;
        };
      } | null)
    : null;
  const detail =
    payload?.activation?.accountName && payload.activation.email
      ? payload.activation
      : null;
  return (
    <PartnerCredentialSetupForm
      mode="activation"
      hasToken={Boolean(token && detail)}
      operationKey={randomUUID()}
      initialDetail={detail}
      initialError={
        partnerPublicFormErrorMessage((await searchParams)?.error) ??
        (token && !detail
          ? "We couldn’t check this activation link. Try again or contact Stonegate for help."
          : null)
      }
    />
  );
}
