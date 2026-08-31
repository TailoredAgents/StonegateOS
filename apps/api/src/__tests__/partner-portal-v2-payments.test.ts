import { NextRequest } from "next/server";
import { isSecurePartnerPaymentRequest } from "@/lib/partner-portal-v2-payment-security";
import {
  derivePartnerPaymentIntentStatus,
  parsePartnerPaymentAttemptMetadata,
  PartnerEmbeddedPaymentCompletionSchema,
  PartnerInvoicePaymentLinkRequestSchema,
  PartnerPaymentIntentRequestSchema,
  resolvePartnerEmbeddedPaymentAmount,
  resolvePartnerInvoicePaymentAmount,
} from "@/lib/partner-portal-v2-payments";

const INVOICE_ID = "11111111-1111-4111-8111-111111111111";

describe("partner portal V2 hosted payment contracts", () => {
  it("requires invoice binding and rejects raw card or bank payload fields", () => {
    const valid = {
      invoiceId: INVOICE_ID,
      purpose: "one_off",
      paymentMethod: "card",
      amount: { amountMinor: 12_500, currency: "USD", minorUnit: 2 },
    };
    expect(PartnerPaymentIntentRequestSchema.safeParse(valid).success).toBe(
      true,
    );
    expect(
      PartnerPaymentIntentRequestSchema.safeParse({
        ...valid,
        sourceId: "cnon:raw-card-nonce",
      }).success,
    ).toBe(false);
    expect(
      PartnerPaymentIntentRequestSchema.safeParse({
        ...valid,
        card: { number: "4111111111111111" },
      }).success,
    ).toBe(false);
    expect(
      PartnerInvoicePaymentLinkRequestSchema.safeParse({
        ...valid,
        invoiceId: undefined,
        bankAccount: { routingNumber: "secret" },
      }).success,
    ).toBe(false);
    expect(
      PartnerPaymentIntentRequestSchema.safeParse({
        purpose: "one_off",
        paymentMethod: "card",
        amount: valid.amount,
      }).success,
    ).toBe(false);
  });

  it("accepts ACH as a recognized request value so routes can reject it explicitly", () => {
    expect(
      PartnerPaymentIntentRequestSchema.safeParse({
        invoiceId: INVOICE_ID,
        purpose: "deposit",
        paymentMethod: "ach",
        amount: { amountMinor: 5_000, currency: "USD", minorUnit: 2 },
      }).success,
    ).toBe(true);
  });

  it("accepts only a bounded opaque completion token and rejects card fields", () => {
    expect(
      PartnerEmbeddedPaymentCompletionSchema.safeParse({
        sourceToken: "cnon:single-use-square-token",
      }).success,
    ).toBe(true);
    expect(
      PartnerEmbeddedPaymentCompletionSchema.safeParse({
        sourceToken: "cnon:single-use-square-token",
        cardNumber: "4111111111111111",
      }).success,
    ).toBe(false);
    expect(
      PartnerEmbeddedPaymentCompletionSchema.safeParse({
        sourceToken: "short",
      }).success,
    ).toBe(false);
  });

  it("derives authoritative deposit and invoice-bound one-off amounts", () => {
    const invoice = {
      depositCents: 10_000,
      paidCents: 2_500,
      balanceCents: 17_500,
    };
    expect(
      resolvePartnerInvoicePaymentAmount({
        purpose: "deposit",
        requestedAmountMinor: 7_500,
        invoice,
      }),
    ).toEqual({ ok: true, amountMinor: 7_500 });
    expect(
      resolvePartnerInvoicePaymentAmount({
        purpose: "deposit",
        requestedAmountMinor: 7_499,
        invoice,
      }),
    ).toEqual({ ok: false, reason: "invalid_amount" });
    expect(
      resolvePartnerInvoicePaymentAmount({
        purpose: "one_off",
        requestedAmountMinor: 17_500,
        invoice,
      }),
    ).toEqual({ ok: true, amountMinor: 17_500 });
    expect(
      resolvePartnerInvoicePaymentAmount({
        purpose: "one_off",
        requestedAmountMinor: 17_501,
        invoice,
      }),
    ).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("keeps ordinary balances hosted while allowing exact configured prepayments", () => {
    const ordinary = {
      depositCents: 5_000,
      totalCents: 20_000,
      paidCents: 5_000,
      balanceCents: 15_000,
    };
    expect(
      resolvePartnerEmbeddedPaymentAmount({
        purpose: "one_off",
        requestedAmountMinor: 15_000,
        invoice: ordinary,
      }),
    ).toEqual({ ok: false, reason: "hosted_invoice_required" });
    expect(
      resolvePartnerEmbeddedPaymentAmount({
        purpose: "one_off",
        requestedAmountMinor: 20_000,
        invoice: {
          depositCents: 20_000,
          totalCents: 20_000,
          paidCents: 0,
          balanceCents: 20_000,
        },
      }),
    ).toEqual({ ok: true, amountMinor: 20_000 });
  });

  it("never reports success before a completed payment is settled to the invoice", () => {
    const expiresAt = new Date("2026-09-01T00:00:00.000Z");
    const now = new Date("2026-08-30T00:00:00.000Z");
    expect(
      derivePartnerPaymentIntentStatus({
        attemptStatus: "completed",
        expiresAt,
        paymentCanonicalStatus: "completed",
        allocationState: null,
        now,
      }),
    ).toBe("requires_review");
    expect(
      derivePartnerPaymentIntentStatus({
        attemptStatus: "completed",
        expiresAt,
        paymentCanonicalStatus: "completed",
        allocationState: "settled",
        now,
      }),
    ).toBe("succeeded");
    expect(
      derivePartnerPaymentIntentStatus({
        attemptStatus: "launched",
        expiresAt,
        paymentProviderStatus: "PENDING",
        paymentTenderType: "BANK_ACCOUNT",
        now,
      }),
    ).toBe("pending");
  });

  it("parses only bounded, card-hosted attempt metadata", () => {
    const metadata = {
      partnerPortalPayment: {
        schemaVersion: 1,
        partnerAccountId: "22222222-2222-4222-8222-222222222222",
        partnerInvoiceId: INVOICE_ID,
        partnerMembershipId: "33333333-3333-4333-8333-333333333333",
        partnerUserId: "44444444-4444-4444-8444-444444444444",
        purpose: "deposit",
        paymentMethod: "card",
        checkoutMode: "hosted_redirect",
        amountMinor: 5_000,
        currency: "USD",
        minorUnit: 2,
        correlationId: "payment-correlation-0001",
        idempotencyKeyHash: "a".repeat(64),
        providerPaymentLinkId: "link-1",
        checkoutUrl: "https://square.link/u/test",
        providerCreatedAt: "2026-08-30T12:00:00.000Z",
      },
    };
    expect(parsePartnerPaymentAttemptMetadata(metadata)).toMatchObject({
      purpose: "deposit",
      paymentMethod: "card",
      amountMinor: 5_000,
    });
    expect(
      parsePartnerPaymentAttemptMetadata({
        partnerPortalPayment: {
          ...metadata.partnerPortalPayment,
          checkoutUrl: "https://square.link.evil.test/pay",
        },
      }),
    ).toBeNull();
    expect(
      parsePartnerPaymentAttemptMetadata({
        partnerPortalPayment: {
          ...metadata.partnerPortalPayment,
          paymentMethod: "ach",
        },
      }),
    ).toBeNull();
    expect(
      parsePartnerPaymentAttemptMetadata({
        partnerPortalPayment: {
          ...metadata.partnerPortalPayment,
          checkoutMode: "embedded_card",
          providerPaymentLinkId: null,
          checkoutUrl: null,
          providerCreatedAt: null,
          completionIdempotencyKeyHash: "b".repeat(64),
        },
      }),
    ).toMatchObject({
      checkoutMode: "embedded_card",
      completionIdempotencyKeyHash: "b".repeat(64),
      providerPaymentLinkId: null,
      checkoutUrl: null,
    });
  });

  it("requires production HTTPS while allowing only loopback HTTP in tests", () => {
    expect(
      isSecurePartnerPaymentRequest(
        new NextRequest(
          "https://api.example.test/api/portal/v2/payment-intents",
        ),
        "production",
      ),
    ).toBe(true);
    expect(
      isSecurePartnerPaymentRequest(
        new NextRequest(
          "http://api.example.test/api/portal/v2/payment-intents",
        ),
        "production",
      ),
    ).toBe(false);
    expect(
      isSecurePartnerPaymentRequest(
        new NextRequest(
          "http://internal-api:3001/api/portal/v2/payment-intents",
          { headers: { "x-forwarded-proto": "https" } },
        ),
        "production",
      ),
    ).toBe(true);
    expect(
      isSecurePartnerPaymentRequest(
        new NextRequest(
          "https://api.example.test/api/portal/v2/payment-intents",
          { headers: { "x-forwarded-proto": "http" } },
        ),
        "production",
      ),
    ).toBe(false);
    expect(
      isSecurePartnerPaymentRequest(
        new NextRequest("http://127.0.0.1/api/portal/v2/payment-intents"),
        "test",
      ),
    ).toBe(true);
    expect(
      isSecurePartnerPaymentRequest(
        new NextRequest(
          "http://api.example.test/api/portal/v2/payment-intents",
        ),
        "test",
      ),
    ).toBe(false);
  });
});
