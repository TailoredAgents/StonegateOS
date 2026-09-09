import { loadPartnerBillingAdministration } from "../actions/partner-billing";
import { PartnerBillingAdministrationClient } from "./PartnerBillingAdministrationClient";
import type { TeamRequestPrincipal } from "@/lib/team-principal";

export async function PartnerBillingAdministration({
  accountId,
  accountName,
  canManage,
}: {
  principal: TeamRequestPrincipal;
  accountId: string;
  accountName: string;
  canManage: boolean;
}) {
  const result = await loadPartnerBillingAdministration(accountId);
  return (
    <section
      aria-labelledby="partner-staff-billing-heading"
      className="rounded-2xl border border-slate-200 bg-white p-5"
    >
      <h3
        id="partner-staff-billing-heading"
        className="text-lg font-semibold text-slate-900"
      >
        Invoices and payments — {accountName}
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Stonegate is the billing record. Cash, checks, and settled online
        payments update the same balance. Credits and refunds are separate
        actions.
      </p>
      {result.ok ? (
        <PartnerBillingAdministrationClient
          key={accountId}
          initial={result.data}
          canManage={canManage}
        />
      ) : (
        <p role="alert" className="mt-4 text-red-700">
          {result.message}
        </p>
      )}
    </section>
  );
}
