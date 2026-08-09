import { extractSquareAttemptIdFromOrder } from "@/lib/square-pos";
import {
  resolveSquareApiEndpoint,
  type SquareApiEndpoint,
  type SquareProviderEnvironment,
} from "@myst-os/sdk";

export const SQUARE_API_VERSION = "2026-07-15";

type SquareMoney = {
  amount?: number | string;
  currency?: string;
};

export type SquareTender = {
  id?: string;
  payment_id?: string;
  type?: string;
  location_id?: string;
  amount_money?: SquareMoney;
  tip_money?: SquareMoney;
  note?: string;
};

export type SquareOrder = {
  id?: string;
  location_id?: string;
  state?: string;
  total_money?: SquareMoney;
  total_tip_money?: SquareMoney;
  tenders?: SquareTender[];
  line_items?: Array<{ name?: string; note?: string }>;
};

export type SquarePayment = {
  id?: string;
  order_id?: string;
  location_id?: string;
  status?: string;
  source_type?: string;
  amount_money?: SquareMoney;
  tip_money?: SquareMoney;
  total_money?: SquareMoney;
  refunded_money?: SquareMoney;
  receipt_url?: string;
  note?: string;
  created_at?: string;
  updated_at?: string;
  card_details?: {
    entry_method?: string;
    card?: {
      card_brand?: string;
      last_4?: string;
    };
  };
};

export type SquareRefund = {
  id?: string;
  payment_id?: string;
  order_id?: string;
  location_id?: string;
  status?: string;
  amount_money?: SquareMoney;
  reason?: string;
  created_at?: string;
  updated_at?: string;
};

type SquareListOptions = {
  locationId: string;
  beginTime: Date;
  endTime?: Date;
  accessToken?: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  timeoutMs?: number;
  environment?: SquareProviderEnvironment;
};

type SquareRequestOptions = {
  accessToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  environment?: SquareProviderEnvironment;
};

export type VerifiedSquarePayment = {
  providerPaymentId: string;
  providerOrderId: string;
  providerStatus: string;
  jobAmountCents: number;
  tipCents: number;
  totalAmountCents: number;
  refundedAmountCents: number;
  currency: "USD";
  tenderType: "card";
  entryMethod: string | null;
  cardBrand: string | null;
  last4: string | null;
  receiptUrl: string | null;
  locationId: string;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  rawOrder: SquareOrder;
  rawPayment: SquarePayment;
};

export class SquareApiError extends Error {
  readonly failureCode: string;

  constructor(
    message: string,
    readonly status: number,
    _legacyDetails?: unknown,
    failureCode = `square_provider_http_${status}`,
  ) {
    super(message);
    this.name = "SquareApiError";
    this.failureCode = failureCode;
  }
}

export function parseSquareMoneyAmount(
  value: SquareMoney | undefined,
): number | null {
  if (!value) return null;
  const raw = value.amount;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^-?\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

const MAX_SQUARE_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SQUARE_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerString(
  value: unknown,
  maximumLength = 4_096,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("square_invalid_response");
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || normalized.length > maximumLength || hasControlCharacter) {
    throw new Error("square_invalid_response");
  }
  return normalized;
}

function parseSquareMoney(value: unknown): SquareMoney | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("square_invalid_response");
  const amount = value["amount"];
  const parsedStringAmount =
    typeof amount === "string" && /^-?\d+$/u.test(amount)
      ? Number(amount)
      : Number.NaN;
  if (
    amount !== undefined &&
    !(
      (typeof amount === "number" && Number.isSafeInteger(amount)) ||
      (typeof amount === "string" && Number.isSafeInteger(parsedStringAmount))
    )
  ) {
    throw new Error("square_invalid_response");
  }
  const currency = providerString(value["currency"], 16);
  return {
    ...(amount !== undefined ? { amount } : {}),
    ...(currency ? { currency } : {}),
  };
}

function providerDate(value: unknown): string | undefined {
  const supplied = providerString(value, 64);
  if (!supplied) return undefined;
  if (!Number.isFinite(new Date(supplied).getTime())) {
    throw new Error("square_invalid_response");
  }
  return supplied;
}

function parseSquareTender(value: unknown): SquareTender {
  if (!isRecord(value)) throw new Error("square_invalid_response");
  return {
    ...(providerString(value["id"], 255)
      ? { id: providerString(value["id"], 255) }
      : {}),
    ...(providerString(value["payment_id"], 255)
      ? { payment_id: providerString(value["payment_id"], 255) }
      : {}),
    ...(providerString(value["type"], 64)
      ? { type: providerString(value["type"], 64) }
      : {}),
    ...(providerString(value["location_id"], 255)
      ? { location_id: providerString(value["location_id"], 255) }
      : {}),
    ...(parseSquareMoney(value["amount_money"])
      ? { amount_money: parseSquareMoney(value["amount_money"]) }
      : {}),
    ...(parseSquareMoney(value["tip_money"])
      ? { tip_money: parseSquareMoney(value["tip_money"]) }
      : {}),
    ...(providerString(value["note"])
      ? { note: providerString(value["note"]) }
      : {}),
  };
}

function parseSquareOrder(value: unknown): SquareOrder {
  if (!isRecord(value)) throw new Error("square_order_invalid_response");
  const id = providerString(value["id"], 255);
  if (!id) throw new Error("square_order_invalid_response");
  const tenders = value["tenders"];
  const lineItems = value["line_items"];
  if (tenders !== undefined && !Array.isArray(tenders)) {
    throw new Error("square_order_invalid_response");
  }
  if (lineItems !== undefined && !Array.isArray(lineItems)) {
    throw new Error("square_order_invalid_response");
  }
  return {
    id,
    ...(providerString(value["location_id"], 255)
      ? { location_id: providerString(value["location_id"], 255) }
      : {}),
    ...(providerString(value["state"], 64)
      ? { state: providerString(value["state"], 64) }
      : {}),
    ...(parseSquareMoney(value["total_money"])
      ? { total_money: parseSquareMoney(value["total_money"]) }
      : {}),
    ...(parseSquareMoney(value["total_tip_money"])
      ? { total_tip_money: parseSquareMoney(value["total_tip_money"]) }
      : {}),
    ...(Array.isArray(tenders)
      ? { tenders: tenders.map(parseSquareTender) }
      : {}),
    ...(Array.isArray(lineItems)
      ? {
          line_items: lineItems.map((item) => {
            if (!isRecord(item)) throw new Error("square_invalid_response");
            return {
              ...(providerString(item["name"])
                ? { name: providerString(item["name"]) }
                : {}),
              ...(providerString(item["note"])
                ? { note: providerString(item["note"]) }
                : {}),
            };
          }),
        }
      : {}),
  };
}

function parseReceiptUrl(value: unknown): string | undefined {
  const receiptUrl = providerString(value);
  if (!receiptUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(receiptUrl);
  } catch {
    throw new Error("square_payment_invalid_response");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("square_payment_invalid_response");
  }
  return parsed.toString();
}

function parseSquarePayment(value: unknown): SquarePayment {
  if (!isRecord(value)) throw new Error("square_payment_invalid_response");
  const id = providerString(value["id"], 255);
  if (!id) throw new Error("square_payment_invalid_response");
  const rawCardDetails = value["card_details"];
  if (rawCardDetails !== undefined && !isRecord(rawCardDetails)) {
    throw new Error("square_payment_invalid_response");
  }
  const rawCard = isRecord(rawCardDetails) ? rawCardDetails["card"] : undefined;
  if (rawCard !== undefined && !isRecord(rawCard)) {
    throw new Error("square_payment_invalid_response");
  }
  const last4 = isRecord(rawCard)
    ? providerString(rawCard["last_4"], 4)
    : undefined;
  if (last4 && !/^\d{4}$/u.test(last4)) {
    throw new Error("square_payment_invalid_response");
  }
  return {
    id,
    ...(providerString(value["order_id"], 255)
      ? { order_id: providerString(value["order_id"], 255) }
      : {}),
    ...(providerString(value["location_id"], 255)
      ? { location_id: providerString(value["location_id"], 255) }
      : {}),
    ...(providerString(value["status"], 64)
      ? { status: providerString(value["status"], 64) }
      : {}),
    ...(providerString(value["source_type"], 64)
      ? { source_type: providerString(value["source_type"], 64) }
      : {}),
    ...(parseSquareMoney(value["amount_money"])
      ? { amount_money: parseSquareMoney(value["amount_money"]) }
      : {}),
    ...(parseSquareMoney(value["tip_money"])
      ? { tip_money: parseSquareMoney(value["tip_money"]) }
      : {}),
    ...(parseSquareMoney(value["total_money"])
      ? { total_money: parseSquareMoney(value["total_money"]) }
      : {}),
    ...(parseSquareMoney(value["refunded_money"])
      ? { refunded_money: parseSquareMoney(value["refunded_money"]) }
      : {}),
    ...(parseReceiptUrl(value["receipt_url"])
      ? { receipt_url: parseReceiptUrl(value["receipt_url"]) }
      : {}),
    ...(providerString(value["note"])
      ? { note: providerString(value["note"]) }
      : {}),
    ...(providerDate(value["created_at"])
      ? { created_at: providerDate(value["created_at"]) }
      : {}),
    ...(providerDate(value["updated_at"])
      ? { updated_at: providerDate(value["updated_at"]) }
      : {}),
    ...(isRecord(rawCardDetails)
      ? {
          card_details: {
            ...(providerString(rawCardDetails["entry_method"], 64)
              ? {
                  entry_method: providerString(
                    rawCardDetails["entry_method"],
                    64,
                  ),
                }
              : {}),
            ...(isRecord(rawCard)
              ? {
                  card: {
                    ...(providerString(rawCard["card_brand"], 64)
                      ? {
                          card_brand: providerString(rawCard["card_brand"], 64),
                        }
                      : {}),
                    ...(last4 ? { last_4: last4 } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function parseSquareRefund(value: unknown): SquareRefund {
  if (!isRecord(value)) throw new Error("square_refund_invalid_response");
  const id = providerString(value["id"], 255);
  if (!id) throw new Error("square_refund_invalid_response");
  return {
    id,
    ...(providerString(value["payment_id"], 255)
      ? { payment_id: providerString(value["payment_id"], 255) }
      : {}),
    ...(providerString(value["order_id"], 255)
      ? { order_id: providerString(value["order_id"], 255) }
      : {}),
    ...(providerString(value["location_id"], 255)
      ? { location_id: providerString(value["location_id"], 255) }
      : {}),
    ...(providerString(value["status"], 64)
      ? { status: providerString(value["status"], 64) }
      : {}),
    ...(parseSquareMoney(value["amount_money"])
      ? { amount_money: parseSquareMoney(value["amount_money"]) }
      : {}),
    ...(providerString(value["reason"])
      ? { reason: providerString(value["reason"]) }
      : {}),
    ...(providerDate(value["created_at"])
      ? { created_at: providerDate(value["created_at"]) }
      : {}),
    ...(providerDate(value["updated_at"])
      ? { updated_at: providerDate(value["updated_at"]) }
      : {}),
  };
}

async function readBoundedSquareBody(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SQUARE_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("square_response_too_large");
  }
  if (!response.body) throw new Error("square_empty_response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SQUARE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("square_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("square_empty_response");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("square_malformed_response");
  }
}

async function squareRequest<T>(
  endpoint: SquareApiEndpoint,
  parse: (value: unknown) => T,
  options?: SquareRequestOptions & { searchParams?: URLSearchParams },
): Promise<T> {
  const accessToken =
    options?.accessToken?.trim() ?? process.env["SQUARE_ACCESS_TOKEN"]?.trim();
  if (!accessToken) throw new Error("SQUARE_ACCESS_TOKEN is not set");
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SQUARE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("square_timeout_invalid");
  }
  const url = new URL(
    resolveSquareApiEndpoint(endpoint, options?.environment ?? process.env),
  );
  if (options?.searchParams) url.search = options.searchParams.toString();
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": SQUARE_API_VERSION,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SquareApiError(
      `Square request failed (${response.status})`,
      response.status,
    );
  }
  return parse(await readBoundedSquareBody(response));
}

export async function getSquareOrder(
  orderId: string,
  options?: SquareRequestOptions,
): Promise<SquareOrder> {
  return squareRequest(
    { kind: "order", orderId },
    (value) => {
      if (!isRecord(value)) throw new Error("square_order_invalid_response");
      const order = parseSquareOrder(value["order"]);
      if (order.id !== orderId) throw new Error("square_order_id_mismatch");
      return order;
    },
    options,
  );
}

export async function getSquarePayment(
  paymentId: string,
  options?: SquareRequestOptions,
): Promise<SquarePayment> {
  return squareRequest(
    { kind: "payment", paymentId },
    (value) => {
      if (!isRecord(value)) throw new Error("square_payment_invalid_response");
      const payment = parseSquarePayment(value["payment"]);
      if (payment.id !== paymentId) {
        throw new Error("square_payment_id_mismatch");
      }
      return payment;
    },
    options,
  );
}

export async function getSquareRefund(
  refundId: string,
  options?: SquareRequestOptions,
): Promise<SquareRefund> {
  return squareRequest(
    { kind: "refund", refundId },
    (value) => {
      if (!isRecord(value)) throw new Error("square_refund_invalid_response");
      const refund = parseSquareRefund(value["refund"]);
      if (refund.id !== refundId) throw new Error("square_refund_id_mismatch");
      return refund;
    },
    options,
  );
}

async function listSquarePages<T>(input: {
  endpoint: { kind: "payments" } | { kind: "refunds" };
  collectionKey: "payments" | "refunds";
  parseRow: (value: unknown) => T;
  options: SquareListOptions;
}): Promise<T[]> {
  const results: T[] = [];
  const seenCursors = new Set<string>();
  const maxPages = input.options.maxPages ?? 100;
  if (!Number.isInteger(maxPages) || maxPages <= 0 || maxPages > 1_000) {
    throw new Error("square_pagination_limit_invalid");
  }
  if (!input.options.locationId.trim()) {
    throw new Error("square_location_id_invalid");
  }
  const endTime = input.options.endTime ?? new Date();
  if (
    !Number.isFinite(input.options.beginTime.getTime()) ||
    !Number.isFinite(endTime.getTime()) ||
    endTime.getTime() < input.options.beginTime.getTime()
  ) {
    throw new Error("square_list_window_invalid");
  }
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      location_id: input.options.locationId,
      begin_time: input.options.beginTime.toISOString(),
      end_time: endTime.toISOString(),
      sort_order: "DESC",
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const payload = await squareRequest(
      input.endpoint,
      (value) => {
        if (!isRecord(value)) {
          throw new Error(`square_${input.collectionKey}_invalid_response`);
        }
        const rawRows = value[input.collectionKey];
        if (!Array.isArray(rawRows)) {
          throw new Error(`square_${input.collectionKey}_invalid_response`);
        }
        const rawCursor = value["cursor"];
        if (rawCursor !== undefined && !providerString(rawCursor, 2_048)) {
          throw new Error(`square_${input.collectionKey}_invalid_response`);
        }
        return {
          rows: rawRows.map(input.parseRow),
          cursor:
            typeof rawCursor === "string" ? rawCursor.trim() || null : null,
        };
      },
      { ...input.options, searchParams: params },
    );
    results.push(...payload.rows);

    const nextCursor = payload.cursor;
    if (!nextCursor) return results;
    if (seenCursors.has(nextCursor)) {
      throw new Error("square_pagination_cursor_repeated");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error("square_pagination_limit_exceeded");
}

export async function listSquarePayments(
  input: SquareListOptions,
): Promise<SquarePayment[]> {
  return listSquarePages<SquarePayment>({
    endpoint: { kind: "payments" },
    collectionKey: "payments",
    parseRow: parseSquarePayment,
    options: input,
  });
}

export async function listSquareRefunds(
  input: SquareListOptions,
): Promise<SquareRefund[]> {
  return listSquarePages<SquareRefund>({
    endpoint: { kind: "refunds" },
    collectionKey: "refunds",
    parseRow: parseSquareRefund,
    options: input,
  });
}

export async function retrieveAndVerifySquarePayment(input: {
  orderId: string;
  expectedAttemptId: string;
  expectedJobAmountCents: number;
  expectedLocationId: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedSquarePayment> {
  const order = await getSquareOrder(input.orderId, input);
  if (order.id !== input.orderId) throw new Error("square_order_id_mismatch");
  if (extractSquareAttemptIdFromOrder(order) !== input.expectedAttemptId) {
    throw new Error("square_attempt_reference_mismatch");
  }
  if (order.location_id !== input.expectedLocationId) {
    throw new Error("square_location_mismatch");
  }
  if (order.state?.toUpperCase() !== "COMPLETED") {
    throw new Error("square_order_not_completed");
  }

  const cardTenders = (order.tenders ?? []).filter(
    (tender) => tender.type?.toUpperCase() === "CARD",
  );
  if (cardTenders.length !== 1) {
    throw new Error("square_card_tender_count_mismatch");
  }
  const tender = cardTenders[0]!;
  const tenderId = tender.id?.trim();
  const tenderPaymentId = tender.payment_id?.trim();
  if (tenderId && tenderPaymentId && tenderId !== tenderPaymentId) {
    throw new Error("square_tender_payment_id_mismatch");
  }
  if (tender.location_id && tender.location_id !== input.expectedLocationId) {
    throw new Error("square_tender_location_mismatch");
  }
  const paymentId = tenderPaymentId ?? tenderId;
  if (!paymentId) throw new Error("square_payment_id_missing");

  const payment = await getSquarePayment(paymentId, input);
  if (payment.order_id !== input.orderId) {
    throw new Error("square_payment_order_mismatch");
  }
  if (payment.location_id !== input.expectedLocationId) {
    throw new Error("square_payment_location_mismatch");
  }
  if (payment.status?.toUpperCase() !== "COMPLETED") {
    throw new Error("square_payment_not_completed");
  }
  if (payment.source_type?.toUpperCase() !== "CARD") {
    throw new Error("square_payment_not_card");
  }

  const jobAmountCents = parseSquareMoneyAmount(payment.amount_money);
  const tipCents = parseSquareMoneyAmount(payment.tip_money) ?? 0;
  const totalAmountCents = parseSquareMoneyAmount(payment.total_money);
  const refundedAmountCents =
    parseSquareMoneyAmount(payment.refunded_money) ?? 0;
  const currency =
    payment.amount_money?.currency?.toUpperCase() ??
    payment.total_money?.currency?.toUpperCase();
  if (
    jobAmountCents == null ||
    jobAmountCents !== input.expectedJobAmountCents
  ) {
    throw new Error("square_payment_amount_mismatch");
  }
  if (tipCents < 0) throw new Error("square_tip_amount_invalid");
  if (
    currency !== "USD" ||
    payment.amount_money?.currency?.toUpperCase() !== "USD" ||
    payment.total_money?.currency?.toUpperCase() !== "USD" ||
    (payment.tip_money && payment.tip_money.currency?.toUpperCase() !== "USD")
  ) {
    throw new Error("square_currency_mismatch");
  }
  if (
    totalAmountCents == null ||
    totalAmountCents <= 0 ||
    totalAmountCents !== jobAmountCents + tipCents
  ) {
    throw new Error("square_payment_total_mismatch");
  }
  if (refundedAmountCents < 0 || refundedAmountCents > totalAmountCents) {
    throw new Error("square_refund_amount_invalid");
  }

  const orderTotalCents = parseSquareMoneyAmount(order.total_money);
  const orderTipCents = parseSquareMoneyAmount(order.total_tip_money) ?? 0;
  const tenderTotalCents = parseSquareMoneyAmount(tender.amount_money);
  const tenderTipCents = parseSquareMoneyAmount(tender.tip_money) ?? 0;
  if (
    orderTotalCents !== jobAmountCents ||
    orderTipCents !== tipCents ||
    tenderTotalCents !== totalAmountCents ||
    tenderTipCents !== tipCents
  ) {
    throw new Error("square_order_tender_amount_mismatch");
  }
  if (
    order.total_money?.currency?.toUpperCase() !== "USD" ||
    (order.total_tip_money &&
      order.total_tip_money.currency?.toUpperCase() !== "USD") ||
    tender.amount_money?.currency?.toUpperCase() !== "USD" ||
    (tender.tip_money && tender.tip_money.currency?.toUpperCase() !== "USD")
  ) {
    throw new Error("square_currency_mismatch");
  }

  return {
    providerPaymentId: paymentId,
    providerOrderId: input.orderId,
    providerStatus: payment.status ?? "COMPLETED",
    jobAmountCents,
    tipCents,
    totalAmountCents,
    refundedAmountCents,
    currency: "USD",
    tenderType: "card",
    entryMethod: payment.card_details?.entry_method ?? null,
    cardBrand: payment.card_details?.card?.card_brand ?? null,
    last4: payment.card_details?.card?.last_4 ?? null,
    receiptUrl: payment.receipt_url ?? null,
    locationId: input.expectedLocationId,
    providerCreatedAt: parseDate(payment.created_at),
    providerUpdatedAt: parseDate(payment.updated_at),
    rawOrder: order,
    rawPayment: payment,
  };
}
