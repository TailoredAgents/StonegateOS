import { randomBytes } from "node:crypto";
import { decryptQuoteDeliveryProviderPayload } from "@/lib/quote-v2-delivery-payload";
import { prepareQuoteVersionIssue } from "@/lib/quote-v2-issue";

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
];

const document = {
  schemaVersion: 1 as const,
  documentType: "fixed_quote" as const,
  audience: "commercial" as const,
  schedulingMode: "staff_followup" as const,
  parties: {
    customerName: "Taylor Client",
    companyName: "Client Company",
    attentionName: "Taylor Client",
    attentionTitle: "Facilities Manager",
    email: "taylor@example.test",
    phoneE164: "+15555550123",
    billingAddress: "10 Billing Road, Atlanta, GA 30301",
    serviceAddress: "20 Project Road, Atlanta, GA 30302",
    projectName: "Commercial cleanout",
    purchaseOrder: "PO-200",
    reference: "SITE-A",
    preparerName: "Jordan Sales",
  },
  issuer: {
    legalName: "Stonegate Services LLC",
    displayName: "Stonegate",
    address: "1 Stonegate Way, Atlanta, GA 30301",
    email: "support@example.test",
    phoneE164: "+14045550100",
  },
  scope: "Remove the listed material and leave the service area broom-clean.",
  inclusions: ["Labor", "Hauling", "Disposal"],
  exclusions: ["Hazardous waste"],
  assumptions: ["Unobstructed loading access"],
  pricing: {
    documentType: "fixed_quote" as const,
    currency: "USD" as const,
    lineItems: [
      {
        id: "cleanout",
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
    terms: "This fixed quote covers the stated scope.",
    paymentTerms: "Deposit due before scheduling; balance due on completion.",
    changeOrderRules: "Additional work requires written approval.",
    validityDays: 30,
    consentVersion: "fixed-commercial-v1",
  },
  estimatedDurationMinutes: 240,
  serviceZoneId: "core",
  serviceZoneConfirmed: true,
};

describe("quote V2 issue preparation", () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    const encryptionKey = randomBytes(32).toString("base64");
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEY_ID"] = "test";
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"] = JSON.stringify({
      test: encryptionKey,
    });
    process.env["QUOTE_DELIVERY_ADDRESS_HMAC_KEY_BASE64"] =
      randomBytes(32).toString("base64");
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it("freezes one canonical proposal across PDF, capabilities, and channels", async () => {
    let nextId = 0;
    const prepared = await prepareQuoteVersionIssue(
      {
        quoteId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        quoteNumber: "Q-20260830-TEST0001",
        versionNumber: 1,
        document,
        recipients: [
          {
            role: "signer",
            name: "Taylor Client",
            email: "taylor@example.test",
            phoneE164: "+15555550123",
            channels: ["email", "sms"],
          },
          {
            role: "cc",
            name: "Alex Viewer",
            email: "alex@example.test",
            channels: ["email"],
          },
        ],
        coverMessage: "Thank you for the opportunity.",
        sendNow: true,
        issuedByTeamMemberId: "33333333-3333-4333-8333-333333333333",
        idempotencyKeyHash: "a".repeat(64),
        correlationId: "correlation-quote-issue-1",
        publicBaseUrl: "https://stonegate.example",
        storageProvider: "r2",
        storageBucket: "quote-documents",
      },
      {
        now: new Date("2026-08-30T12:00:00.000Z"),
        id: () => ids[nextId++] ?? crypto.randomUUID(),
      },
    );

    expect(prepared.persistence.version.expiresAt.toISOString()).toBe(
      "2026-09-29T12:00:00.000Z",
    );
    expect(prepared.persistence.version.totals.totalMinCents).toBe(125_000);
    expect(
      prepared.persistence.document.body.subarray(0, 5).toString("ascii"),
    ).toBe("%PDF-");
    expect(prepared.persistence.capabilities).toHaveLength(2);
    expect(prepared.persistence.capabilities[0]?.allowedActions).toContain(
      "accept",
    );
    expect(prepared.persistence.capabilities[1]?.allowedActions).toEqual([
      "view",
      "pdf",
    ]);
    expect(prepared.persistence.deliveries).toHaveLength(3);
    expect(prepared.oneTimeLinks).toHaveLength(2);

    const serializedPersistence = JSON.stringify(prepared.persistence);
    for (const link of prepared.oneTimeLinks) {
      const token = link.proposalUrl.split("/").at(-1) ?? "";
      expect(serializedPersistence).not.toContain(token);
    }

    const signerEmail = prepared.persistence.deliveries.find(
      (delivery) =>
        delivery.recipientRole === "signer" && delivery.channel === "email",
    );
    expect(signerEmail).toBeDefined();
    const decrypted = decryptQuoteDeliveryProviderPayload({
      encryptedProviderPayload: signerEmail!.encryptedProviderPayload,
      encryptionKeyId: signerEmail!.encryptionKeyId,
      deliveryId: signerEmail!.id,
      versionId: "22222222-2222-4222-8222-222222222222",
    });
    expect(decrypted.content.text).toContain("$1,250.00");
    expect(decrypted.content.text).toContain("Version 1");
    expect(decrypted.content.documentId).toBe(prepared.persistence.document.id);
  });

  it("issues without a send attempt while still returning the link once", async () => {
    let nextId = 0;
    const prepared = await prepareQuoteVersionIssue(
      {
        quoteId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        quoteNumber: "Q-20260830-TEST0002",
        versionNumber: 1,
        document,
        recipients: [
          {
            role: "signer",
            name: "Taylor Client",
            email: "taylor@example.test",
            channels: ["email"],
          },
        ],
        sendNow: false,
        issuedByTeamMemberId: "33333333-3333-4333-8333-333333333333",
        idempotencyKeyHash: "b".repeat(64),
        correlationId: "correlation-quote-issue-2",
        publicBaseUrl: "https://stonegate.example",
        storageProvider: "s3",
        storageBucket: "quote-documents",
      },
      {
        now: new Date("2026-08-30T12:00:00.000Z"),
        id: () => ids[nextId++] ?? crypto.randomUUID(),
      },
    );

    expect(prepared.persistence.sendAttempt).toBeNull();
    expect(prepared.persistence.deliveries).toEqual([]);
    expect(prepared.oneTimeLinks).toHaveLength(1);
  });

  it("rejects issue requests without exactly one signer", async () => {
    await expect(
      prepareQuoteVersionIssue({
        quoteId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        quoteNumber: "Q-20260830-TEST0003",
        versionNumber: 1,
        document,
        recipients: [
          {
            role: "cc",
            name: "Alex Viewer",
            email: "alex@example.test",
            channels: ["email"],
          },
        ],
        sendNow: false,
        issuedByTeamMemberId: "33333333-3333-4333-8333-333333333333",
        idempotencyKeyHash: "c".repeat(64),
        correlationId: "correlation-quote-issue-3",
        publicBaseUrl: "https://stonegate.example",
        storageProvider: "r2",
        storageBucket: "quote-documents",
      }),
    ).rejects.toThrow("Exactly one recipient");
  });
});
