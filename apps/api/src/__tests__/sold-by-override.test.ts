import {
  isValidSoldByOverrideCode,
  resolveSoldByBaseline,
  soldByChangeRequiresOverride,
} from "@/lib/sold-by-override";

describe("sold-by override helpers", () => {
  const originalCode = process.env["SOLD_BY_OVERRIDE_CODE"];

  afterEach(() => {
    if (originalCode === undefined) {
      delete process.env["SOLD_BY_OVERRIDE_CODE"];
    } else {
      process.env["SOLD_BY_OVERRIDE_CODE"] = originalCode;
    }
  });

  it("prefers the current sold-by member as baseline", () => {
    expect(
      resolveSoldByBaseline({
        currentSoldByMemberId: "devon",
        assignedSalespersonMemberId: "austin",
      }),
    ).toBe("devon");
  });

  it("requires override when changing away from the baseline seller", () => {
    expect(
      soldByChangeRequiresOverride({
        nextSoldByMemberId: "devon",
        assignedSalespersonMemberId: "austin",
      }),
    ).toBe(true);
  });

  it("does not require override when there is no baseline seller yet", () => {
    expect(
      soldByChangeRequiresOverride({
        nextSoldByMemberId: "devon",
      }),
    ).toBe(false);
  });

  it("validates the configured override code", () => {
    process.env["SOLD_BY_OVERRIDE_CODE"] = "2468";
    expect(isValidSoldByOverrideCode("2468")).toBe(true);
    expect(isValidSoldByOverrideCode("1357")).toBe(false);
  });
});
