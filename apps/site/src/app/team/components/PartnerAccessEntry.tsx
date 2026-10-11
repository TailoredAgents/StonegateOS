import React from "react";
import { partnerCompanyAccessHref } from "../partner-entry-navigation";
import { teamButtonClass } from "./team-ui";

export function PartnerAccessEntry({
  canReadAccounts,
  canInvite,
  returnTo,
}: {
  canReadAccounts: boolean;
  canInvite: boolean;
  returnTo?: string;
}): React.ReactElement | null {
  if (!canReadAccounts) return null;

  return (
    <section className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
      <h3 className="text-sm font-semibold text-[color:var(--team-text)]">
        Partner access
      </h3>
      <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
        {canInvite
          ? "Choose the approved company in Partners, then invite your contact with the right access."
          : "View approved companies and their partner access in Partners."}
      </p>
      <a
        className={`${teamButtonClass("secondary", "sm")} mt-3 min-h-11`}
        href={partnerCompanyAccessHref(returnTo)}
      >
        {canInvite ? "Set up partner access" : "Open partner companies"}
      </a>
    </section>
  );
}
