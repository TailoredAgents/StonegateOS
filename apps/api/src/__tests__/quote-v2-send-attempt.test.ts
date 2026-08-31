import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QuoteV2SendAttemptCommandSchema } from "@/lib/quote-v2-contract";
import {
  decryptQuoteDeliveryProviderPayload,
  encryptQuoteDeliveryProviderPayload,
  type QuoteDeliveryProviderPayload,
} from "@/lib/quote-v2-delivery-payload";
import { quoteV2RetryTargetsAreUnique } from "@/lib/quote-v2-send-attempt-service";

const WORKSPACE_ROOT = resolve(process.cwd(), "../..");
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const QUOTE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_DELIVERY_ID = "33333333-3333-4333-8333-333333333333";
const RETRY_DELIVERY_ID = "44444444-4444-4444-8444-444444444444";
const FAILED_SMS_ID = "55555555-5555-4555-8555-555555555555";
const FAILED_EMAIL_ID = "66666666-6666-4666-8666-666666666666";

function source(path: string): string {
  return readFileSync(resolve(WORKSPACE_ROOT, path), "utf8");
}

const routeSource = source(
  "apps/api/app/api/quote-versions/[id]/send-attempts/route.ts",
);
const serviceSource = source(
  "apps/api/src/lib/quote-v2-send-attempt-service.ts",
);
const bffSource = source(
  "apps/site/src/app/api/team/quotes/v2/[...segments]/route.ts",
);

const originalEncryptionKeyId = process.env["QUOTE_DELIVERY_ENCRYPTION_KEY_ID"];
const originalEncryptionKeys =
  process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"];

beforeAll(() => {
  const key = Buffer.alloc(32, 7).toString("base64");
  process.env["QUOTE_DELIVERY_ENCRYPTION_KEY_ID"] = "test-primary";
  process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"] = JSON.stringify({
    "test-primary": key,
  });
});

afterAll(() => {
  if (originalEncryptionKeyId === undefined) {
    delete process.env["QUOTE_DELIVERY_ENCRYPTION_KEY_ID"];
  } else {
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEY_ID"] = originalEncryptionKeyId;
  }
  if (originalEncryptionKeys === undefined) {
    delete process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"];
  } else {
    process.env["QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON"] = originalEncryptionKeys;
  }
});

describe("quote V2 send-attempt command", () => {
  it("accepts a selective failed-delivery retry without mutable send content", () => {
    const parsed = QuoteV2SendAttemptCommandSchema.parse({
      confirmation: "send_quote_version",
      quoteRevision: 9,
      retryDeliveryIds: [FAILED_SMS_ID, FAILED_EMAIL_ID],
    });

    expect(parsed).toEqual({
      confirmation: "send_quote_version",
      quoteRevision: 9,
      recipients: [],
      retryDeliveryIds: [FAILED_SMS_ID, FAILED_EMAIL_ID],
    });
  });

  it("rejects duplicate retry IDs and recipient or cover-message changes", () => {
    const duplicate = QuoteV2SendAttemptCommandSchema.safeParse({
      confirmation: "send_quote_version",
      quoteRevision: 9,
      retryDeliveryIds: [FAILED_SMS_ID, FAILED_SMS_ID],
    });
    const changedRecipient = QuoteV2SendAttemptCommandSchema.safeParse({
      confirmation: "send_quote_version",
      quoteRevision: 9,
      retryDeliveryIds: [FAILED_SMS_ID],
      recipients: [
        {
          role: "signer",
          name: "Client Signer",
          email: "signer@example.test",
          channels: ["email"],
        },
      ],
    });
    const changedMessage = QuoteV2SendAttemptCommandSchema.safeParse({
      confirmation: "send_quote_version",
      quoteRevision: 9,
      retryDeliveryIds: [FAILED_SMS_ID],
      coverMessage: "A different introduction",
    });

    expect(duplicate.success).toBe(false);
    expect(changedRecipient.success).toBe(false);
    expect(changedMessage.success).toBe(false);
  });

  it("requires exactly one signer for a fresh immutable-version resend", () => {
    const valid = QuoteV2SendAttemptCommandSchema.safeParse({
      confirmation: "send_quote_version",
      quoteRevision: 10,
      coverMessage: "Here is the requested proposal.",
      recipients: [
        {
          role: "signer",
          name: "Client Signer",
          email: "signer@example.test",
          channels: ["email"],
        },
        {
          role: "cc",
          name: "Project Observer",
          phoneE164: "+14045550199",
          channels: ["sms"],
        },
      ],
    });
    const noSigner = QuoteV2SendAttemptCommandSchema.safeParse({
      confirmation: "send_quote_version",
      quoteRevision: 10,
      recipients: [
        {
          role: "cc",
          name: "Project Observer",
          email: "observer@example.test",
          channels: ["email"],
        },
      ],
    });
    const twoSigners = QuoteV2SendAttemptCommandSchema.safeParse({
      confirmation: "send_quote_version",
      quoteRevision: 10,
      recipients: [
        {
          role: "signer",
          name: "Signer One",
          email: "one@example.test",
          channels: ["email"],
        },
        {
          role: "signer",
          name: "Signer Two",
          phoneE164: "+14045550198",
          channels: ["sms"],
        },
      ],
    });

    expect(valid.success).toBe(true);
    expect(noSigner.success).toBe(false);
    expect(twoSigners.success).toBe(false);
  });
});

describe("quote V2 selective retry targets", () => {
  const failedSms = {
    id: FAILED_SMS_ID,
    channel: "sms",
    recipientAddressHash: "sms-recipient-hash",
    status: "failed",
  };

  it("permits one failed channel while leaving another successful channel alone", () => {
    expect(
      quoteV2RetryTargetsAreUnique({
        deliveries: [failedSms],
        blockingDeliveries: [
          failedSms,
          {
            id: FAILED_EMAIL_ID,
            channel: "email",
            recipientAddressHash: "email-recipient-hash",
            status: "delivered",
          },
        ],
      }),
    ).toBe(true);
  });

  it.each(["queued", "dispatched", "delivered", "reconciliation_required"])(
    "blocks a retry when the same recipient/channel is already %s",
    (status) => {
      expect(
        quoteV2RetryTargetsAreUnique({
          deliveries: [failedSms],
          blockingDeliveries: [
            failedSms,
            {
              id: RETRY_DELIVERY_ID,
              channel: "sms",
              recipientAddressHash: failedSms.recipientAddressHash,
              status,
            },
          ],
        }),
      ).toBe(false);
    },
  );

  it("rejects non-failures, duplicate selected targets, and an empty selection", () => {
    expect(
      quoteV2RetryTargetsAreUnique({
        deliveries: [{ ...failedSms, status: "dispatched" }],
        blockingDeliveries: [],
      }),
    ).toBe(false);
    expect(
      quoteV2RetryTargetsAreUnique({
        deliveries: [failedSms, { ...failedSms, id: FAILED_EMAIL_ID }],
        blockingDeliveries: [],
      }),
    ).toBe(false);
    expect(
      quoteV2RetryTargetsAreUnique({
        deliveries: [],
        blockingDeliveries: [],
      }),
    ).toBe(false);
  });

  it("requires retrying the latest failed child instead of replaying an old failure", () => {
    expect(
      quoteV2RetryTargetsAreUnique({
        deliveries: [failedSms],
        blockingDeliveries: [
          failedSms,
          {
            id: RETRY_DELIVERY_ID,
            channel: "sms",
            recipientAddressHash: failedSms.recipientAddressHash,
            status: "failed",
            metadata: { retryOfDeliveryId: FAILED_SMS_ID },
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("quote V2 retry payload evidence", () => {
  it("rebinds the exact recipient, capability, content, and version to a new delivery ID", () => {
    const originalPayload: QuoteDeliveryProviderPayload = {
      quoteId: QUOTE_ID,
      versionId: VERSION_ID,
      deliveryId: SOURCE_DELIVERY_ID,
      capabilityToken: "capability-token-kept-exactly",
      channel: "email",
      recipient: {
        role: "signer",
        name: "Alex Client",
        address: "alex@example.test",
      },
      content: {
        subject: "Proposal Q-2026-1001",
        html: "<p>Your immutable proposal is ready.</p>",
        text: "Your immutable proposal is ready.",
        documentId: "77777777-7777-4777-8777-777777777777",
      },
    };
    const originalEnvelope = encryptQuoteDeliveryProviderPayload({
      payload: originalPayload,
    });
    const recovered = decryptQuoteDeliveryProviderPayload({
      ...originalEnvelope,
      deliveryId: SOURCE_DELIVERY_ID,
      versionId: VERSION_ID,
    });
    const retryEnvelope = encryptQuoteDeliveryProviderPayload({
      payload: { ...recovered, deliveryId: RETRY_DELIVERY_ID },
    });
    const retried = decryptQuoteDeliveryProviderPayload({
      ...retryEnvelope,
      deliveryId: RETRY_DELIVERY_ID,
      versionId: VERSION_ID,
    });

    expect(retried).toEqual({
      ...originalPayload,
      deliveryId: RETRY_DELIVERY_ID,
    });
    expect(() =>
      decryptQuoteDeliveryProviderPayload({
        ...originalEnvelope,
        deliveryId: RETRY_DELIVERY_ID,
        versionId: VERSION_ID,
      }),
    ).toThrow();
  });
});

describe("quote V2 resend route and service boundary", () => {
  it("authenticates and authorizes before reading request data or opening the database", () => {
    const boundary = routeSource.indexOf(
      "const boundary = await beginTeamMutation(request, {",
    );
    const params = routeSource.indexOf("await context.params", boundary);
    const body = routeSource.indexOf(
      "await readBoundedJsonRequest(request",
      params,
    );
    const database = routeSource.indexOf("const db = getDb()", body);

    expect(boundary).toBeGreaterThan(0);
    expect(params).toBeGreaterThan(boundary);
    expect(body).toBeGreaterThan(params);
    expect(database).toBeGreaterThan(body);
    expect(routeSource).toContain('principalTypes: ["human"]');
    expect(routeSource).toContain('requiredPermissions: ["quotes.send"]');
    expect(routeSource).toContain('risk: "external"');
    expect(routeSource).toContain("requiresIdempotency: true");
    expect(routeSource).toContain("rejectDuplicateObjectKeys: true");
    expect(routeSource).toContain("mutation.expectedVersion");
    expect(routeSource).toContain("createQuoteV2SendAttempt(tx, {");
  });

  it("keeps retries version-bound and preserves issued expiry evidence", () => {
    expect(serviceSource).toContain('delivery.status !== "failed"');
    expect(serviceSource).toContain("decryptQuoteDeliveryProviderPayload({");
    expect(serviceSource).toContain("payload: { ...item.payload, deliveryId }");
    expect(serviceSource).toContain(
      "tokenHash: hashQuoteCapabilityToken(payload.capabilityToken)",
    );
    expect(serviceSource).toContain("metadata: { retryOfDeliveryId:");
    expect(serviceSource).toContain("firstSentAt: sql`coalesce(");
    expect(serviceSource).toContain(
      "expiresAt: source.expiresAt.toISOString()",
    );
    expect(serviceSource).not.toMatch(/\.set\(\{[\s\S]{0,200}expiresAt:/u);
  });

  it("allowlists the BFF target with quote-send permission, CAS, and safe replay", () => {
    const target = bffSource.indexOf(
      "`^quote-versions/(${UUID})/send-attempts$`",
    );
    const nextTarget = bffSource.indexOf("match = new RegExp(", target + 1);
    const targetBlock = bffSource.slice(
      target,
      nextTarget > target ? nextTarget : target + 900,
    );

    expect(target).toBeGreaterThan(0);
    expect(targetBlock).toContain(
      "/api/quote-versions/${encodeURIComponent(match[1])}/send-attempts",
    );
    expect(targetBlock).toContain('permission: "quotes.send"');
    expect(targetBlock).toContain("requiresRevision: true");
    expect(targetBlock).toContain("safeReplay: true");
  });
});
