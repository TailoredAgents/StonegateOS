import { getPublicCompanyProfile } from "@/lib/company";
import { PartnerPublicShell } from "../components/PartnerPublicShell";
import { PartnerProductAnalyticsClient } from "../components/PartnerProductAnalyticsClient";

export default function PartnerPublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <PartnerProductAnalyticsClient />
      <PartnerPublicShell company={getPublicCompanyProfile()}>
        {children}
      </PartnerPublicShell>
    </>
  );
}
