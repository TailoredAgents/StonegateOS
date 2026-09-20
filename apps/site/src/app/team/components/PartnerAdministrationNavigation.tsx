import Link from "next/link";
import type { Route } from "next";
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
  const active = destinations.find((item) => item.active)?.id ?? "requests";
  const requests = active === "requests";
  const administrative = !["requests", "accounts"].includes(active);
  return (
    <header className="min-w-0 space-y-4">
      {!requests ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {active === "accounts"
              ? "Partner companies"
              : "Partner administration"}
          </h1>
          {canCreate && active === "accounts" ? (
            <Link
              className={teamButtonClass("secondary")}
              href="/team/partners?p_admin=accounts&p_setup=create#partner-relationship-setup-heading"
            >
              Add partner
            </Link>
          ) : null}
        </div>
      ) : null}
      <nav
        aria-label="Partner workspace"
        className="flex flex-wrap gap-2 border-b border-[color:var(--team-border)] pb-3"
      >
        {[
          {
            id: "requests",
            label: "Requests",
            href: "/team/partners?p_admin=requests",
            active: active === "requests",
          },
          {
            id: "accounts",
            label: "Companies",
            href: "/team/partners?p_admin=accounts",
            active: active === "accounts",
          },
          {
            id: "administration",
            label: "Administration",
            href: "/team/partners?p_admin=administration",
            active: administrative,
          },
        ]
          .filter(
            (item) =>
              destinations.some((destination) => destination.id === item.id) ||
              (item.id === "administration" && administrative),
          )
          .map((item) => (
            <Link
              key={item.id}
              href={item.href as Route}
              aria-current={item.active ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-lg px-4 py-2 text-sm ${TEAM_FOCUS_RING} ${item.active ? "bg-[color:var(--team-surface-muted)] font-semibold" : "text-[color:var(--team-text-muted)]"}`}
            >
              {item.label}
            </Link>
          ))}
      </nav>
      {administrative ? (
        <details
          className="rounded-xl border border-[color:var(--team-border)] px-3"
          open={active === "administration"}
        >
          <summary
            className={`min-h-11 cursor-pointer content-center py-2 text-sm font-medium ${TEAM_FOCUS_RING}`}
          >
            Administration tools
          </summary>
          <nav
            aria-label="Partner administration tools"
            className="flex flex-wrap gap-2 pb-3"
          >
            {destinations
              .filter(
                (item) =>
                  !["requests", "accounts", "administration"].includes(item.id),
              )
              .map((item) => (
                <Link
                  key={item.id}
                  href={item.href as Route}
                  aria-current={item.active ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm ${TEAM_FOCUS_RING} ${item.active ? "bg-[color:var(--team-surface-muted)] font-semibold" : "text-[color:var(--team-text-muted)]"}`}
                >
                  {item.label}
                </Link>
              ))}
          </nav>
        </details>
      ) : null}
    </header>
  );
}
