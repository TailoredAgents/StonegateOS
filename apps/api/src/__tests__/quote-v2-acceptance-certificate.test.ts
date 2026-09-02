import { createHash } from "node:crypto";
import {
  prepareQuoteAcceptanceCertificate,
  QuoteAcceptanceCertificateError,
  reconcileQuoteAcceptanceCertificate,
  type QuoteAcceptanceCertificateEnsurer,
  type QuoteAcceptanceCertificateSource,
} from "@/lib/quote-v2-acceptance-certificate";
import { hashQuoteContent } from "@/lib/quote-v2-domain";

const documentSnapshot = {
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
  inclusions: ["Labor and hauling"],
  exclusions: ["Hazardous materials"],
  assumptions: ["Clear site access"],
  pricing: {
    documentType: "fixed_quote" as const,
    currency: "USD" as const,
    lineItems: [
      {
        id: "service",
        name: "Commercial cleanout",
        quantity: 1,
        unit: "project",
        unitPriceMinCents: 100_000,
        displayOrder: 0,
      },
      {
        id: "appliance",
        name: "Appliance removal",
        quantity: 1,
        unit: "item",
        unitPriceMinCents: 10_000,
        optionGroupId: "extras",
        selectedByDefault: false,
        displayOrder: 1,
      },
    ],
    optionGroups: [
      {
        id: "extras",
        label: "Optional additions",
        mode: "multiple" as const,
        minimumSelections: 0,
        maximumSelections: 1,
      },
    ],
    adjustments: [],
    deposit: { mode: "percentage" as const, basisPoints: 2_500 },
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
};

function acceptanceSource(
  overrides: Partial<QuoteAcceptanceCertificateSource> = {},
): QuoteAcceptanceCertificateSource {
  const configurationSnapshot = {
    documentType: "fixed_quote",
    schedulingMode: "staff_followup",
    selectedOptionIds: ["appliance"],
    requestedStartAt: null,
    holdId: null,
    totals: {
      totalMinCents: 110_000,
      totalMaxCents: 110_000,
      depositCents: 27_500,
      balanceMinCents: 82_500,
      balanceMaxCents: 82_500,
    },
  };
  const consentText =
    "I approve this firm scoped total and agree to the proposal terms.";
  return {
    quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
    versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
    responseId: "8f481d46-d29f-4308-b5d6-977a377ab7ad",
    quoteNumber: "Q-20260830-ACCEPT",
    versionNumber: 2,
    aggregateState: "accepted",
    versionState: "accepted",
    issuedAt: new Date("2026-08-30T12:00:00.000Z"),
    expiresAt: new Date("2026-09-29T12:00:00.000Z"),
    acceptedAt: new Date("2026-08-31T12:00:00.000Z"),
    documentSnapshot,
    signerSnapshot: {
      name: "Renée Client",
      title: "Facilities Manager",
      company: "Café Example",
      authorityAffirmed: true,
    },
    configurationSnapshot,
    selectedOptionIds: ["appliance"],
    consentText,
    consentVersion: "fixed-v1",
    consentAffirmed: true,
    configurationHash: hashQuoteContent(configurationSnapshot),
    consentHash: hashQuoteContent({
      text: consentText,
      version: "fixed-v1",
      affirmed: true,
    }),
    contentHash: "a".repeat(64),
    versionContentHash: "a".repeat(64),
    issuedPdfHash: "b".repeat(64),
    proposalDocumentHash: "b".repeat(64),
    acceptedTotalMinCents: 110_000,
    acceptedTotalMaxCents: 110_000,
    acceptedDepositCents: 27_500,
    acceptedBalanceMinCents: 82_500,
    acceptedBalanceMaxCents: 82_500,
    ...overrides,
  };
}

describe("Quote V2 acceptance certificate", () => {
  it("renders immutable evidence for the accepted option configuration", async () => {
    const prepared =
      await prepareQuoteAcceptanceCertificate(acceptanceSource());

    expect(prepared.body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(prepared.byteSize).toBeGreaterThan(5_000);
    expect(prepared.sha256).toBe(
      createHash("sha256").update(prepared.body).digest("hex"),
    );
    expect(prepared.filename).toBe("Q-20260830-ACCEPT-v2-accepted.pdf");
    expect(prepared.storageObjectKey).toBe(
      `quotes/${prepared.quoteId}/versions/${prepared.versionId}/acceptance-${prepared.responseId}-${prepared.sha256}.pdf`,
    );
    expect(prepared.metadata).toMatchObject({
      evidenceSchemaVersion: 1,
      responseId: prepared.responseId,
      contentHash: "a".repeat(64),
      issuedPdfHash: "b".repeat(64),
    });
    expect(JSON.stringify(prepared.metadata)).not.toMatch(
      /Renée|Café|Facilities Manager/u,
    );
  });

  it("is deterministic and therefore storage-idempotent", async () => {
    const first = await prepareQuoteAcceptanceCertificate(acceptanceSource());
    const second = await prepareQuoteAcceptanceCertificate(acceptanceSource());

    expect(second.sha256).toBe(first.sha256);
    expect(second.storageObjectKey).toBe(first.storageObjectKey);
    expect(second.body.equals(first.body)).toBe(true);
  });

  it("rejects mismatched issued documents, consent, configuration, and totals", async () => {
    await expect(
      prepareQuoteAcceptanceCertificate(
        acceptanceSource({ proposalDocumentHash: "c".repeat(64) }),
      ),
    ).rejects.toBeInstanceOf(QuoteAcceptanceCertificateError);
    await expect(
      prepareQuoteAcceptanceCertificate(
        acceptanceSource({ consentHash: "d".repeat(64) }),
      ),
    ).rejects.toThrow("hashes do not reconcile");
    await expect(
      prepareQuoteAcceptanceCertificate(
        acceptanceSource({ configurationHash: "e".repeat(64) }),
      ),
    ).rejects.toThrow("hashes do not reconcile");
    await expect(
      prepareQuoteAcceptanceCertificate(
        acceptanceSource({ acceptedTotalMinCents: 109_999 }),
      ),
    ).rejects.toThrow("totals do not reconcile");
  });

  it("requires explicit signer authority and an accepted immutable lifecycle", async () => {
    await expect(
      prepareQuoteAcceptanceCertificate(
        acceptanceSource({
          signerSnapshot: {
            name: "Renée Client",
            title: "Facilities Manager",
            authorityAffirmed: false,
          },
        }),
      ),
    ).rejects.toThrow("signer or configuration snapshot is incomplete");
    await expect(
      prepareQuoteAcceptanceCertificate(
        acceptanceSource({ versionState: "issued" }),
      ),
    ).rejects.toThrow("requires an accepted quote version");
  });

  it("keeps a committed acceptance pending after storage failure and converges on retry", async () => {
    let attempts = 0;
    const ensure: QuoteAcceptanceCertificateEnsurer = (_db, input) => {
      attempts += 1;
      if (attempts === 1)
        return Promise.reject(new Error("injected_storage_failure"));
      return Promise.resolve({
        documentId: "70000000-0000-4000-8000-000000000001",
        quoteId: "10000000-0000-4000-8000-000000000001",
        versionId: "20000000-0000-4000-8000-000000000001",
        responseId: input.responseId,
        sha256: "a".repeat(64),
        state: "created",
      });
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const pending = await reconcileQuoteAcceptanceCertificate(
        {} as Parameters<typeof reconcileQuoteAcceptanceCertificate>[0],
        { responseId: "30000000-0000-4000-8000-000000000001" },
        { ensure },
      );
      expect(pending).toEqual({ state: "pending", retryable: true });

      const ready = await reconcileQuoteAcceptanceCertificate(
        {} as Parameters<typeof reconcileQuoteAcceptanceCertificate>[0],
        { responseId: "30000000-0000-4000-8000-000000000001" },
        { ensure },
      );
      expect(ready).toEqual({
        state: "ready",
        documentId: "70000000-0000-4000-8000-000000000001",
        sha256: "a".repeat(64),
      });
      expect(attempts).toBe(2);
    } finally {
      console.warn = warn;
    }
  });

  it("marks immutable evidence conflicts pending for reconciliation without throwing", async () => {
    const ensure: QuoteAcceptanceCertificateEnsurer = () =>
      Promise.reject(
        new QuoteAcceptanceCertificateError(
          "evidence_mismatch",
          "Injected evidence mismatch.",
        ),
      );
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await expect(
        reconcileQuoteAcceptanceCertificate(
          {} as Parameters<typeof reconcileQuoteAcceptanceCertificate>[0],
          { responseId: "30000000-0000-4000-8000-000000000001" },
          { ensure },
        ),
      ).resolves.toEqual({ state: "pending", retryable: false });
    } finally {
      console.warn = warn;
    }
  });
});
