import { and, eq, inArray } from "drizzle-orm";
import { partnerBillingRefundRequests, partnerRefundAllocations } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export type InvoiceAllocation = {
  partnerAccountId: string;
  partnerInvoiceId: string;
  paymentId: string;
  amountCents: number;
  state: string;
};
export type SettledRefund = {
  id: string;
  paymentId: string;
  jobAmountCents: number;
  providerRefundId?: string | null;
};

/** Existing explicit splits win. Normal single-invoice refunds and refunds
 * initiated against one invoice remain automatic. Historical multi-invoice
 * refunds without that evidence require an explicit staff allocation. */
export async function resolvePartnerRefundAllocations(
  tx: TeamMutationTransaction,
  input: {
    allocations: InvoiceAllocation[];
    refunds: SettledRefund[];
    persist?: boolean;
  },
) {
  if (!input.refunds.length) return [];
  const rows = await tx
    .select()
    .from(partnerRefundAllocations)
    .where(
      inArray(
        partnerRefundAllocations.refundId,
        input.refunds.map((r) => r.id),
      ),
    );
  for (const refund of input.refunds) {
    const assigned = rows.filter(
      (r) => r.refundId === refund.id && r.jobAmountCents > 0,
    );
    if (assigned.length) {
      if (
        assigned.reduce((sum, row) => sum + row.jobAmountCents, 0) !==
        refund.jobAmountCents
      )
        throw new Error("partner_refund_allocation_reconciliation_required");
      continue;
    }
    if (refund.jobAmountCents === 0) continue;
    const allocations = input.allocations.filter(
      (r) => r.paymentId === refund.paymentId && r.state === "settled",
    );
    const [request] = refund.providerRefundId
      ? await tx
          .select({ invoiceId: partnerBillingRefundRequests.partnerInvoiceId })
          .from(partnerBillingRefundRequests)
          .where(
            and(
              eq(partnerBillingRefundRequests.paymentId, refund.paymentId),
              eq(
                partnerBillingRefundRequests.providerRefundId,
                refund.providerRefundId,
              ),
            ),
          )
          .limit(1)
      : [];
    const target = request
      ? allocations.find((r) => r.partnerInvoiceId === request.invoiceId)
      : allocations.length === 1
        ? allocations[0]
        : null;
    if (!target || refund.jobAmountCents > target.amountCents)
      throw new Error("partner_refund_allocation_reconciliation_required");
    if (input.persist === false) {
      rows.push({
        id: `${refund.id}/${target.partnerInvoiceId}`,
        partnerAccountId: target.partnerAccountId,
        partnerInvoiceId: target.partnerInvoiceId,
        refundId: refund.id,
        jobAmountCents: refund.jobAmountCents,
        updatedAt: new Date(),
      });
      continue;
    }
    const [saved] = await tx
      .insert(partnerRefundAllocations)
      .values({
        partnerAccountId: target.partnerAccountId,
        partnerInvoiceId: target.partnerInvoiceId,
        refundId: refund.id,
        jobAmountCents: refund.jobAmountCents,
      })
      .onConflictDoUpdate({
        target: [
          partnerRefundAllocations.partnerInvoiceId,
          partnerRefundAllocations.refundId,
        ],
        set: { jobAmountCents: refund.jobAmountCents, updatedAt: new Date() },
      })
      .returning();
    if (saved) rows.push(saved);
  }
  return rows.filter((row) => row.jobAmountCents > 0);
}
