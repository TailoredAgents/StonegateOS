import { parsePartnerRateCsv } from "../../../site/src/app/team/lib/partner-rate-input";

describe("partner rate CSV boundary", () => {
  it("parses three- and four-column USD rows without coercion", () => {
    expect(
      parsePartnerRateCsv(
        "junk-removal,quarter,Quarter load,150.00\ndemo-hauloff,small,650",
      ),
    ).toEqual({
      ok: true,
      items: [
        {
          serviceKey: "junk-removal",
          tierKey: "quarter",
          label: "Quarter load",
          amountCents: 15_000,
          sortOrder: 0,
        },
        {
          serviceKey: "demo-hauloff",
          tierKey: "small",
          label: null,
          amountCents: 65_000,
          sortOrder: 1,
        },
      ],
    });
  });

  it.each([
    "junk-removal,quarter,Quarter load,-100",
    "junk-removal,quarter,Quarter load,1e3",
    "junk-removal,quarter,Quarter load,$150",
    "junk-removal,quarter,Quarter load,0",
    "junk-removal,quarter,Quarter load,150.001",
    "junk-removal,quarter,Quarter load,150,hidden",
    "unknown,quarter,Quarter load,150",
    "junk-removal,invented,Invented,150",
  ])("rejects malformed row without dropping it: %s", (csv) => {
    expect(parsePartnerRateCsv(csv)).toMatchObject({ ok: false });
  });

  it("rejects duplicates, empty input, too many rows, and oversized input", () => {
    expect(
      parsePartnerRateCsv(
        "junk-removal,quarter,First,150\njunk-removal,quarter,Second,200",
      ),
    ).toMatchObject({ ok: false });
    expect(parsePartnerRateCsv("\n# comment")).toMatchObject({ ok: false });
    expect(
      parsePartnerRateCsv(
        Array.from(
          { length: 101 },
          () => "junk-removal,quarter,Quarter,150",
        ).join("\n"),
      ),
    ).toMatchObject({ ok: false });
    expect(parsePartnerRateCsv("x".repeat(65_537))).toMatchObject({
      ok: false,
    });
  });
});
