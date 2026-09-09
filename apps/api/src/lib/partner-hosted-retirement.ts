import type { SquareOrder } from "@/lib/square-client";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { partnerBookings, partnerInvoices, type DatabaseClient } from "@/db";
export async function hasUnretiredPartnerHostedInvoice(
  db: Pick<DatabaseClient, "select">,
  appointmentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: partnerInvoices.id })
    .from(partnerInvoices)
    .innerJoin(
      partnerBookings,
      and(
        eq(partnerBookings.id, partnerInvoices.partnerBookingId),
        eq(partnerBookings.partnerAccountId, partnerInvoices.partnerAccountId),
      ),
    )
    .where(
      and(
        eq(partnerBookings.appointmentId, appointmentId),
        or(
          isNotNull(partnerInvoices.providerInvoiceId),
          isNotNull(partnerInvoices.hostedPaymentUrl),
          isNotNull(partnerInvoices.providerOrderId),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}
/** Application TTLs cannot revoke a provider-hosted URL. */
export function requiresHostedCollectionRetirement(
  metadata: Record<string, unknown> | null,
): boolean {
  const portal = metadata?.["partnerPortalPayment"];
  const source =
    portal && typeof portal === "object" && !Array.isArray(portal)
      ? (portal as Record<string, unknown>)
      : metadata;
  return (
    source?.["checkoutMode"] === "hosted_redirect" ||
    typeof source?.["providerPaymentLinkId"] === "string" ||
    typeof source?.["checkoutUrl"] === "string"
  );
}
export function isSquareHostedOrderRetired(
  order: SquareOrder,
  expectedOrderId: string,
): boolean {
  return (
    order.id === expectedOrderId &&
    order.state === "CANCELED" &&
    (order.tenders === undefined ||
      (Array.isArray(order.tenders) && order.tenders.length === 0))
  );
}
