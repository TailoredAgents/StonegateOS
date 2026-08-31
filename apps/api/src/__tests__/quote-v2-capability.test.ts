import {
  capabilityActionsForRole,
  generateQuoteCapability,
  hashQuoteCapabilityToken,
  quoteCapabilityHashMatches,
  quoteCapabilityReadExpiry,
  redactQuoteCapabilities,
} from "@/lib/quote-v2-capability";

describe("quote V2 capabilities", () => {
  it("generates a high-entropy token while persisting only its digest", () => {
    const first = generateQuoteCapability();
    const second = generateQuoteCapability();
    expect(first.token).not.toEqual(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(40);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.tokenHash).toBe(hashQuoteCapabilityToken(first.token));
    expect(first.tokenHash).not.toContain(first.token);
  });

  it("compares token hashes without accepting malformed digests", () => {
    const capability = generateQuoteCapability();
    expect(
      quoteCapabilityHashMatches(capability.token, capability.tokenHash),
    ).toBe(true);
    expect(quoteCapabilityHashMatches("wrong", capability.tokenHash)).toBe(
      false,
    );
    expect(quoteCapabilityHashMatches(capability.token, "not-a-hash")).toBe(
      false,
    );
  });

  it("keeps viewer capabilities read-only", () => {
    expect(capabilityActionsForRole("viewer")).toEqual(["view", "pdf"]);
    expect(capabilityActionsForRole("signer")).toEqual(
      expect.arrayContaining(["accept", "decline", "change", "book"]),
    );
  });

  it("applies the selected 90-day and one-year read policies", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(
      quoteCapabilityReadExpiry({ at, outcome: "superseded" }).toISOString(),
    ).toBe("2026-04-01T00:00:00.000Z");
    expect(
      quoteCapabilityReadExpiry({ at, outcome: "accepted" }).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
  });

  it("redacts nested quote secrets before audit or event serialization", () => {
    expect(
      redactQuoteCapabilities({
        shareToken: "secret",
        nested: { share_url: "https://example.test/quote/secret", ok: true },
      }),
    ).toEqual({
      shareToken: "[REDACTED_QUOTE_CAPABILITY]",
      nested: { share_url: "[REDACTED_QUOTE_CAPABILITY]", ok: true },
    });
  });
});
