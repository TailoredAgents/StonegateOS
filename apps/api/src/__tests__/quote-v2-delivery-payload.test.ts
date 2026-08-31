import { randomBytes } from "node:crypto";
import {
  QuoteDeliveryEncryptionConfigurationError,
  decryptQuoteDeliveryProviderPayload,
  encryptQuoteDeliveryProviderPayload,
  hashQuoteDeliveryRecipientAddress,
} from "@/lib/quote-v2-delivery-payload";

const quoteId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const deliveryId = "33333333-3333-4333-8333-333333333333";

describe("quote V2 encrypted delivery payload", () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    const primary = randomBytes(32).toString("base64");
    const retired = randomBytes(32).toString("base64");
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEY_ID"] = "key-2";
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"] = JSON.stringify({
      "key-1": retired,
      "key-2": primary,
    });
    process.env["QUOTE_DELIVERY_ADDRESS_HMAC_KEY_BASE64"] =
      randomBytes(32).toString("base64");
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it("keeps the one-time capability and recipient data encrypted at rest", () => {
    const payload = {
      quoteId,
      versionId,
      deliveryId,
      capabilityToken: "customer-capability-secret",
      channel: "email" as const,
      recipient: {
        role: "signer" as const,
        name: "Taylor Client",
        address: "Taylor@example.com",
      },
      content: {
        subject: "Your proposal",
        html: "<p>Review the proposal.</p>",
        text: "Review the proposal.",
        documentId: "44444444-4444-4444-8444-444444444444",
      },
    };
    const encrypted = encryptQuoteDeliveryProviderPayload({ payload });

    expect(encrypted.encryptionKeyId).toBe("key-2");
    expect(encrypted.encryptedProviderPayload).not.toContain(
      payload.capabilityToken,
    );
    expect(encrypted.encryptedProviderPayload).not.toContain(
      payload.recipient.address,
    );
    expect(
      decryptQuoteDeliveryProviderPayload({
        ...encrypted,
        deliveryId,
        versionId,
      }),
    ).toEqual(payload);
  });

  it("cryptographically binds ciphertext to its delivery and version", () => {
    const encrypted = encryptQuoteDeliveryProviderPayload({
      payload: {
        quoteId,
        versionId,
        deliveryId,
        capabilityToken: "customer-capability-secret",
        channel: "sms",
        recipient: {
          role: "cc",
          name: "Project manager",
          address: "+15555550123",
        },
        content: { text: "Proposal link" },
      },
    });

    expect(() =>
      decryptQuoteDeliveryProviderPayload({
        ...encrypted,
        deliveryId: "55555555-5555-4555-8555-555555555555",
        versionId,
      }),
    ).toThrow();
    const parts = encrypted.encryptedProviderPayload.split(".");
    parts[3] = `${parts[3]?.slice(0, -1)}A`;
    expect(() =>
      decryptQuoteDeliveryProviderPayload({
        encryptedProviderPayload: parts.join("."),
        encryptionKeyId: encrypted.encryptionKeyId,
        deliveryId,
        versionId,
      }),
    ).toThrow();
  });

  it("uses a keyed, normalized digest for delivery addresses", () => {
    expect(
      hashQuoteDeliveryRecipientAddress({
        channel: "email",
        address: " Customer@Example.com ",
      }),
    ).toBe(
      hashQuoteDeliveryRecipientAddress({
        channel: "email",
        address: "customer@example.com",
      }),
    );
    expect(
      hashQuoteDeliveryRecipientAddress({
        channel: "email",
        address: "customer@example.com",
      }),
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("fails closed when the active encryption key is unavailable", () => {
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"] = JSON.stringify({
      "key-1": randomBytes(32).toString("base64"),
    });
    expect(() =>
      encryptQuoteDeliveryProviderPayload({
        payload: {
          quoteId,
          versionId,
          deliveryId,
          capabilityToken: "customer-capability-secret",
          channel: "sms",
          recipient: {
            role: "signer",
            name: "Taylor Client",
            address: "+15555550123",
          },
          content: { text: "Proposal link" },
        },
      }),
    ).toThrow(QuoteDeliveryEncryptionConfigurationError);
  });
});
