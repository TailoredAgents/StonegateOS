import type { Metadata, Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPublicCompanyProfile } from "@/lib/company";
import { PartnerAppShell } from "../components/PartnerAppShell";
import { PartnerProductAnalyticsClient } from "../components/PartnerProductAnalyticsClient";
import { PartnerPublicShell } from "../components/PartnerPublicShell";
import { PartnerErrorState } from "../components/PartnerPortalUi";
import { getPartnerPortalContext } from "../lib/portal-context";
import { partnerLoginHref } from "../lib/safe-return";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function PartnerAuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [context, company] = await Promise.all([
    getPartnerPortalContext(),
    Promise.resolve(getPublicCompanyProfile()),
  ]);

  if (context.status === "unauthenticated") {
    const returnTo = (await headers()).get("x-partner-return-to");
    redirect(partnerLoginHref(returnTo) as Route);
  }

  if (context.status === "unavailable") {
    return (
      <PartnerPublicShell company={company} showSignIn={false}>
        <div className="mx-auto max-w-2xl">
          <PartnerErrorState
            title="The partner portal is temporarily unavailable"
            description="We couldn’t verify your portal session right now. Your account and jobs are unchanged. Try again in a moment or call Stonegate for help."
            retryHref="/partners/overview"
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
        accounts={context.accounts}
        userName={context.user.name}
        userEmail={context.user.email}
        capabilities={context.capabilities}
      >
        {children}
      </PartnerAppShell>
    </>
  );
}
