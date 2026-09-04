import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { normalizePartnerReturnTo } from "@/app/partners/lib/safe-return";

export const metadata: Metadata = {
  title: "Partner account security updated",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function DeprecatedPartnerLoginSecurityPage({
  searchParams,
}: {
  searchParams?: Promise<{ returnTo?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const returnTo = normalizePartnerReturnTo(params.returnTo);
  const query = new URLSearchParams({ error: "security_setup_updated" });
  if (returnTo !== "/partners/overview") query.set("returnTo", returnTo);
  redirect(`/partners/login?${query.toString()}` as Route);
}
