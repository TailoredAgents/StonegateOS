import {
  buildQuoteRenderModel,
  canonicalQuoteRenderJson,
  formatQuoteTotal,
  renderQuoteEmail,
  renderQuoteSms,
} from "@/lib/quote-v2-render-model";

const input = {
  quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
  versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
  quoteNumber: "Q-20260830-ABC123",
  versionNumber: 2,
  issuedAt: "2026-08-30T12:00:00.000Z",
  expiresAt: "2026-09-29T12:00:00.000Z",
  selectedOptionIds: [],
  attachments: [],
  document: {
    schemaVersion: 1 as const,
    documentType: "estimate" as const,
    audience: "commercial" as const,
    schedulingMode: "staff_followup" as const,
    parties: {
      customerName: "Alex & Co",
      companyName: "Example Commercial",
      serviceAddress: "200 Service Way, Atlanta, GA 30302",
      projectName: "Warehouse <cleanout>",
      preparerName: "Jordan Sales",
    },
    issuer: {
      legalName: "Stonegate Services LLC",
      displayName: "Stonegate",
      address: "1 Stonegate Way, Atlanta, GA 30301",
      email: "support@example.test",
      phoneE164: "+14045550100",
    },
    scope: "Remove and dispose of the listed material.",
    inclusions: ["Labor and disposal"],
    exclusions: ["Hazardous materials"],
    assumptions: ["Clear site access"],
    pricing: {
      documentType: "estimate" as const,
      currency: "USD" as const,
      lineItems: [
        {
          id: "service",
          name: "Commercial cleanout",
          quantity: 2.5,
          unit: "hour",
          unitPriceMinCents: 20_000,
          displayOrder: 0,
        },
      ],
      optionGroups: [],
      adjustments: [],
      deposit: { mode: "fixed" as const, amountCents: 10_000 },
    },
    terms: {
      templateVersion: "commercial-v1",
      terms: "This estimate is non-binding.",
      paymentTerms: "Balance due on completion.",
      changeOrderRules: "Additional work requires written approval.",
      validityDays: 30,
      consentVersion: "estimate-v1",
    },
    estimatedDurationMinutes: 240,
    serviceZoneConfirmed: true,
  },
};

describe("quote V2 canonical render model", () => {
  it("reconciles document totals and produces a stable content hash", () => {
    const first = buildQuoteRenderModel(input);
    const second = buildQuoteRenderModel({ ...input });
    expect(first.totals.totalMinCents).toBe(50_000);
    expect(first.totals.depositCents).toBe(10_000);
    expect(first.contentHash).toBe(second.contentHash);
    expect(formatQuoteTotal(first.totals)).toBe("$500.00");
    expect(canonicalQuoteRenderJson(first)).toContain(first.contentHash);
  });

  it("uses identical immutable facts in branded email and deterministic SMS", () => {
    const model = buildQuoteRenderModel(input);
    const proposalUrl = "https://example.test/quote/secure-capability";
    const email = renderQuoteEmail({
      model,
      proposalUrl,
      coverMessage: "Thanks for the walkthrough.",
    });
    const sms = renderQuoteSms({ model, proposalUrl });

    for (const fact of [
      model.quoteNumber,
      "$500.00",
      model.expiryDateLabel,
      proposalUrl,
    ]) {
      expect(email.text).toContain(fact);
      expect(sms).toContain(fact);
    }
    expect(email.html).toContain("Alex &amp; Co");
    expect(email.html).toContain("Warehouse &lt;cleanout&gt;");
    expect(email.subject).toContain("Warehouse <cleanout>");
  });

  it("rejects raw internal notes from the canonical render boundary", () => {
    expect(() =>
      buildQuoteRenderModel({
        ...input,
        document: { ...input.document, internalNotes: "Do not show client" },
      }),
    ).toThrow();
  });
});
