import crypto from "node:crypto";
import {
  resolveSquareApiEndpoint,
  type SquareProviderEnvironment,
} from "@myst-os/sdk";
import {
  getSquareOrder,
  getSquarePayment,
  parseSquareMoneyAmount,
  SQUARE_API_VERSION,
  SquareApiError,
} from "@/lib/square-client";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const DEFAULT_RETURN_STATE_TTL_SECONDS = 60 * 60;
const MIN_RETURN_STATE_TTL_SECONDS = 5 * 60;
const MAX_RETURN_STATE_TTL_SECONDS = 24 * 60 * 60;

type FetchImplementation = typeof fetch;
type CheckoutMoney = Readonly<{
  amount?: number | string;
  currency?: string;
}>;

export type QuoteCheckoutRequestFacts = Readonly<{
  purpose: "quote_deposit";
  currency: "USD";
  expectedAmountCents: number;
  squareLocationId: string;
  idempotencyKeyHash: string;
  returnStateHash: string;
  returnStateExpiresAt: string;
  tippingAllowed: false;
  couponsEnabled: false;
  loyaltyEnabled: false;
  shippingAddressRequested: false;
  buyerEmailPrefilled: boolean;
  buyerPhonePrefilled: boolean;
}>;

export type CreatedQuoteDepositCheckout = Readonly<{
  checkoutUrl: string;
  providerPaymentLinkId: string;
  providerOrderId: string;
  providerVersion: number | null;
  providerCreatedAt: string | null;
  requestFacts: QuoteCheckoutRequestFacts;
}>;

export type QuoteDepositCheckoutStatus =
  | "pending"
  | "declined"
  | "captured"
  | "late_capture"
  | "refund_review";

export type QuoteDepositCheckoutOutcome = Readonly<{
  status: QuoteDepositCheckoutStatus;
  reason:
    | "payment_not_created"
    | "payment_not_visible"
    | "payment_pending"
    | "payment_failed"
    | "payment_canceled"
    | "order_canceled"
    | "verified_capture"
    | "hold_expired_before_capture"
    | "ambiguous_payment_reference"
    | "provider_reference_mismatch"
    | "location_mismatch"
    | "currency_mismatch"
    | "amount_mismatch"
    | "unexpected_tip"
    | "order_state_mismatch"
    | "refund_detected"
    | "unknown_payment_status";
  providerOrderId: string;
  providerPaymentId: string | null;
  providerPaymentStatus: string | null;
  expectedAmountCents: number;
  capturedAmountCents: number | null;
  refundedAmountCents: number;
  currency: "USD";
  capturedAt: string | null;
  receiptUrl: string | null;
  requiresSchedulingConfirmation: boolean;
  requiresRefundReview: boolean;
}>;

export class QuoteSquareCheckoutError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QuoteSquareCheckoutError";
  }
}

type ReturnState = Readonly<{
  value: string;
  hash: string;
  expiresAt: Date;
}>;

type VerifyReturnStateResult =
  | Readonly<{ valid: true; hash: string; expiresAt: Date }>
  | Readonly<{
      valid: false;
      reason: "malformed" | "signature_mismatch" | "state_mismatch" | "expired";
    }>;

type CreateQuoteDepositPaymentLinkInput = Readonly<{
  amountCents: number;
  locationId: string;
  idempotencyKey: string;
  displayName?: string;
  buyer?: Readonly<{
    email?: string | null;
    phoneNumber?: string | null;
  }>;
  returnUrl: string;
  returnStateSecret: string;
  returnStateTtlSeconds?: number;
  accessToken?: string;
  environment?: SquareProviderEnvironment;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  now?: Date;
  randomBytesImpl?: (size: number) => Uint8Array;
}>;

type RetrieveQuoteDepositCheckoutInput = Readonly<{
  providerOrderId: string;
  expectedAmountCents: number;
  expectedLocationId: string;
  holdExpiresAt?: Date | null;
  accessToken?: string;
  environment?: SquareProviderEnvironment;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  now?: Date;
}>;

type VerifyBrowserReturnInput = RetrieveQuoteDepositCheckoutInput &
  Readonly<{
    browserReturnUrl: string;
    returnStateSecret: string;
    expectedReturnStateHash: string;
  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: string,
  label: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  const containsControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    normalized.length < 1 ||
    normalized.length > maximumLength ||
    containsControlCharacter
  ) {
    throw new QuoteSquareCheckoutError(`${label}_invalid`);
  }
  return normalized;
}

function positiveCents(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
    throw new QuoteSquareCheckoutError("deposit_amount_invalid");
  }
  return value;
}

function validDate(value: Date, code: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new QuoteSquareCheckoutError(code);
  }
  return value;
}

function normalizeStateSecret(secret: string): string {
  if (Buffer.byteLength(secret, "utf8") < 32 || secret.length > 4_096) {
    throw new QuoteSquareCheckoutError("return_state_secret_invalid");
  }
  return secret;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createQuoteCheckoutReturnState(input: {
  secret: string;
  now?: Date;
  ttlSeconds?: number;
  randomBytesImpl?: (size: number) => Uint8Array;
}): ReturnState {
  const secret = normalizeStateSecret(input.secret);
  const now = validDate(input.now ?? new Date(), "return_state_time_invalid");
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_RETURN_STATE_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < MIN_RETURN_STATE_TTL_SECONDS ||
    ttlSeconds > MAX_RETURN_STATE_TTL_SECONDS
  ) {
    throw new QuoteSquareCheckoutError("return_state_ttl_invalid");
  }
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
  const randomBytes = input.randomBytesImpl ?? crypto.randomBytes;
  const nonceBytes = Buffer.from(randomBytes(32));
  if (nonceBytes.byteLength !== 32) {
    throw new QuoteSquareCheckoutError("return_state_entropy_invalid");
  }
  const unsigned = `qcs1.${expiresAtSeconds}.${nonceBytes.toString("base64url")}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned, "utf8")
    .digest("base64url");
  const value = `${unsigned}.${signature}`;
  return { value, hash: sha256(value), expiresAt };
}

export function verifyQuoteCheckoutReturnState(input: {
  state: string;
  secret: string;
  expectedHash: string;
  now?: Date;
}): VerifyReturnStateResult {
  const secret = normalizeStateSecret(input.secret);
  const now = validDate(input.now ?? new Date(), "return_state_time_invalid");
  const expectedHash = input.expectedHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
    throw new QuoteSquareCheckoutError("return_state_hash_invalid");
  }
  if (input.state.length > 512) return { valid: false, reason: "malformed" };
  const match =
    /^qcs1\.(\d{10})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(
      input.state,
    );
  if (!match) return { valid: false, reason: "malformed" };

  const actualHash = sha256(input.state);
  if (
    !safeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"))
  ) {
    return { valid: false, reason: "state_mismatch" };
  }

  const unsigned = input.state.slice(0, input.state.lastIndexOf("."));
  const suppliedSignature = Buffer.from(match[3]!, "base64url");
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(unsigned, "utf8")
    .digest();
  if (!safeEqual(suppliedSignature, expectedSignature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const expiresAt = new Date(Number(match[1]) * 1_000);
  if (!Number.isFinite(expiresAt.getTime())) {
    return { valid: false, reason: "malformed" };
  }
  if (now.getTime() > expiresAt.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, hash: actualHash, expiresAt };
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  const email = boundedString(value, "buyer_email", 256).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new QuoteSquareCheckoutError("buyer_email_invalid");
  }
  return email;
}

function normalizePhone(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  const phone = boundedString(value, "buyer_phone", 17);
  if (!/^\+[1-9]\d{7,14}$/u.test(phone)) {
    throw new QuoteSquareCheckoutError("buyer_phone_invalid");
  }
  return phone;
}

function buildRedirectUrl(baseUrl: string, state: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new QuoteSquareCheckoutError("return_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.has("state")
  ) {
    throw new QuoteSquareCheckoutError("return_url_invalid");
  }
  url.searchParams.set("state", state);
  if (url.toString().length > 2_048) {
    throw new QuoteSquareCheckoutError("return_url_too_long");
  }
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new QuoteSquareCheckoutError("square_response_too_large");
  }
  if (!response.body) {
    throw new QuoteSquareCheckoutError("square_empty_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new QuoteSquareCheckoutError("square_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new QuoteSquareCheckoutError("square_empty_response");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new QuoteSquareCheckoutError("square_malformed_response");
  }
}

function responseString(
  value: unknown,
  code: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new QuoteSquareCheckoutError(code);
  }
  return boundedString(value, code, maximumLength);
}

function providerCheckoutUrl(value: unknown): string {
  const raw = responseString(value, "square_checkout_url_invalid", 255);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new QuoteSquareCheckoutError("square_checkout_url_invalid");
  }
  const hostname = url.hostname.toLowerCase();
  const trustedHostname =
    hostname === "square.link" ||
    hostname.endsWith(".square.link") ||
    hostname === "square.site" ||
    hostname.endsWith(".square.site");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !trustedHostname
  ) {
    throw new QuoteSquareCheckoutError("square_checkout_url_invalid");
  }
  return url.toString();
}

function parseCreatedPaymentLink(value: unknown): {
  paymentLinkId: string;
  orderId: string;
  checkoutUrl: string;
  version: number | null;
  createdAt: string | null;
} {
  if (!isRecord(value) || !isRecord(value["payment_link"])) {
    throw new QuoteSquareCheckoutError("square_payment_link_invalid_response");
  }
  const paymentLink = value["payment_link"];
  const paymentLinkId = responseString(
    paymentLink["id"],
    "square_payment_link_id_invalid",
    255,
  );
  const orderId = responseString(
    paymentLink["order_id"],
    "square_order_id_invalid",
    192,
  );
  const checkoutUrl = providerCheckoutUrl(paymentLink["url"]);
  const rawVersion = paymentLink["version"];
  const version =
    rawVersion === undefined
      ? null
      : typeof rawVersion === "number" &&
          Number.isSafeInteger(rawVersion) &&
          rawVersion >= 1 &&
          rawVersion <= 65_535
        ? rawVersion
        : null;
  if (rawVersion !== undefined && version === null) {
    throw new QuoteSquareCheckoutError("square_payment_link_version_invalid");
  }
  const rawCreatedAt = paymentLink["created_at"];
  let createdAt: string | null = null;
  if (rawCreatedAt !== undefined) {
    const supplied = responseString(
      rawCreatedAt,
      "square_payment_link_created_at_invalid",
      64,
    );
    const parsed = new Date(supplied);
    if (!Number.isFinite(parsed.getTime())) {
      throw new QuoteSquareCheckoutError(
        "square_payment_link_created_at_invalid",
      );
    }
    createdAt = parsed.toISOString();
  }
  return { paymentLinkId, orderId, checkoutUrl, version, createdAt };
}

export async function createQuoteDepositPaymentLink(
  input: CreateQuoteDepositPaymentLinkInput,
): Promise<CreatedQuoteDepositCheckout> {
  const amountCents = positiveCents(input.amountCents);
  const locationId = boundedString(input.locationId, "location_id", 255);
  const idempotencyKey = boundedString(
    input.idempotencyKey,
    "idempotency_key",
    192,
  );
  const displayName = boundedString(
    input.displayName ?? "Quote deposit",
    "display_name",
    255,
  );
  const now = validDate(input.now ?? new Date(), "checkout_time_invalid");
  const email = normalizeEmail(input.buyer?.email);
  const phoneNumber = normalizePhone(input.buyer?.phoneNumber);
  const returnState = createQuoteCheckoutReturnState({
    secret: input.returnStateSecret,
    now,
    ttlSeconds: input.returnStateTtlSeconds,
    randomBytesImpl: input.randomBytesImpl,
  });
  const redirectUrl = buildRedirectUrl(input.returnUrl, returnState.value);
  const body = {
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: displayName,
      price_money: { amount: amountCents, currency: "USD" },
      location_id: locationId,
    },
    checkout_options: {
      allow_tipping: false,
      redirect_url: redirectUrl,
      ask_for_shipping_address: false,
      enable_coupon: false,
      enable_loyalty: false,
    },
    ...((email || phoneNumber) && {
      pre_populated_data: {
        ...(email ? { buyer_email: email } : {}),
        ...(phoneNumber ? { buyer_phone_number: phoneNumber } : {}),
      },
    }),
  } as const;

  const accessToken =
    input.accessToken?.trim() ?? process.env["SQUARE_ACCESS_TOKEN"]?.trim();
  if (!accessToken) {
    throw new QuoteSquareCheckoutError("square_access_token_missing");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    throw new QuoteSquareCheckoutError("square_timeout_invalid");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    resolveSquareApiEndpoint(
      { kind: "paymentLinks" },
      input.environment ?? process.env,
    ),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": SQUARE_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new SquareApiError(
      `Square request failed (${response.status})`,
      response.status,
    );
  }
  const created = parseCreatedPaymentLink(await readBoundedJson(response));
  return {
    checkoutUrl: created.checkoutUrl,
    providerPaymentLinkId: created.paymentLinkId,
    providerOrderId: created.orderId,
    providerVersion: created.version,
    providerCreatedAt: created.createdAt,
    requestFacts: {
      purpose: "quote_deposit",
      currency: "USD",
      expectedAmountCents: amountCents,
      squareLocationId: locationId,
      idempotencyKeyHash: sha256(idempotencyKey),
      returnStateHash: returnState.hash,
      returnStateExpiresAt: returnState.expiresAt.toISOString(),
      tippingAllowed: false,
      couponsEnabled: false,
      loyaltyEnabled: false,
      shippingAddressRequested: false,
      buyerEmailPrefilled: email !== null,
      buyerPhonePrefilled: phoneNumber !== null,
    },
  };
}

function moneyMatches(
  money: CheckoutMoney | undefined,
  expectedAmountCents: number,
): boolean {
  return (
    parseSquareMoneyAmount(money) === expectedAmountCents &&
    money?.currency?.toUpperCase() === "USD"
  );
}

function zeroMoney(money: CheckoutMoney | undefined): boolean {
  return (
    money === undefined ||
    (parseSquareMoneyAmount(money) === 0 &&
      money.currency?.toUpperCase() === "USD")
  );
}

function outcome(input: {
  status: QuoteDepositCheckoutStatus;
  reason: QuoteDepositCheckoutOutcome["reason"];
  providerOrderId: string;
  providerPaymentId?: string | null;
  providerPaymentStatus?: string | null;
  expectedAmountCents: number;
  capturedAmountCents?: number | null;
  refundedAmountCents?: number;
  capturedAt?: string | null;
  receiptUrl?: string | null;
}): QuoteDepositCheckoutOutcome {
  return {
    status: input.status,
    reason: input.reason,
    providerOrderId: input.providerOrderId,
    providerPaymentId: input.providerPaymentId ?? null,
    providerPaymentStatus: input.providerPaymentStatus ?? null,
    expectedAmountCents: input.expectedAmountCents,
    capturedAmountCents: input.capturedAmountCents ?? null,
    refundedAmountCents: input.refundedAmountCents ?? 0,
    currency: "USD",
    capturedAt: input.capturedAt ?? null,
    receiptUrl: input.receiptUrl ?? null,
    requiresSchedulingConfirmation: input.status === "late_capture",
    requiresRefundReview:
      input.status === "late_capture" || input.status === "refund_review",
  };
}

function refundReview(
  input: RetrieveQuoteDepositCheckoutInput,
  reason: QuoteDepositCheckoutOutcome["reason"],
  providerPaymentId?: string | null,
  providerPaymentStatus?: string | null,
  capturedAmountCents?: number | null,
  refundedAmountCents?: number,
): QuoteDepositCheckoutOutcome {
  return outcome({
    status: "refund_review",
    reason,
    providerOrderId: input.providerOrderId,
    providerPaymentId,
    providerPaymentStatus,
    expectedAmountCents: input.expectedAmountCents,
    capturedAmountCents,
    refundedAmountCents,
  });
}

export async function retrieveQuoteDepositCheckoutOutcome(
  input: RetrieveQuoteDepositCheckoutInput,
): Promise<QuoteDepositCheckoutOutcome> {
  const providerOrderId = boundedString(
    input.providerOrderId,
    "provider_order_id",
    192,
  );
  const expectedAmountCents = positiveCents(input.expectedAmountCents);
  const expectedLocationId = boundedString(
    input.expectedLocationId,
    "expected_location_id",
    255,
  );
  const now = validDate(input.now ?? new Date(), "checkout_time_invalid");
  const holdExpiresAt = input.holdExpiresAt
    ? validDate(input.holdExpiresAt, "hold_expiry_invalid")
    : null;
  const providerOptions = {
    accessToken: input.accessToken,
    environment: input.environment,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  };
  const order = await getSquareOrder(providerOrderId, providerOptions);
  const orderStatus = order.state?.trim().toUpperCase() ?? "";
  if (order.location_id !== expectedLocationId) {
    return refundReview(input, "location_mismatch");
  }
  if (order.total_money?.currency?.toUpperCase() !== "USD") {
    return refundReview(input, "currency_mismatch");
  }
  if (!moneyMatches(order.total_money, expectedAmountCents)) {
    return refundReview(input, "amount_mismatch");
  }
  if (!zeroMoney(order.total_tip_money)) {
    return refundReview(input, "unexpected_tip");
  }

  const tenderPaymentIds = [
    ...new Set(
      (order.tenders ?? [])
        .map((tender) => tender.payment_id?.trim() || tender.id?.trim() || null)
        .filter((value): value is string => value !== null),
    ),
  ];
  if (tenderPaymentIds.length > 1) {
    return refundReview(input, "ambiguous_payment_reference");
  }
  if (tenderPaymentIds.length === 0) {
    return outcome({
      status: orderStatus === "CANCELED" ? "declined" : "pending",
      reason:
        orderStatus === "CANCELED" ? "order_canceled" : "payment_not_created",
      providerOrderId,
      expectedAmountCents,
    });
  }

  const providerPaymentId = tenderPaymentIds[0]!;
  let payment;
  try {
    payment = await getSquarePayment(providerPaymentId, providerOptions);
  } catch (error) {
    if (error instanceof SquareApiError && error.status === 404) {
      return outcome({
        status: "pending",
        reason: "payment_not_visible",
        providerOrderId,
        providerPaymentId,
        expectedAmountCents,
      });
    }
    throw error;
  }
  const providerPaymentStatus = payment.status?.trim().toUpperCase() ?? "";
  if (
    payment.order_id !== providerOrderId ||
    !order.tenders?.some(
      (tender) =>
        (tender.payment_id === providerPaymentId ||
          tender.id === providerPaymentId) &&
        moneyMatches(tender.amount_money, expectedAmountCents),
    )
  ) {
    return refundReview(
      input,
      "provider_reference_mismatch",
      providerPaymentId,
      providerPaymentStatus,
    );
  }
  if (payment.location_id !== expectedLocationId) {
    return refundReview(
      input,
      "location_mismatch",
      providerPaymentId,
      providerPaymentStatus,
    );
  }
  if (
    payment.amount_money?.currency?.toUpperCase() !== "USD" ||
    payment.total_money?.currency?.toUpperCase() !== "USD"
  ) {
    return refundReview(
      input,
      "currency_mismatch",
      providerPaymentId,
      providerPaymentStatus,
    );
  }
  if (
    !moneyMatches(payment.amount_money, expectedAmountCents) ||
    !moneyMatches(payment.total_money, expectedAmountCents)
  ) {
    return refundReview(
      input,
      "amount_mismatch",
      providerPaymentId,
      providerPaymentStatus,
      parseSquareMoneyAmount(payment.total_money),
    );
  }
  if (!zeroMoney(payment.tip_money)) {
    return refundReview(
      input,
      "unexpected_tip",
      providerPaymentId,
      providerPaymentStatus,
      parseSquareMoneyAmount(payment.total_money),
    );
  }

  const refundedAmountCents =
    parseSquareMoneyAmount(payment.refunded_money) ?? 0;
  if (
    refundedAmountCents < 0 ||
    refundedAmountCents > expectedAmountCents ||
    (payment.refunded_money !== undefined &&
      payment.refunded_money.currency?.toUpperCase() !== "USD")
  ) {
    return refundReview(
      input,
      "currency_mismatch",
      providerPaymentId,
      providerPaymentStatus,
      expectedAmountCents,
      Math.max(refundedAmountCents, 0),
    );
  }
  if (providerPaymentStatus === "FAILED") {
    return outcome({
      status: "declined",
      reason: "payment_failed",
      providerOrderId,
      providerPaymentId,
      providerPaymentStatus,
      expectedAmountCents,
    });
  }
  if (providerPaymentStatus === "CANCELED") {
    return outcome({
      status: "declined",
      reason: "payment_canceled",
      providerOrderId,
      providerPaymentId,
      providerPaymentStatus,
      expectedAmountCents,
    });
  }
  if (
    providerPaymentStatus === "APPROVED" ||
    providerPaymentStatus === "PENDING"
  ) {
    return outcome({
      status: "pending",
      reason: "payment_pending",
      providerOrderId,
      providerPaymentId,
      providerPaymentStatus,
      expectedAmountCents,
    });
  }
  if (providerPaymentStatus !== "COMPLETED") {
    return refundReview(
      input,
      "unknown_payment_status",
      providerPaymentId,
      providerPaymentStatus,
      expectedAmountCents,
      refundedAmountCents,
    );
  }
  if (orderStatus !== "COMPLETED") {
    return refundReview(
      input,
      "order_state_mismatch",
      providerPaymentId,
      providerPaymentStatus,
      expectedAmountCents,
      refundedAmountCents,
    );
  }
  const capturedAtDate = payment.created_at
    ? new Date(payment.created_at)
    : payment.updated_at
      ? new Date(payment.updated_at)
      : null;
  const capturedAt =
    capturedAtDate && Number.isFinite(capturedAtDate.getTime())
      ? capturedAtDate.toISOString()
      : null;
  if (refundedAmountCents > 0) {
    return outcome({
      status: "refund_review",
      reason: "refund_detected",
      providerOrderId,
      providerPaymentId,
      providerPaymentStatus,
      expectedAmountCents,
      capturedAmountCents: expectedAmountCents,
      refundedAmountCents,
      capturedAt,
      receiptUrl: payment.receipt_url ?? null,
    });
  }
  const capturedAfterHold = Boolean(
    holdExpiresAt &&
      (capturedAtDate
        ? capturedAtDate.getTime() > holdExpiresAt.getTime()
        : now.getTime() > holdExpiresAt.getTime()),
  );
  return outcome({
    status: capturedAfterHold ? "late_capture" : "captured",
    reason: capturedAfterHold
      ? "hold_expired_before_capture"
      : "verified_capture",
    providerOrderId,
    providerPaymentId,
    providerPaymentStatus,
    expectedAmountCents,
    capturedAmountCents: expectedAmountCents,
    refundedAmountCents,
    capturedAt,
    receiptUrl: payment.receipt_url ?? null,
  });
}

export async function verifyQuoteDepositBrowserReturn(
  input: VerifyBrowserReturnInput,
): Promise<QuoteDepositCheckoutOutcome> {
  let returnUrl: URL;
  try {
    returnUrl = new URL(input.browserReturnUrl);
  } catch {
    throw new QuoteSquareCheckoutError("browser_return_url_invalid");
  }
  const state = returnUrl.searchParams.get("state");
  if (!state) {
    throw new QuoteSquareCheckoutError("browser_return_state_missing");
  }
  const verifiedState = verifyQuoteCheckoutReturnState({
    state,
    secret: input.returnStateSecret,
    expectedHash: input.expectedReturnStateHash,
    now: input.now,
  });
  if (!verifiedState.valid) {
    throw new QuoteSquareCheckoutError(
      `browser_return_state_${verifiedState.reason}`,
    );
  }

  // Square-controlled order/payment query parameters are deliberately ignored.
  // The stored provider order is the root of trust for reconciliation.
  return retrieveQuoteDepositCheckoutOutcome(input);
}
