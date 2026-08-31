import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { getPublicCompanyProfile } from "@/lib/company";
import { hasTeamPermissionValue } from "@/lib/team-permissions";
import QuoteV2ComposerClient from "./QuoteV2ComposerClient";
import { teamStatePanelClass } from "./team-ui";
import { isQuoteV2SenderFeatureEnabled } from "../lib/quote-v2-staff-feature";

export function QuoteV2BuilderSection({
  principal,
  initialContactId,
  initialPropertyId,
}: {
  principal: TeamRequestPrincipal;
  initialContactId?: string;
  initialPropertyId?: string;
}): ReactElement {
  const company = getPublicCompanyProfile();
  const hasSendPermission = hasTeamPermissionValue(
    principal.permissions,
    "quotes.send",
  );
  const senderEnabled = isQuoteV2SenderFeatureEnabled();
  const canSend = hasSendPermission && senderEnabled;
  const siteUrl = process.env["NEXT_PUBLIC_SITE_URL"]?.trim() || null;
  const validSiteUrl = (() => {
    if (!siteUrl) return null;
    try {
      const parsed = new URL(siteUrl);
      return parsed.protocol === "https:" || parsed.protocol === "http:"
        ? parsed.toString()
        : null;
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-4">
      {!canSend ? (
        <div className={teamStatePanelClass("warning")} role="status">
          <p className="font-semibold">Draft access only</p>
          <p className="mt-1">
            {hasSendPermission
              ? "You can build and autosave this proposal, but the V2 sender is not enabled for this rollout cohort."
              : "You can build and autosave this proposal, but a teammate with quote-send permission must freeze and issue it."}
          </p>
        </div>
      ) : null}
      <QuoteV2ComposerClient
        canSend={canSend}
        canQuickCreate={hasTeamPermissionValue(
          principal.permissions,
          "contacts.write",
        )}
        preparerName={principal.name}
        recoveryId={randomUUID()}
        initialContactId={initialContactId}
        initialPropertyId={initialPropertyId}
        issuer={{
          legalName: company.name,
          displayName: company.name,
          address: `${company.hqCity}, ${company.hqState}, ${company.hqCountry}`,
          email: company.email,
          phoneE164: company.phoneE164,
          website: validSiteUrl,
          logoAssetId: null,
          supportMessage: `${company.serviceAreaSummary} ${company.hoursSummary}`,
        }}
      />
    </div>
  );
}
