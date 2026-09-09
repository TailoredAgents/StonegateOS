import { notFound } from "next/navigation";
import Link from "next/link";
import {
  requireCurrentTeamPrincipal,
  hasTeamPermission,
} from "@/lib/team-principal";
import { StaffSchedulingConfiguration } from "../../components/StaffSchedulingConfiguration";
export const dynamic = "force-dynamic";
export default async function PartnerSchedulingPage() {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermission(principal, "policy.read")) notFound();
  return (
    <main className="mx-auto min-h-screen max-w-6xl space-y-6 bg-slate-50 px-4 py-6 text-slate-900">
      <Link
        href="/team/partners"
        className="inline-flex min-h-11 items-center font-semibold underline"
      >
        Back to Partner Administration
      </Link>
      <StaffSchedulingConfiguration
        canEdit={hasTeamPermission(principal, "policy.write")}
      />
    </main>
  );
}
