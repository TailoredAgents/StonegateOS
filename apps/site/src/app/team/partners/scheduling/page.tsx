import { notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import {
  requireCurrentTeamPrincipal,
  hasTeamPermission,
} from "@/lib/team-principal";
import { StaffSchedulingConfiguration } from "../../components/StaffSchedulingConfiguration";
import {
  partnerAdministrationHref,
  safePartnerReturnPath,
} from "../../partner-entry-navigation";
import { teamButtonClass } from "../../components/team-ui";
export const dynamic = "force-dynamic";
export default async function PartnerSchedulingPage({
  searchParams,
}: {
  searchParams: Promise<{ p_return?: string }>;
}) {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermission(principal, "policy.read")) notFound();
  const params = await searchParams;
  const returnTo = safePartnerReturnPath(params.p_return) ?? undefined;
  return (
    <main className="mx-auto min-h-screen max-w-6xl space-y-6 bg-[color:var(--team-surface-muted)] px-4 py-6 text-[color:var(--team-text)]">
      <Link
        href={partnerAdministrationHref({
          view: "administration",
          returnTo,
        })}
        className={teamButtonClass("secondary", "sm")}
      >
        Back to Partner Administration
      </Link>
      {returnTo ? (
        <Link
          href={returnTo as Route}
          className={`ml-2 ${teamButtonClass("secondary", "sm")}`}
        >
          Back to previous workspace
        </Link>
      ) : null}
      <StaffSchedulingConfiguration
        canEdit={hasTeamPermission(principal, "policy.write")}
      />
    </main>
  );
}
