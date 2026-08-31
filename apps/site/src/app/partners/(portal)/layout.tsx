import { redirect } from "next/navigation";
import { getPublicCompanyProfile } from "@/lib/company";
import { PartnerAppShell } from "../components/PartnerAppShell";
import { PartnerProductAnalyticsClient } from "../components/PartnerProductAnalyticsClient";
import { PartnerPublicShell } from "../components/PartnerPublicShell";
import { PartnerErrorState } from "../components/PartnerPortalUi";
import { getPartnerPortalContext } from "../lib/portal-context";

export default async function PartnerAuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [context, company] = await Promise.all([
    getPartnerPortalContext(),
    Promise.resolve(getPublicCompanyProfile()),
  ]);

  if (context.status === "unauthenticated") {
    redirect("/partners/login");
  }

  if (context.status === "unavailable") {
    return (
      <PartnerPublicShell company={company} showSignIn={false}>
        <div className="mx-auto max-w-2xl">
          <PartnerErrorState
            title="The partner portal is temporarily unavailable"
            description="We couldn’t verify your portal session right now. Your account and jobs are unchanged. Try again in a moment or call Stonegate for immediate help."
            retryHref="/partners"
          />
        </div>
      </PartnerPublicShell>
    );
  }

  return (
    <>
      <PartnerProductAnalyticsClient />
      <PartnerAppShell
        companyName={company.name}
        logoPath={company.logoPath}
        accountLabel={context.accountLabel}
        userName={context.user.name}
        userEmail={context.user.email}
        capabilities={context.capabilities}
      >
        {children}
      </PartnerAppShell>
    </>
  );
}
