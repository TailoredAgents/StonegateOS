import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { outboxEvents, partnerInvoices } from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export async function queuePartnerPaymentLifecycle(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    invoiceId: string;
    intentId: string;
    state: "processing" | "failed";
  },
): Promise<void> {
  const [invoice] = await tx
    .select({ jobId: partnerInvoices.partnerBookingId })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.id, input.invoiceId),
        eq(partnerInvoices.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (!invoice?.jobId) return;
  const hash = createHash("sha256")
    .update(`partner-payment:${input.intentId}:${input.state}`)
    .digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  await tx
    .insert(outboxEvents)
    .values({
      id,
      type: `partner.payment.${input.state}`,
      payload: {
        partnerAccountId: input.accountId,
        partnerBookingId: invoice.jobId,
        invoiceId: input.invoiceId,
        paymentIntentId: input.intentId,
        version: input.state,
      },
    })
    .onConflictDoNothing();
}
