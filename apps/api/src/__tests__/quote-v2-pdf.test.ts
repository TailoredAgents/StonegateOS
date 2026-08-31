import { createHash } from "node:crypto";
import {
  renderQuoteAcceptanceCertificate,
  renderQuoteProposalPdf,
} from "@/lib/quote-v2-pdf";
import { buildQuoteRenderModel } from "@/lib/quote-v2-render-model";

const renderInput = {
  quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
  versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
  quoteNumber: "Q-20260830-UNICODE",
  versionNumber: 1,
  issuedAt: "2026-08-30T12:00:00.000Z",
  expiresAt: "2026-09-29T12:00:00.000Z",
  selectedOptionIds: [],
  attachments: [
    {
      id: "6c595713-0466-4a9a-a854-b34eebf278c0",
      fileName: "site-photos.pdf",
      caption: "Café loading area",
      mediaType: "application/pdf" as const,
      displayOrder: 0,
    },
  ],
  document: {
    schemaVersion: 1 as const,
    documentType: "fixed_quote" as const,
    audience: "commercial" as const,
    schedulingMode: "staff_followup" as const,
    parties: {
      customerName: "Renée Client",
      companyName: "Café Example",
      attentionName: "Renée Client",
      attentionTitle: "Facilities Manager",
      billingAddress: "100 Billing Way, Atlanta, GA 30301",
      serviceAddress: "200 Service Way, Atlanta, GA 30302",
      projectName: "Warehouse cleanout",
      purchaseOrder: "PO-42",
      preparerName: "Jordan Sales",
    },
    issuer: {
      legalName: "Stonegate Services LLC",
      displayName: "Stonegate",
      address: "1 Stonegate Way, Atlanta, GA 30301",
      email: "support@example.test",
      phoneE164: "+14045550100",
    },
    scope: "Remove and responsibly dispose of the listed material.",
    inclusions: Array.from(
      { length: 50 },
      (_, index) =>
        `Included service ${index + 1}: detailed labor, hauling, cleanup, and responsible disposal requirements for this project.`,
    ),
    exclusions: ["Hazardous materials"],
    assumptions: ["Clear site access"],
    pricing: {
      documentType: "fixed_quote" as const,
      currency: "USD" as const,
      lineItems: [
        {
          id: "service",
          name: "Commercial cleanout",
          description: "Labor, hauling, and responsible disposal",
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
      terms: "This fixed quote covers only the stated scope.",
      paymentTerms: "Balance due on completion.",
      changeOrderRules: "Additional work requires written approval.",
      validityDays: 30,
      consentVersion: "fixed-v1",
    },
    estimatedDurationMinutes: 240,
    serviceZoneConfirmed: true,
  },
};

describe("quote V2 React PDF documents", () => {
  it("renders a branded, multipage, Unicode proposal", async () => {
    const model = buildQuoteRenderModel(renderInput);
    const pdf = await renderQuoteProposalPdf({ model });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(10_000);
    const pageCount = pdf.toString("latin1").match(/\/Count (\d+)/u);
    expect(Number(pageCount?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("renders an acceptance certificate only when hashes and totals reconcile", async () => {
    const model = buildQuoteRenderModel({
      ...renderInput,
      document: { ...renderInput.document, inclusions: ["Labor and disposal"] },
    });
    const issuedPdf = await renderQuoteProposalPdf({ model });
    const issuedPdfHash = createHash("sha256").update(issuedPdf).digest("hex");
    const evidence = {
      responseId: "8f481d46-d29f-4308-b5d6-977a377ab7ad",
      signerName: "Renée Client",
      signerTitle: "Facilities Manager",
      signerCompany: "Café Example",
      authorityAffirmed: true as const,
      acceptedAt: "2026-08-31T12:00:00.000Z",
      consentText:
        "I am authorized to accept this fixed scoped total and its terms.",
      consentVersion: "fixed-v1",
      selectedOptionIds: [],
      acceptedTotalMinCents: model.totals.totalMinCents,
      acceptedTotalMaxCents: model.totals.totalMaxCents,
      acceptedDepositCents: model.totals.depositCents,
      acceptedBalanceMinCents: model.totals.balanceMinCents,
      acceptedBalanceMaxCents: model.totals.balanceMaxCents,
      configurationHash: "c".repeat(64),
      consentHash: "d".repeat(64),
      contentHash: model.contentHash,
      issuedPdfHash,
    };
    const certificate = await renderQuoteAcceptanceCertificate({
      model,
      issuedContentHash: model.contentHash,
      evidence,
    });
    expect(certificate.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(certificate.byteLength).toBeGreaterThan(5_000);

    await expect(
      renderQuoteAcceptanceCertificate({
        model,
        issuedContentHash: model.contentHash,
        evidence: {
          ...evidence,
          acceptedTotalMinCents: 1,
          acceptedTotalMaxCents: 1,
          acceptedDepositCents: 0,
          acceptedBalanceMinCents: 1,
          acceptedBalanceMaxCents: 1,
        },
      }),
    ).rejects.toThrow("does not reconcile");
  });
});
