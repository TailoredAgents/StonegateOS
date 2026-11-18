import { and, desc, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { winterSalePrice, type WinterSaleSnapshot } from "@myst-os/sdk";
import { getDb, smsCampaigns } from "@/db";
import type { TeamMutationTransaction } from "./team-mutation";

export async function activeWinterSale(
  db: ReturnType<typeof getDb> | TeamMutationTransaction = getDb(),
  now = new Date(),
  contactId?: string | null,
): Promise<WinterSaleSnapshot | null> {
  if (process.env["WINTER_SALE_ENABLED"] !== "true") return null;
  const campaigns = await db
    .select()
    .from(smsCampaigns)
    .where(and(inArray(smsCampaigns.status, ["active", "paused"])))
    .orderBy(desc(smsCampaigns.createdAt));
  const received = contactId
    ? await db.execute<{ campaign_id: string }>(
        sql`select r.campaign_id from sms_campaign_recipients r join conversation_messages m on m.id=r.message_id where r.contact_id=${contactId}::uuid and r.is_test=false and r.draft_id is not null and m.delivery_status in ('sent','delivered') order by r.created_at desc`,
      )
    : [];
  const scopedIds = new Set(received.map((r) => r.campaign_id));
  const eligible = campaigns.filter(
    (c) => c.terms.deliveryMode !== "individual_drafts" || scopedIds.has(c.id),
  );
  eligible.sort(
    (a, b) =>
      Number(b.terms.deliveryMode === "individual_drafts") -
      Number(a.terms.deliveryMode === "individual_drafts"),
  );
  // A privately offered 30% campaign never becomes a public site-wide offer.
  const c = eligible.find(
    (c) =>
      c.activatedAt &&
      c.terms.expiresAt &&
      new Date(c.terms.expiresAt) > now &&
      c.terms.serviceThrough,
  );
  return c
    ? {
        campaignId: c.id,
        name: c.terms.name,
        basisPoints: c.terms.discountBasisPoints ?? 4000,
        expiresAt: c.terms.expiresAt!,
        serviceThrough: c.terms.serviceThrough!,
        activatedAt: c.activatedAt?.toISOString(),
        retroactivePolicy:
          c.terms.retroactivePolicy === "undecided"
            ? "new_quotes_only"
            : c.terms.retroactivePolicy,
      }
    : null;
}
export function winterSaleEstimate<
  T extends { priceLow: number; priceHigh: number },
>(quote: T, promotion: WinterSaleSnapshot | null) {
  if (!promotion) return quote;
  return {
    ...quote,
    discountAmount: undefined,
    discountPercent: promotion.basisPoints / 10000,
    priceLowDiscounted:
      winterSalePrice(Math.round(quote.priceLow * 100), promotion.basisPoints)
        .finalCents / 100,
    priceHighDiscounted:
      winterSalePrice(Math.round(quote.priceHigh * 100), promotion.basisPoints)
        .finalCents / 100,
    winterSale: promotion,
  };
}
export function winterServiceDateAllowed(
  promotion: WinterSaleSnapshot | undefined | null,
  start: Date | string,
): boolean {
  if (!promotion) return true;
  const date = DateTime.fromJSDate(new Date(start), {
    zone: "America/New_York",
  });
  return date.isValid && date.toISODate() <= promotion.serviceThrough;
}
