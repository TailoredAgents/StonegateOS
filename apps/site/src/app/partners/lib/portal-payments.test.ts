import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isInvoiceEligibleForHostedCardPayment,
  isPartnerEmbeddedPaymentIntent,
  isPartnerHostedPaymentIntent,
  isSafeSquareHostedCheckoutUrl,
  isSquareWebPaymentsSdkUrl,
  resolveEmbeddedDepositAmount,
  squareVerificationAmount,
} from "./portal-payments";

const PAYMENT_INTENT_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";

function readyIntent() {
  return {
    id: PAYMENT_INTENT_ID,
    invoiceId: INVOICE_ID,
    purpose: "one_off",
    paymentMethod: "card",
    status: "ready",
    amount: { amountMinor: 12_500, currency: "USD", minorUnit: 2 },
    checkout: {
      mode: "hosted_redirect",
      url: "https://square.link/u/checkout",
      embedded: false,
    },
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:01.000Z",
    expiresAt: "2026-09-30T12:00:00.000Z",
  };
}

void test("accepts only HTTPS Square hosted-checkout destinations", () => {
  assert.equal(
    isSafeSquareHostedCheckoutUrl("https://sandbox.square.link/u/checkout"),
    true,
  );
  assert.equal(
    isSafeSquareHostedCheckoutUrl("https://checkout.squareup.com/pay"),
    true,
  );
  assert.equal(
    isSafeSquareHostedCheckoutUrl("https://square.link.evil.test/pay"),
    false,
  );
  assert.equal(
    isSafeSquareHostedCheckoutUrl("http://square.link/u/checkout"),
    false,
  );
  assert.equal(
    isSafeSquareHostedCheckoutUrl("https://user@square.link/u/checkout"),
    false,
  );
  assert.equal(
    isSafeSquareHostedCheckoutUrl("https://square.link/u/checkout#return"),
    false,
  );
});

void test("accepts only card-hosted, non-embedded payment intent DTOs", () => {
  const valid = readyIntent();
  assert.equal(isPartnerHostedPaymentIntent(valid), true);
  assert.equal(
    isPartnerHostedPaymentIntent({
      ...valid,
      paymentMethod: "ach",
    }),
    false,
  );
  assert.equal(
    isPartnerHostedPaymentIntent({
      ...valid,
      checkout: { ...valid.checkout, embedded: true },
    }),
    false,
  );
  assert.equal(
    isPartnerHostedPaymentIntent({
      ...valid,
      checkout: {
        ...valid.checkout,
        url: "https://square.link.evil.test/pay",
      },
    }),
    false,
  );
});

void test("offers hosted card payment only for payable USD invoice balances", () => {
  assert.equal(
    isInvoiceEligibleForHostedCardPayment({
      status: "overdue",
      balance: { amountMinor: 12_500, currency: "USD", minorUnit: 2 },
    }),
    true,
  );
  assert.equal(
    isInvoiceEligibleForHostedCardPayment({
      status: "paid",
      balance: { amountMinor: 12_500, currency: "USD", minorUnit: 2 },
    }),
    false,
  );
  assert.equal(
    isInvoiceEligibleForHostedCardPayment({
      status: "issued",
      balance: { amountMinor: 0, currency: "USD", minorUnit: 2 },
    }),
    false,
  );
});

void test("accepts only exact Square SDK configuration for embedded card intents", () => {
  const embedded = {
    ...readyIntent(),
    purpose: "deposit",
    checkout: { mode: "embedded_card", url: null, embedded: true },
    webPayments: {
      applicationId: "sandbox-sq0idb-example",
      locationId: "LOCATION-1",
      environment: "sandbox",
      sdkUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
      methods: { card: true, ach: false },
      achUnavailableReason: "merchant_and_return_configuration_required",
    },
  };
  assert.equal(isPartnerEmbeddedPaymentIntent(embedded), true);
  assert.equal(
    isPartnerEmbeddedPaymentIntent({
      ...embedded,
      webPayments: {
        ...embedded.webPayments,
        sdkUrl: "https://web.squarecdn.com.evil.test/v1/square.js",
      },
    }),
    false,
  );
  assert.equal(
    isPartnerEmbeddedPaymentIntent({
      ...embedded,
      webPayments: {
        ...embedded.webPayments,
        methods: { card: true, ach: true },
      },
    }),
    false,
  );
  assert.equal(
    isSquareWebPaymentsSdkUrl("https://web.squarecdn.com/v1/square.js"),
    true,
  );
});

void test("derives the exact outstanding deposit and Square verification amount", () => {
  const amount = resolveEmbeddedDepositAmount({
    status: "partially_paid",
    deposit: { amountMinor: 10_000, currency: "USD", minorUnit: 2 },
    paid: { amountMinor: 2_500, currency: "USD", minorUnit: 2 },
    balance: { amountMinor: 17_500, currency: "USD", minorUnit: 2 },
  });
  assert.deepEqual(amount, {
    amountMinor: 7_500,
    currency: "USD",
    minorUnit: 2,
  });
  assert.equal(amount ? squareVerificationAmount(amount) : null, "75.00");
  assert.equal(
    resolveEmbeddedDepositAmount({
      status: "issued",
      deposit: { amountMinor: 0, currency: "USD", minorUnit: 2 },
      paid: { amountMinor: 0, currency: "USD", minorUnit: 2 },
      balance: { amountMinor: 10_000, currency: "USD", minorUnit: 2 },
    }),
    null,
  );
});

void test("payment UI keeps creation idempotent and card-hosted", () => {
  const component = readFileSync(
    new URL("../components/PartnerInvoicePayment.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /"Idempotency-Key": operationKey\.current/u);
  assert.match(component, /paymentMethod: "card"/u);
  assert.doesNotMatch(component, /paymentMethod: "ach"/u);
  assert.match(component, /Square’s secure hosted checkout/u);
  assert.match(component, /invoice reconciliation/u);
  assert.match(component, /currentCard\.tokenize/u);
  assert.match(component, /intent: "CHARGE"/u);
  assert.match(component, /sellerKeyedIn: false/u);
  assert.match(component, /ACH is not enabled/u);
  assert.doesNotMatch(component, /localStorage/u);
});

void test("billing route carries Square's official CSP origins", () => {
  const config = readFileSync(
    new URL("../../../../next.config.mjs", import.meta.url),
    "utf8",
  );
  assert.match(config, /https:\/\/web\.squarecdn\.com/u);
  assert.match(config, /https:\/\/sandbox\.web\.squarecdn\.com/u);
  assert.match(config, /https:\/\/pci-connect\.squareup\.com/u);
  assert.match(config, /https:\/\/pci-connect\.squareupsandbox\.com/u);
  assert.match(config, /source: "\/partners\/billing"/u);
});

void test("portal proxy derives payment protocol without relaying a forwarding header", () => {
  const proxy = readFileSync(
    new URL(
      "../../api/partners/portal/[...segments]/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(proxy, /request\.nextUrl\.protocol === "https:"/u);
  assert.match(proxy, /requestHeaders\.set\(\s*"X-Forwarded-Proto"/u);
  assert.doesNotMatch(
    proxy,
    /request\.headers\.get\(["']x-forwarded-proto["']\)/iu,
  );
});
