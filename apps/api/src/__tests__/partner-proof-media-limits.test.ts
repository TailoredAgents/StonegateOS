import { partnerMediaCountsAllowed } from "@/lib/partner-media-limits";
describe("separate proof image and scanned-document allowances", () => {
  it("preserves all 40 photo slots when PDF documents are also present", () => {
    expect(partnerMediaCountsAllowed(40, 10)).toBe(true);
    expect(partnerMediaCountsAllowed(40, 0)).toBe(true);
    expect(partnerMediaCountsAllowed(0, 10)).toBe(true);
    expect(partnerMediaCountsAllowed(0, 0)).toBe(true);
  });
  it("bounds both counts and rejects invalid values", () => {
    for (const [images, documents] of [
      [41, 0],
      [0, 11],
      [-1, 0],
      [0, -1],
      [0.5, 0],
      [0, NaN],
      [Infinity, 0],
    ]) {
      expect(partnerMediaCountsAllowed(images!, documents!)).toBe(false);
    }
  });
});
