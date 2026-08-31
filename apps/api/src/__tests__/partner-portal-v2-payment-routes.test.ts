import fs from "node:fs";
import path from "node:path";

const apiRoot = path.resolve(process.cwd());

function source(relativePath: string): string {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

describe("partner portal V2 payment route guards", () => {
  const createIntent = "app/api/portal/v2/payment-intents/route.ts";
  const getIntent =
    "app/api/portal/v2/payment-intents/[paymentIntentId]/route.ts";
  const completeIntent =
    "app/api/portal/v2/payment-intents/[paymentIntentId]/complete/route.ts";
  const invoiceLink =
    "app/api/portal/v2/invoices/[invoiceId]/payment-link/route.ts";

  it.each([createIntent, getIntent, completeIntent])(
    "requires billing authority, AAL2, embedded rollout eligibility, and HTTPS in %s",
    (relativePath) => {
      const route = source(relativePath);
      expect(route).toContain('"payments.manage"');
      expect(route).toContain('assuranceLevel !== "aal2"');
      expect(route).toContain("arePartnerPortalEmbeddedPaymentsEnabled");
      expect(route).toContain("isSecurePartnerPaymentRequest");
      expect(route).toContain('accessLevel !== "account"');
    },
  );

  it("uses the independent hosted-payment rollout for invoice links", () => {
    const route = source(invoiceLink);
    expect(route).toContain('"payments.manage"');
    expect(route).toContain('assuranceLevel !== "aal2"');
    expect(route).toContain("arePartnerPortalHostedPaymentsEnabled");
    expect(route).toContain("isSecurePartnerPaymentRequest");
  });

  it.each([createIntent, invoiceLink])(
    "requires origin, idempotency, and rate limiting for mutation %s",
    (relativePath) => {
      const route = source(relativePath);
      expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
      expect(route).toContain("readPortalV2IdempotencyKey");
      expect(route).toContain("runPortalV2IdempotentMutation");
      expect(route).toContain('action: "partner_payment_checkout"');
      expect(route).toContain('paymentMethod === "ach"');
    },
  );

  it("requires origin, idempotency, and rate limiting for embedded completion", () => {
    const route = source(completeIntent);
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(route).toContain("readPortalV2IdempotencyKey");
    expect(route).toContain("runPortalV2IdempotentMutation");
    expect(route).toContain('action: "partner_payment_checkout"');
    expect(route).toContain("sourceTokenHash");
    expect(route).toContain("tokenFingerprint");
    expect(route).not.toContain("payload: payload.data");
  });

  it("keeps hosted invoice balances isolated from exact embedded obligations", () => {
    const domain = source("src/lib/partner-portal-v2-payments.ts");
    const hostedProvider = source(
      "src/lib/partner-hosted-checkout-provider.ts",
    );
    const embeddedProvider = source(
      "src/lib/partner-embedded-payment-provider.ts",
    );
    expect(domain).toContain("invoiceId: z.string().uuid()");
    expect(domain).toContain('checkoutMode: "hosted_redirect"');
    expect(domain).toContain('mode: "hosted_redirect" as const');
    expect(domain).toContain("embedded: false");
    expect(domain).toContain('mode: "embedded_card" as const');
    expect(domain).toContain("hosted_invoice_required");
    expect(hostedProvider).not.toContain("source_id");
    expect(embeddedProvider).toContain("source_id: sourceToken");
    expect(embeddedProvider).toContain("autocomplete: true");
    expect(embeddedProvider).toContain("squareAttemptNote");
  });

  it("allocates only verified Square payments through reconciliation", () => {
    const squarePayments = source("src/lib/square-payments.ts");
    const domain = source("src/lib/partner-portal-v2-payments.ts");
    const webhook = source("app/api/webhooks/square/route.ts");
    expect(squarePayments).toContain(
      "finalize: finalizePartnerPortalPaymentReconciliation",
    );
    expect(domain).toContain('result.status !== "verified"');
    expect(domain).toContain('state: "settled"');
    expect(domain).toContain("invoice_payment_binding_mismatch");
    expect(webhook).toContain("verifySquareWebhookSignature");
    expect(webhook).toContain("reserveSquareProviderEvent");
  });

  it("keeps the hosted rollout behind the global financial kill switch", () => {
    const flags = source("src/lib/partner-portal-feature-flags.ts");
    const rateLimits = source("src/lib/team-auth-rate-limit.ts");
    expect(flags).toContain('getTeamOperationKillSwitch(["payments.manage"])');
    expect(rateLimits).toContain("partner_payment_checkout");
    expect(rateLimits).toContain(
      "identity: { limit: 12, windowMs: 60 * 60 * 1_000 }",
    );
  });
});
