import { parsePartnerRateMutationPayload } from "../../app/api/admin/partners/rates/route";
import { TeamMutationFailure } from "@/lib/team-mutation";

const PARTNER_ID = "11111111-1111-4111-8111-111111111111";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    orgContactId: PARTNER_ID,
    currency: "USD",
    items: [
      {
        serviceKey: "junk-removal",
        tierKey: "quarter",
        label: "Quarter load",
        amountCents: 15_000,
        sortOrder: 0,
      },
    ],
    confirmation: "SAVE 1 PARTNER RATES",
    ...overrides,
  };
}

describe("partner negotiated-rate mutation input", () => {
  it("accepts a complete canonical replacement", () => {
    expect(parsePartnerRateMutationPayload(payload())).toEqual({
      orgContactId: PARTNER_ID,
      currency: "USD",
      items: [
        {
          serviceKey: "junk-removal",
          tierKey: "quarter",
          label: "Quarter load",
          amountCents: 15_000,
          sortOrder: 0,
        },
      ],
    });
  });

  it("rejects hidden fields, coercion, unsafe amounts, and bad confirmation", () => {
    const cases = [
      { ...payload(), hidden: true },
      payload({ currency: "usd" }),
      payload({ confirmation: "SAVE" }),
      payload({ items: [{ ...payload().items[0]!, amountCents: "15000" }] }),
      payload({ items: [{ ...payload().items[0]!, amountCents: 0 }] }),
      payload({ items: [{ ...payload().items[0]!, amountCents: 10_000_001 }] }),
      payload({ items: [{ ...payload().items[0]!, serviceKey: "other" }] }),
      payload({ items: [{ ...payload().items[0]!, tierKey: "invented" }] }),
      payload({ items: [{ ...payload().items[0]!, label: "bad\nlabel" }] }),
      payload({ items: [{ ...payload().items[0]!, extra: true }] }),
    ];
    for (const candidate of cases) {
      expect(() => parsePartnerRateMutationPayload(candidate)).toThrow(
        TeamMutationFailure,
      );
    }
  });

  it("rejects duplicate tiers and more than 100 rows", () => {
    const row = payload().items[0]!;
    expect(() =>
      parsePartnerRateMutationPayload(
        payload({
          items: [row, { ...row, sortOrder: 1 }],
          confirmation: "SAVE 2 PARTNER RATES",
        }),
      ),
    ).toThrow("duplicates");

    expect(() =>
      parsePartnerRateMutationPayload(
        payload({
          items: Array.from({ length: 101 }, (_, index) => ({
            ...row,
            tierKey: `tier-${index}`,
            sortOrder: index,
          })),
          confirmation: "SAVE 101 PARTNER RATES",
        }),
      ),
    ).toThrow("between 1 and 100");
  });
});
