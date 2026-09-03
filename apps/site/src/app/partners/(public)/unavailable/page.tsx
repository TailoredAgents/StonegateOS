import type { Metadata } from "next";
import { PartnerLandingContent } from "@/app/partners/components/PartnerLandingContent";
import { getPublicCompanyProfile } from "@/lib/company";

export const metadata: Metadata = {
  title: "Partner portal temporarily unavailable",
  description:
    "Stonegate could not verify an existing partner session right now.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function PartnerUnavailablePage() {
  return (
    <PartnerLandingContent
      company={getPublicCompanyProfile()}
      sessionUnavailable
    />
  );
}
