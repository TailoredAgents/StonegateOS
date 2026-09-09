import type { Metadata } from "next";
import { getPartnerPortalContext } from "../../lib/portal-context";
import { PartnerRepeatWorkManager } from "../../components/PartnerRepeatWorkManager";
import {
  PartnerPageHeader,
  PartnerEmptyState,
} from "../../components/PartnerPortalUi";

export const metadata: Metadata = { title: "Saved tools & history" };

export default async function PartnerToolsPage() {
  const context = await getPartnerPortalContext();
  if (context.status !== "authenticated") return null;
  if (!context.capabilities.schedule)
    return (
      <PartnerEmptyState
        title="These tools are not part of your role"
        description="Your existing jobs remain in My jobs. Contact Stonegate if you need help."
        action={{ href: "/partners/help", label: "Get help" }}
      />
    );
  return (
    <div className="space-y-5">
      <PartnerPageHeader
        title="Saved tools & history"
        description="Your templates, recurring service, and previously uploaded requests."
      />
      <PartnerRepeatWorkManager
        key={context.accountId}
        canManageSeries={context.permissions.updateJobs}
        persona={context.partnerType}
        enabledTools={{
          templates: context.tools?.["templates"] === true,
          recurring: context.tools?.["recurring"] === true,
          bulk: context.tools?.["bulk"] === true,
        }}
      />
    </div>
  );
}
