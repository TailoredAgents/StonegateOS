import React from "react";
import { partnerCompanyAccessHref } from "../partner-entry-navigation";
import { teamButtonClass } from "./team-ui";

export function PartnerAccessEntry({
  canReadAccounts,
  canInvite,
}: {
  canReadAccounts: boolean;
  canInvite: boolean;
}): React.ReactElement | null {
  if (!canReadAccounts) return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">Partner access</h3>
      <p className="mt-1 text-xs text-slate-600">
        {canInvite
          ? "Choose the approved company in Partners, then invite your contact with the right access."
          : "View approved companies and their partner access in Partners."}
      </p>
      <a
        className={`${teamButtonClass("secondary", "sm")} mt-3 min-h-11`}
        href={partnerCompanyAccessHref()}
      >
        {canInvite ? "Set up partner access" : "Open partner companies"}
      </a>
    </section>
  );
}
