import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PartnerApplicationWorkspace } from "@/app/partners/components/PartnerApplicationWorkspace";
import { PartnerErrorState } from "@/app/partners/components/PartnerPortalUi";
import { callPartnerApplicantApi } from "@/app/partners/lib/api";
import { parsePartnerOnboardingApplicationResponse } from "@/app/partners/lib/onboarding";

export const metadata: Metadata = {
  title: "Partner access application",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function PartnerApplicationPage({
  searchParams,
}: {
  searchParams?: Promise<{ verified?: string }>;
}) {
  const response = await callPartnerApplicantApi(
    "/api/portal/v2/onboarding/application",
    { timeoutMs: 15_000 },
  ).catch(() => null);
  if (response?.status === 401) {
    redirect("/partners/application/expired");
  }
  if (!response?.ok) {
    return (
      <div className="mx-auto max-w-2xl">
        <PartnerErrorState
          title="We couldn’t load your application"
          description="No application information was changed. Try again, or request a new verification link if your session expired."
          retryHref="/partners/application"
        />
      </div>
    );
  }
  const raw = (await response.json().catch(() => null)) as unknown;
  const payload = parsePartnerOnboardingApplicationResponse(
    raw,
    response.headers.get("etag"),
  );
  if (!payload) {
    return (
      <div className="mx-auto max-w-2xl">
        <PartnerErrorState
          title="Your application response was incomplete"
          description="No information was changed. Refresh before continuing or contact Stonegate for onboarding help."
          retryHref="/partners/application"
        />
      </div>
    );
  }

  return (
    <PartnerApplicationWorkspace
      initialApplication={payload.application}
      requirements={payload.requirements}
      justVerified={(await searchParams)?.verified === "1"}
    />
  );
}
