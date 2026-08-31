import {
  PublicQuoteChangeCommandSchema,
  PublicQuoteDecisionCommandSchema,
  QuoteDocumentSnapshotSchema,
  QuoteV2SaveDraftCommandSchema,
  QuoteV2CreateCommandSchema,
  QuoteV2IssueCommandSchema,
  quoteV2ErrorStatus,
} from "@/lib/quote-v2-contract";

const document = {
  schemaVersion: 1 as const,
  documentType: "fixed_quote" as const,
  audience: "commercial" as const,
  schedulingMode: "staff_followup" as const,
  parties: {
    customerName: "Alex Client",
    companyName: "Example Commercial",
    attentionName: "Alex Client",
    attentionTitle: "Facilities Manager",
    email: "alex@example.test",
    phoneE164: "+14045550123",
    billingAddress: "100 Billing Way, Atlanta, GA 30301",
    serviceAddress: "200 Service Way, Atlanta, GA 30302",
    projectName: "Warehouse cleanout",
    purchaseOrder: "PO-42",
    reference: "SITE-A",
    preparerName: "Jordan Sales",
  },
  issuer: {
    legalName: "Stonegate Services LLC",
    displayName: "Stonegate",
    address: "1 Stonegate Way, Atlanta, GA 30301",
    email: "support@example.test",
    phoneE164: "+14045550100",
    website: "https://example.test",
  },
  scope: "Remove and dispose of the listed material.",
  inclusions: ["Labor and disposal"],
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
        unitPriceMinCents: 125_000,
        displayOrder: 0,
      },
    ],
    optionGroups: [],
    adjustments: [],
    deposit: { mode: "fixed" as const, amountCents: 25_000 },
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
  serviceZoneId: "core",
  serviceZoneConfirmed: true,
};

describe("quote V2 API contracts", () => {
  it("accepts a complete immutable commercial document and excludes internals", () => {
    const parsed = QuoteDocumentSnapshotSchema.parse(document);
    expect(parsed).toMatchObject(document);
    expect(parsed.pricing.lineItems[0]).toMatchObject({
      id: "service",
      catalogKey: null,
      description: null,
      optionGroupId: null,
      selectedByDefault: false,
    });
    expect(
      QuoteDocumentSnapshotSchema.safeParse({
        ...document,
        internalNotes: "Never send this to the customer",
      }).success,
    ).toBe(false);
  });

  it("requires explicit blank-safe project selection during create", () => {
    expect(
      QuoteV2CreateCommandSchema.safeParse({
        confirmation: "create_quote_v2",
        contactId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
        propertyId: "6000319b-e380-4c14-bd60-7366f18c42e4",
        projectName: "Loading dock removal",
        audience: "commercial",
        documentType: "estimate",
        schedulingMode: "staff_followup",
      }).success,
    ).toBe(true);
    expect(
      QuoteV2CreateCommandSchema.safeParse({
        confirmation: "create_quote_v2",
        contactId: "",
        propertyId: "",
        projectName: "Loading dock removal",
        audience: "commercial",
        documentType: "estimate",
        schedulingMode: "staff_followup",
      }).success,
    ).toBe(false);
  });

  it("allows bounded incomplete autosaves but not incomplete final documents", () => {
    const partialDocument = {
      schemaVersion: 1,
      documentType: "range",
      audience: "commercial",
      schedulingMode: "staff_followup",
      parties: { customerName: "Alex Client" },
      issuer: {},
      scope: "",
      pricing: {
        documentType: "range",
        currency: "USD",
        lineItems: [
          {
            id: "new-line",
            name: "",
            quantity: 0,
            unit: "",
            unitPriceMinCents: -1,
            unitPriceMaxCents: null,
            optionGroupId: null,
            selectedByDefault: false,
            displayOrder: 0,
          },
        ],
        optionGroups: [],
        adjustments: [],
        deposit: { mode: "fixed", amountCents: -1 },
      },
      terms: {
        terms: "",
        paymentTerms: "",
        changeOrderRules: "",
        validityDays: 0,
      },
      estimatedDurationMinutes: 0,
    };
    expect(
      QuoteV2SaveDraftCommandSchema.safeParse({
        confirmation: "save_quote_draft",
        versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
        draftRevision: 1,
        document: partialDocument,
      }).success,
    ).toBe(true);
    expect(QuoteDocumentSnapshotSchema.safeParse(partialDocument).success).toBe(
      false,
    );
  });

  it("requires exactly one signer and valid destinations per selected channel", () => {
    const base = {
      confirmation: "issue_quote_version" as const,
      quoteRevision: 1,
      recipients: [
        {
          role: "signer" as const,
          name: "Alex Client",
          email: "alex@example.test",
          channels: ["email" as const],
        },
        {
          role: "cc" as const,
          name: "Finance",
          email: "finance@example.test",
          channels: ["email" as const],
        },
      ],
      sendNow: true,
    };
    expect(QuoteV2IssueCommandSchema.safeParse(base).success).toBe(true);
    expect(
      QuoteV2IssueCommandSchema.safeParse({
        ...base,
        recipients: base.recipients.map((recipient) => ({
          ...recipient,
          role: "cc",
        })),
      }).success,
    ).toBe(false);
    expect(
      QuoteV2IssueCommandSchema.safeParse({
        ...base,
        recipients: [
          {
            role: "signer",
            name: "Alex Client",
            channels: ["sms"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("binds every public change and decision to quote and version UUIDs", () => {
    const quoteId = "f0da8764-f724-4a17-bfa2-70cad4a31af0";
    const versionId = "6000319b-e380-4c14-bd60-7366f18c42e4";
    expect(
      PublicQuoteChangeCommandSchema.safeParse({
        quoteId,
        versionId,
        category: "scope",
        message: "Please exclude the north storage room.",
      }).success,
    ).toBe(true);
    expect(
      PublicQuoteDecisionCommandSchema.safeParse({
        decision: "accepted",
        quoteId,
        versionId,
        selectedOptionIds: [],
        signer: {
          name: "Alex Client",
          title: "Facilities Manager",
          company: "Example Commercial",
          authorityAffirmed: true,
        },
        consentVersion: "fixed-v1",
        consentAffirmed: true,
      }).success,
    ).toBe(true);
    expect(
      PublicQuoteDecisionCommandSchema.safeParse({
        decision: "accepted",
        quoteId,
        selectedOptionIds: [],
      }).success,
    ).toBe(false);
  });

  it("maps public contract failures to the required HTTP semantics", () => {
    expect(quoteV2ErrorStatus("not_found")).toBe(404);
    expect(quoteV2ErrorStatus("gone")).toBe(410);
    expect(quoteV2ErrorStatus("conflict")).toBe(409);
    expect(quoteV2ErrorStatus("invalid")).toBe(422);
    expect(quoteV2ErrorStatus("rate_limited")).toBe(429);
    expect(quoteV2ErrorStatus("provider_unavailable")).toBe(503);
  });
});
