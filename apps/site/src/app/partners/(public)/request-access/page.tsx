import type { Metadata } from "next";
import { PartnerAccessRequestForm } from "@/app/partners/components/PartnerAccessRequestForm";
import { PartnerErrorState } from "@/app/partners/components/PartnerPortalUi";
import { callPartnerPublicApi } from "@/app/partners/lib/api";

export const metadata: Metadata = {
  title: "Request access",
  description: "Request a Stonegate Partner Portal account for your company.",
};

export default async function PartnerRequestAccessPage() {
  const response = await callPartnerPublicApi(
    "/api/portal/v2/access-applications/requirements",
    { timeoutMs: 12_000 },
  ).catch(() => null);
  if (!response?.ok) {
    return (
      <div className="mx-auto max-w-2xl">
        <PartnerErrorState
          title="Access requests are temporarily unavailable"
          description="No information has been submitted. Try again shortly or call Stonegate for partner onboarding help."
          retryHref="/partners/request-access"
        />
      </div>
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    termsVersion?: string;
    privacyVersion?: string;
    partnerTypes?: string[];
  } | null;
  if (!payload?.termsVersion || !payload.privacyVersion || !Array.isArray(payload.partnerTypes)) {
    return (
      <div className="mx-auto max-w-2xl">
        <PartnerErrorState
          title="Access requirements could not be verified"
          description="No information has been submitted. Refresh before accepting any account terms."
          retryHref="/partners/request-access"
        />
      </div>
    );
  }
  return (
    <PartnerAccessRequestForm
      termsVersion={payload.termsVersion}
      privacyVersion={payload.privacyVersion}
      partnerTypes={payload.partnerTypes}
    />
  );
}
