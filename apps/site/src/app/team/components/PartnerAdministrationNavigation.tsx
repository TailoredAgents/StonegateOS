import Link from "next/link";
import { TEAM_FOCUS_RING, teamButtonClass } from "./team-ui";

export type PartnerAdministrationDestination = {
  id: string;
  label: string;
  href: string;
  active: boolean;
};

export function PartnerAdministrationNavigation({
  destinations,
  canCreate = false,
}: {
  destinations: PartnerAdministrationDestination[];
  canCreate?: boolean;
}) {
  const advanced = destinations.filter((item) => item.id !== "accounts");
  return (
    <header className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Partners</h1>
          <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
            Companies we work with, their people, and their service.
          </p>
        </div>
        {canCreate ? (
          <Link
            className={teamButtonClass("primary")}
            href="/team/partners?p_admin=accounts&p_setup=create#partner-relationship-setup-heading"
          >
            Add partner
          </Link>
        ) : null}
      </div>
      {advanced.length ? (
        <details className="rounded-xl border border-[color:var(--team-border)] px-3">
          <summary
            className={`min-h-11 cursor-pointer content-center py-2 text-sm font-medium ${TEAM_FOCUS_RING}`}
          >
            Advanced administration
            {advanced.some((item) => item.active)
              ? ` · ${advanced.find((item) => item.active)?.label}`
              : ""}
          </summary>
          <p className="mb-2 text-sm text-[color:var(--team-text-muted)]">
            Account-wide tools, support, and historical records. Company tasks
            are available inside each company.
          </p>
          <nav
            aria-label="Advanced partner administration"
            className="flex flex-wrap gap-2 pb-3"
          >
            {destinations.map((item) => (
              <a
                key={item.id}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm ${TEAM_FOCUS_RING} ${item.active ? "bg-[color:var(--team-surface-muted)] font-semibold" : "text-[color:var(--team-text-muted)]"}`}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </details>
      ) : null}
    </header>
  );
}
