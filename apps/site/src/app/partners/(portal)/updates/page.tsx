import type { Metadata } from "next";
import { getPartnerPortalContext } from "../../lib/portal-context";
import { callPartnerApi } from "../../lib/api";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "../../lib/portal-load";
import { parsePortalNotifications } from "../../lib/portal-read-models";
import { PartnerNotificationList } from "../../components/PartnerNotificationList";
import {
  PartnerPageHeader,
  PartnerErrorState,
  PartnerPanel,
} from "../../components/PartnerPortalUi";
import { PartnerPageRefresh } from "../../components/PartnerPageRefresh";

export const metadata: Metadata = { title: "Updates" };
export default async function PartnerUpdatesPage() {
  const context = await getPartnerPortalContext();
  if (context.status !== "authenticated" || !context.availability.reads)
    return null;
  const result = await loadPartnerPortalResource(
    () =>
      callPartnerApi("/api/portal/v2/notifications?state=all&limit=25", {
        timeoutMs: 8_000,
      }),
    parsePortalNotifications,
  );
  return (
    <div className="space-y-5">
      <PartnerPageRefresh resourceKey={context.accountId} />
      <PartnerPageHeader
        title="Updates"
        description="Messages and service updates, linked to the right job."
      />
      {result.status === "error" ? (
        <PartnerErrorState
          title="We couldn’t load your updates"
          description={portalLoadErrorMessage(
            result,
            "Your updates could not be loaded. Try again.",
          )}
          retryHref="/partners/updates"
        />
      ) : result.value.items.length ? (
        <PartnerNotificationList
          key={context.accountId}
          initialNotifications={result.value.items}
          initialNextCursor={result.value.nextCursor}
          state="all"
          pageLimit={25}
        />
      ) : (
        <PartnerPanel>
          <p className="text-sm text-slate-600">
            No updates yet. Messages and service updates will appear here.
          </p>
        </PartnerPanel>
      )}
    </div>
  );
}
