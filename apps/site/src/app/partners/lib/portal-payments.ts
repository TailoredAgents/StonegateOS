import type { PartnerMoney } from "./portal-v2";

const PORTAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const TRUSTED_SQUARE_CHECKOUT_HOSTS = [
  "square.link",
  "square.site",
  "squareup.com",
] as const;

export const SQUARE_WEB_PAYMENTS_SDK_URLS = [
  "https://sandbox.web.squarecdn.com/v1/square.js",
  "https://web.squarecdn.com/v1/square.js",
] as const;

export type PartnerPaymentIntentStatus =
  | "provisioning"
  | "ready"
  | "pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "requires_review";

export type PartnerHostedPaymentIntent = {
  id: string;
  invoiceId: string;
  purpose: "deposit" | "one_off";
  paymentMethod: "card";
  status: PartnerPaymentIntentStatus;
  amount: PartnerMoney;
  checkout: {
    mode: "hosted_redirect";
    url: string | null;
    embedded: false;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type PartnerEmbeddedPaymentIntent = {
  id: string;
  invoiceId: string;
  purpose: "deposit" | "one_off";
  paymentMethod: "card";
  status: PartnerPaymentIntentStatus;
  amount: PartnerMoney;
  checkout: {
    mode: "embedded_card";
    url: null;
    embedded: true;
  };
  webPayments: {
    applicationId: string;
    locationId: string;
    environment: "sandbox" | "production";
    sdkUrl: (typeof SQUARE_WEB_PAYMENTS_SDK_URLS)[number];
    methods: { card: true; ach: false };
    achUnavailableReason: "merchant_and_return_configuration_required";
  };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type PartnerPaymentIntent =
  | PartnerHostedPaymentIntent
  | PartnerEmbeddedPaymentIntent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRfc3339Instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function isPartnerMoney(value: unknown): value is PartnerMoney {
  if (!isRecord(value)) return false;
  return (
    typeof value["amountMinor"] === "number" &&
    Number.isSafeInteger(value["amountMinor"]) &&
    value["amountMinor"] > 0 &&
    value["currency"] === "USD" &&
    value["minorUnit"] === 2
  );
}

function isSafeProviderIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  );
}

export function isSquareWebPaymentsSdkUrl(
  value: unknown,
): value is (typeof SQUARE_WEB_PAYMENTS_SDK_URLS)[number] {
  return (
    typeof value === "string" &&
    SQUARE_WEB_PAYMENTS_SDK_URLS.includes(
      value as (typeof SQUARE_WEB_PAYMENTS_SDK_URLS)[number],
    )
  );
}

export function isPartnerPaymentIntentId(value: unknown): value is string {
  return typeof value === "string" && PORTAL_UUID_PATTERN.test(value);
}

/**
 * Mirrors the API checkout allow-list. A provider URL is never navigated to
 * unless it is HTTPS, credential-free, fragment-free, and hosted by Square.
 */
export function isSafeSquareHostedCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return false;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const trusted = TRUSTED_SQUARE_CHECKOUT_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
    return (
      url.protocol === "https:" &&
      trusted &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function isPartnerHostedPaymentIntent(
  value: unknown,
): value is PartnerHostedPaymentIntent {
  if (!isRecord(value)) return false;
  const checkout = value["checkout"];
  const status = value["status"];
  if (!isRecord(checkout)) return false;
  return (
    isPartnerPaymentIntentId(value["id"]) &&
    isPartnerPaymentIntentId(value["invoiceId"]) &&
    (value["purpose"] === "deposit" || value["purpose"] === "one_off") &&
    value["paymentMethod"] === "card" &&
    [
      "provisioning",
      "ready",
      "pending",
      "succeeded",
      "failed",
      "canceled",
      "expired",
      "requires_review",
    ].includes(typeof status === "string" ? status : "") &&
    isPartnerMoney(value["amount"]) &&
    checkout["mode"] === "hosted_redirect" &&
    checkout["embedded"] === false &&
    (checkout["url"] === null ||
      isSafeSquareHostedCheckoutUrl(checkout["url"])) &&
    isRfc3339Instant(value["createdAt"]) &&
    isRfc3339Instant(value["updatedAt"]) &&
    isRfc3339Instant(value["expiresAt"])
  );
}

export function isPartnerEmbeddedPaymentIntent(
  value: unknown,
): value is PartnerEmbeddedPaymentIntent {
  if (!isRecord(value)) return false;
  const checkout = value["checkout"];
  const config = value["webPayments"];
  const status = value["status"];
  if (!isRecord(checkout) || !isRecord(config)) return false;
  const methods = config["methods"];
  const environment = config["environment"];
  const sdkUrl = config["sdkUrl"];
  if (!isRecord(methods)) return false;
  const environmentMatchesSdk =
    (environment === "sandbox" &&
      sdkUrl === "https://sandbox.web.squarecdn.com/v1/square.js") ||
    (environment === "production" &&
      sdkUrl === "https://web.squarecdn.com/v1/square.js");
  return (
    isPartnerPaymentIntentId(value["id"]) &&
    isPartnerPaymentIntentId(value["invoiceId"]) &&
    (value["purpose"] === "deposit" || value["purpose"] === "one_off") &&
    value["paymentMethod"] === "card" &&
    [
      "provisioning",
      "ready",
      "pending",
      "succeeded",
      "failed",
      "canceled",
      "expired",
      "requires_review",
    ].includes(typeof status === "string" ? status : "") &&
    isPartnerMoney(value["amount"]) &&
    checkout["mode"] === "embedded_card" &&
    checkout["embedded"] === true &&
    checkout["url"] === null &&
    isSafeProviderIdentifier(config["applicationId"]) &&
    isSafeProviderIdentifier(config["locationId"]) &&
    isSquareWebPaymentsSdkUrl(sdkUrl) &&
    environmentMatchesSdk &&
    methods["card"] === true &&
    methods["ach"] === false &&
    config["achUnavailableReason"] ===
      "merchant_and_return_configuration_required" &&
    isRfc3339Instant(value["createdAt"]) &&
    isRfc3339Instant(value["updatedAt"]) &&
    isRfc3339Instant(value["expiresAt"])
  );
}

export function isPartnerPaymentIntent(
  value: unknown,
): value is PartnerPaymentIntent {
  return (
    isPartnerHostedPaymentIntent(value) || isPartnerEmbeddedPaymentIntent(value)
  );
}

export function isInvoiceEligibleForHostedCardPayment(input: {
  status: string;
  balance: PartnerMoney;
}): boolean {
  return (
    ["issued", "partially_paid", "overdue"].includes(input.status) &&
    input.balance.currency === "USD" &&
    input.balance.minorUnit === 2 &&
    Number.isSafeInteger(input.balance.amountMinor) &&
    input.balance.amountMinor > 0
  );
}

export function resolveEmbeddedDepositAmount(input: {
  status: string;
  deposit: PartnerMoney;
  paid: PartnerMoney;
  balance: PartnerMoney;
}): PartnerMoney | null {
  const values = [input.deposit, input.paid, input.balance];
  if (
    !["issued", "partially_paid", "overdue"].includes(input.status) ||
    values.some(
      (money) =>
        money.currency !== "USD" ||
        money.minorUnit !== 2 ||
        !Number.isSafeInteger(money.amountMinor) ||
        money.amountMinor < 0,
    )
  ) {
    return null;
  }
  const amountMinor = Math.min(
    input.balance.amountMinor,
    Math.max(input.deposit.amountMinor - input.paid.amountMinor, 0),
  );
  return amountMinor > 0
    ? { amountMinor, currency: "USD", minorUnit: 2 }
    : null;
}

export function squareVerificationAmount(amount: PartnerMoney): string | null {
  if (
    amount.currency !== "USD" ||
    amount.minorUnit !== 2 ||
    !Number.isSafeInteger(amount.amountMinor) ||
    amount.amountMinor <= 0
  ) {
    return null;
  }
  return (amount.amountMinor / 100).toFixed(2);
}
