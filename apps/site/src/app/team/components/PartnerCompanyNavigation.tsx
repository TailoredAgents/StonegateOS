import Link from "next/link";
import {
  partnerCompanyHref,
  type PartnerCompanySection,
} from "../partner-company-navigation";
import { TEAM_FOCUS_RING, teamButtonClass } from "./team-ui";

const LABELS: Record<PartnerCompanySection, string> = {
  details: "Details & contacts",
  people: "People & invitations",
  jobs: "Jobs & service requests",
  billing: "Billing & service terms",
  settings: "Settings",
};

export function PartnerCompanyNavigation({
  accountId,
  accountName,
  section,
  sections,
}: {
  accountId: string;
  accountName: string;
  section: PartnerCompanySection;
  sections: readonly PartnerCompanySection[];
}) {
  return (
    <section className="min-w-0 space-y-4 border-b border-[color:var(--team-border)] pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="min-w-0 break-words text-xl font-semibold">
          {accountName}
        </h2>
        <Link href="/team/partners" className={teamButtonClass("secondary", "sm")}>
          All companies
        </Link>
      </div>
      <nav aria-label="Company sections" className="flex flex-wrap gap-2">
        {sections.map((key) => (
          <Link
            key={key}
            href={partnerCompanyHref(accountId, key)}
            aria-current={key === section ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-xl px-3 py-2 text-sm font-semibold ${TEAM_FOCUS_RING} ${key === section ? "bg-[color:var(--team-surface-muted)] text-[color:var(--team-text)]" : "text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)]"}`}
          >
            {LABELS[key]}
          </Link>
        ))}
      </nav>
    </section>
  );
}
