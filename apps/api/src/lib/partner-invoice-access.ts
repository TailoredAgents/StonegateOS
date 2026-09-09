import { and, eq } from "drizzle-orm";
import {
  partnerAccountCostCenters,
  partnerAccountLocations,
  partnerBookings,
  partnerInvoices,
} from "@/db";
import {
  createPartnerInvoiceAccessCondition,
  type PartnerCommercialAccess,
} from "@/lib/partner-portal-v2-commercial";
import { createPartnerJobLocationJoinCondition } from "@/lib/partner-portal-v2-resource-authorization";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export async function hasPartnerInvoiceAccess(
  db: Pick<TeamMutationTransaction, "select">,
  accountId: string,
  invoiceId: string,
  access: PartnerCommercialAccess,
): Promise<boolean> {
  if (
    access.accountId !== accountId ||
    !["account", "scoped"].includes(access.accessLevel)
  )
    return false;
  const [invoice] = await db
    .select({ id: partnerInvoices.id })
    .from(partnerInvoices)
    .leftJoin(
      partnerBookings,
      and(
        eq(partnerBookings.id, partnerInvoices.partnerBookingId),
        eq(partnerBookings.partnerAccountId, partnerInvoices.partnerAccountId),
      ),
    )
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .leftJoin(
      partnerAccountCostCenters,
      and(
        eq(partnerAccountCostCenters.partnerAccountId, accountId),
        eq(partnerAccountCostCenters.code, partnerInvoices.costCenter),
      ),
    )
    .where(
      and(
        eq(partnerInvoices.id, invoiceId),
        eq(partnerInvoices.partnerAccountId, accountId),
        createPartnerInvoiceAccessCondition(access),
      ),
    )
    .limit(1);
  return Boolean(invoice);
}
