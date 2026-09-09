import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { partnerAllocationReconciliations, partnerInvoices } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const RecordedAllocation = z.object({
  id: z.string().uuid(),
  partnerAccountId: z.string().uuid(),
  partnerInvoiceId: z.string().uuid(),
  paymentId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  state: z.enum(["settled", "reversed"]),
});

/** A provider replay cannot restore an allocation explicitly corrected by staff.
 * An audit row alone is insufficient: the exact current projection must match
 * the latest immutable correction, retain its tenant/job bindings, and conserve
 * the canonical payment's service principal. Caller holds the collection lock.
 */
export async function hasMatchingPartnerAllocationEvidence(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    jobId: string;
    paymentId: string;
    principalCents: number;
    allocations: {
      id: string;
      accountId: string;
      invoiceId: string;
      amountCents: number;
      state: string;
    }[];
  },
): Promise<boolean> {
  const [evidence] = await tx
    .select({ snapshot: partnerAllocationReconciliations.afterSnapshot })
    .from(partnerAllocationReconciliations)
    .where(
      and(
        eq(partnerAllocationReconciliations.partnerAccountId, input.accountId),
        eq(partnerAllocationReconciliations.partnerBookingId, input.jobId),
        eq(partnerAllocationReconciliations.paymentId, input.paymentId),
      ),
    )
    .orderBy(
      desc(partnerAllocationReconciliations.createdAt),
      desc(partnerAllocationReconciliations.id),
    )
    .limit(1);
  if (!evidence || !Array.isArray(evidence.snapshot["allocations"]))
    return false;
  const parsed = z
    .array(RecordedAllocation)
    .safeParse(evidence.snapshot["allocations"]);
  if (!parsed.success) return false;
  const recorded = parsed.data.filter(
    (row) => row.paymentId === input.paymentId,
  );
  const expected = recorded.map((row) => ({
    id: row.id,
    accountId: row.partnerAccountId,
    invoiceId: row.partnerInvoiceId,
    amountCents: row.amountCents,
    state: row.state,
  }));
  if (
    !expected.length ||
    expected.some((row) => row.accountId !== input.accountId) ||
    expected
      .filter((row) => row.state === "settled")
      .reduce((sum, row) => sum + row.amountCents, 0) !== input.principalCents
  )
    return false;
  const ordered = (rows: typeof input.allocations) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));
  if (
    JSON.stringify(ordered(expected)) !==
    JSON.stringify(ordered(input.allocations))
  )
    return false;
  const invoiceIds = [...new Set(expected.map((row) => row.invoiceId))];
  const invoices = await tx
    .select({ id: partnerInvoices.id })
    .from(partnerInvoices)
    .where(
      and(
        inArray(partnerInvoices.id, invoiceIds),
        eq(partnerInvoices.partnerAccountId, input.accountId),
        eq(partnerInvoices.partnerBookingId, input.jobId),
      ),
    );
  return invoices.length === invoiceIds.length;
}
