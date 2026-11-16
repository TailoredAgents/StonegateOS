import { and, desc, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { winterSalePrice, type WinterSaleSnapshot } from "@myst-os/sdk";
import { getDb, smsCampaigns } from "@/db";
import type { TeamMutationTransaction } from "./team-mutation";

export async function activeWinterSale(
  db: ReturnType<typeof getDb> | TeamMutationTransaction = getDb(),
  now = new Date(),
): Promise<WinterSaleSnapshot | null> {
  if (process.env["WINTER_SALE_ENABLED"] !== "true") return null;
  const campaigns = await db
    .select()
    .from(smsCampaigns)
    .where(and(inArray(smsCampaigns.status, ["active", "paused"])))
    .orderBy(desc(smsCampaigns.createdAt));
  const c = campaigns.find(
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
        basisPoints: 4000,
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
    discountPercent: 0.4,
    priceLowDiscounted:
      winterSalePrice(Math.round(quote.priceLow * 100)).finalCents / 100,
    priceHighDiscounted:
      winterSalePrice(Math.round(quote.priceHigh * 100)).finalCents / 100,
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
