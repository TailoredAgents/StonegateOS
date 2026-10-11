import Link from "next/link";
import type { Route } from "next";
import { TEAM_FOCUS_RING, teamButtonClass } from "./team-ui";
import { partnerAdministrationHref } from "../partner-entry-navigation";

export type PartnerAdministrationDestination = {
  id: string;
  label: string;
  href: Route;
  active: boolean;
};
export function PartnerAdministrationNavigation({
  destinations,
  canCreate = false,
  returnTo,
}: {
  destinations: PartnerAdministrationDestination[];
  canCreate?: boolean;
  returnTo?: string;
}) {
  const active = destinations.find((item) => item.active)?.id ?? "requests";
  const requests = active === "requests";
  const administrative = !["requests", "accounts"].includes(active);
  return (
    <header className="min-w-0 space-y-4">
      {returnTo ? (
        <Link
          href={returnTo as Route}
          className={teamButtonClass("secondary", "sm")}
        >
          Back to previous workspace
        </Link>
      ) : null}
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
              href={partnerAdministrationHref({
                view: "accounts",
                setup: "create",
                hash: "partner-relationship-setup-heading",
                returnTo,
              })}
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
            href: partnerAdministrationHref({ view: "requests", returnTo }),
            active: active === "requests",
          },
          {
            id: "accounts",
            label: "Companies",
            href: partnerAdministrationHref({ view: "accounts", returnTo }),
            active: active === "accounts",
          },
          {
            id: "administration",
            label: "Administration",
            href: partnerAdministrationHref({
              view: "administration",
              returnTo,
            }),
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
              href={item.href}
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
                  href={item.href}
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
