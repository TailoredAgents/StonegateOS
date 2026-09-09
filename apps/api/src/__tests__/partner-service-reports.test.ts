import { parsePartnerServiceReportQuery } from "@/lib/partner-service-reports";
import {
  requiresHostedCollectionRetirement,
  isSquareHostedOrderRetired,
} from "@/lib/partner-hosted-retirement";
describe("report filter and legacy collection boundaries", () => {
  it("uses local inclusive dates across DST and bounds ranges", () => {
    const result = parsePartnerServiceReportQuery(
      new URLSearchParams("from=2026-03-08&to=2026-03-08"),
    );
    expect(result.end.getTime() - result.start.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
    for (const query of [
      "from=2020-01-01&to=2026-01-01",
      "from=2026-02-30",
      "status=no_such_state",
      "from=2026-09-08&from=2026-09-09",
      "internalNotes=true",
      "currency=USD",
      "format=csv&cursor=abc",
    ]) {
      expect(() =>
        parsePartnerServiceReportQuery(new URLSearchParams(query)),
      ).toThrow();
    }
  });
  it("does not treat expired hosted URLs or a no-charge note as provider retirement", () => {
    expect(
      requiresHostedCollectionRetirement({
        partnerPortalPayment: {
          checkoutMode: "hosted_redirect",
          checkoutUrl: "https://square.link/test",
        },
      }),
    ).toBe(true);
    expect(
      requiresHostedCollectionRetirement({
        partnerPortalPayment: {
          checkoutMode: "embedded_ach",
          checkoutUrl: null,
        },
      }),
    ).toBe(false);
    expect(
      isSquareHostedOrderRetired({ id: "order", state: "OPEN" }, "order"),
    ).toBe(false);
    expect(
      isSquareHostedOrderRetired({ id: "other", state: "CANCELED" }, "order"),
    ).toBe(false);
    expect(
      isSquareHostedOrderRetired(
        {
          id: "order",
          state: "CANCELED",
          tenders: [{ payment_id: "pending-ach" }],
        },
        "order",
      ),
    ).toBe(false);
    expect(
      isSquareHostedOrderRetired(
        { id: "order", state: "CANCELED", tenders: [] },
        "order",
      ),
    ).toBe(true);
  });
});
