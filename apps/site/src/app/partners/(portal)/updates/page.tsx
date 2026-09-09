import type { Metadata } from "next";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { callPartnerApi } from "@/app/partners/lib/api";
import { PartnerNotificationList, type PartnerDashboardNotification } from "@/app/partners/components/PartnerNotificationList";
import { PartnerPageHeader, PartnerNotice } from "@/app/partners/components/PartnerPortalUi";
import { PartnerPageRefresh } from "@/app/partners/components/PartnerPageRefresh";

export const metadata: Metadata = { title: "Updates" };
export default async function PartnerUpdatesPage() {
  const context = await getPartnerPortalContext();
  if (context.status !== "authenticated") return null;
  const response = await callPartnerApi("/api/portal/v2/notifications?state=all&limit=25", { timeoutMs: 8_000 }).catch(() => null);
  const payload = response?.ok ? await response.json().catch(() => null) as { notifications: PartnerDashboardNotification[]; page: { nextCursor: string | null } } | null : null;
  return <div className="space-y-5"><PartnerPageRefresh resourceKey={context.accountId} /><PartnerPageHeader title="Updates" description="Messages and service updates, linked to the right job." />{payload ? <PartnerNotificationList key={context.accountId} initialNotifications={payload.notifications} initialNextCursor={payload.page.nextCursor} state="all" pageLimit={25} /> : <PartnerNotice tone="warning">Updates could not be loaded. Your jobs are unchanged. Refresh to try again.</PartnerNotice>}</div>;
}
