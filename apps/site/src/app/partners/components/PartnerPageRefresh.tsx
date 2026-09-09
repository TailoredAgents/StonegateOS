"use client";
import { useRouter } from "next/navigation";
import { partnerPortalFetch } from "../lib/portal-v2";
import { usePartnerLiveRefresh } from "../lib/use-partner-live-refresh";
import { PartnerNotice } from "./PartnerPortalUi";

export function PartnerPageRefresh({ resourceKey }: { resourceKey: string }) {
  const router = useRouter();
  const { stale } = usePartnerLiveRefresh(resourceKey, async (signal) => {
    const result = await partnerPortalFetch("session", { signal });
    if (!result.ok) {
      if ([401, 403].includes(result.response.status)) window.location.assign("/partners/login");
      return false;
    }
    router.refresh();
    return true;
  });
  return stale ? <PartnerNotice tone="warning">Updates are temporarily unavailable. Reconnect or refresh to see the latest job information.</PartnerNotice> : null;
}
