import type { Metadata, Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PartnerAccessRequestForm } from "@/app/partners/components/PartnerAccessRequestForm";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { PARTNER_APPLICATION_SESSION_COOKIE } from "@/lib/partner-application-session";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";

export const metadata: Metadata = {
  title: "Request partner access",
  description:
    "Verify your work email to request a Stonegate Partner Portal account.",
  robots: { index: false, follow: false, nocache: true },
};

export default async function PartnerRequestAccessPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const jar = await cookies();
  if (jar.get(PARTNER_APPLICATION_SESSION_COOKIE)?.value) {
    redirect("/partners/application" as Route);
  }
  if (jar.get(PARTNER_SESSION_COOKIE)?.value) {
    const context = await getPartnerPortalContext();
    if (context.status === "authenticated") {
      redirect("/partners/overview" as Route);
    }
  }
  const error = (await searchParams)?.error;
  const initialError =
    error === "invalid_or_expired" || error === "temporarily_unavailable"
      ? error
      : null;
  return <PartnerAccessRequestForm initialError={initialError} />;
}
