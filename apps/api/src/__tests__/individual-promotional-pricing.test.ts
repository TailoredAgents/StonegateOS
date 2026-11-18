import { randomUUID } from "node:crypto";
import { calculateQuoteV2Totals } from "@/lib/quote-v2-domain";
import { winterServiceDateAllowed } from "@/lib/winter-sale";
import { calculateQuoteV2LivePricing } from "../../../site/src/app/quote/[token]/quote-v2-customer-model";
import { winterSalePrice, WinterSaleSnapshotSchema } from "@myst-os/sdk";

describe("individual 30% offer pricing", () => {
  it.each([3000, 4000] as const)(
    "keeps server and customer totals, fees, deposits and deadline consistent for %i bps",
    (basisPoints) => {
      const promotion = {
        campaignId: randomUUID(),
        name: "Reviewed offer",
        basisPoints,
        expiresAt: "2099-11-29T23:00:00Z",
        serviceThrough: "2099-11-30",
      };
      const pricing = {
        documentType: "fixed_quote",
        currency: "USD",
        winterSale: promotion,
        lineItems: [
          {
            id: "haul",
            name: "Haul",
            description: "Junk removal",
            quantity: 1,
            unit: "job",
            unitPriceMinCents: 50000,
            displayOrder: 0,
          },
        ],
        optionGroups: [],
        adjustments: [
          {
            id: "travel",
            kind: "travel",
            label: "Travel",
            calculation: "fixed",
            basis: "subtotal",
            eligibleLineItemIds: [],
            amountCents: 5000,
            displayOrder: 0,
          },
          {
            id: "old-discount",
            kind: "discount",
            label: "Unrelated old discount",
            calculation: "fixed",
            basis: "subtotal",
            eligibleLineItemIds: [],
            amountCents: 10000,
            displayOrder: 1,
          },
        ],
        deposit: { mode: "percentage", basisPoints: 2500 },
      };
      const server = calculateQuoteV2Totals(pricing);
      const customer = calculateQuoteV2LivePricing(
        { document: { pricing } } as unknown as Parameters<
          typeof calculateQuoteV2LivePricing
        >[0],
        [],
      );
      const expected = basisPoints === 3000 ? 38500 : 33000;
      expect(server.totalMinCents).toBe(expected);
      expect(server.discountMinCents).toBe(55000 - expected);
      expect(server.depositCents).toBe(expected / 4);
      expect(customer.totals.totalMinCents).toBe(server.totalMinCents);
      expect(customer.totals.depositCents).toBe(server.depositCents);
      expect(
        server.adjustments.find((a) => a.kind === "discount")?.label,
      ).toContain(`${basisPoints / 100}%`);
      expect(
        winterServiceDateAllowed(promotion, "2099-11-30T17:00:00-05:00"),
      ).toBe(true);
      expect(
        winterServiceDateAllowed(promotion, "2099-12-01T09:00:00-05:00"),
      ).toBe(false);
    },
  );
  it("rounds in cents and preserves the existing 40% default", () => {
    expect(winterSalePrice(101, 3000).finalCents).toBe(71);
    expect(winterSalePrice(101).finalCents).toBe(61);
    expect(
      WinterSaleSnapshotSchema.safeParse({
        campaignId: randomUUID(),
        name: "Invalid",
        basisPoints: 3500,
        expiresAt: "2099-11-29T23:00:00Z",
        serviceThrough: "2099-11-30",
      }).success,
    ).toBe(false);
  });
});
