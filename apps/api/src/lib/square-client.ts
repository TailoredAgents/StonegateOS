import { extractSquareAttemptIdFromOrder } from "@/lib/square-pos";

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
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "SquareApiError";
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

function squareApiBaseUrl(): string {
  return process.env["SQUARE_ENVIRONMENT"]?.trim().toLowerCase() === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

async function squareRequest<T>(
  path: string,
  options?: { accessToken?: string; fetchImpl?: typeof fetch },
): Promise<T> {
  const accessToken =
    options?.accessToken?.trim() ?? process.env["SQUARE_ACCESS_TOKEN"]?.trim();
  if (!accessToken) throw new Error("SQUARE_ACCESS_TOKEN is not set");
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(`${squareApiBaseUrl()}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": SQUARE_API_VERSION,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new SquareApiError(
      `Square request failed (${response.status})`,
      response.status,
      body,
    );
  }
  return body as T;
}

export async function getSquareOrder(
  orderId: string,
  options?: { accessToken?: string; fetchImpl?: typeof fetch },
): Promise<SquareOrder> {
  const payload = await squareRequest<{ order?: SquareOrder }>(
    `/v2/orders/${encodeURIComponent(orderId)}`,
    options,
  );
  if (!payload.order?.id) throw new Error("square_order_missing");
  return payload.order;
}

export async function getSquarePayment(
  paymentId: string,
  options?: { accessToken?: string; fetchImpl?: typeof fetch },
): Promise<SquarePayment> {
  const payload = await squareRequest<{ payment?: SquarePayment }>(
    `/v2/payments/${encodeURIComponent(paymentId)}`,
    options,
  );
  if (!payload.payment?.id) throw new Error("square_payment_missing");
  return payload.payment;
}

export async function getSquareRefund(
  refundId: string,
  options?: { accessToken?: string; fetchImpl?: typeof fetch },
): Promise<SquareRefund> {
  const payload = await squareRequest<{ refund?: SquareRefund }>(
    `/v2/refunds/${encodeURIComponent(refundId)}`,
    options,
  );
  if (!payload.refund?.id) throw new Error("square_refund_missing");
  return payload.refund;
}

async function listSquarePages<T>(input: {
  path: "/v2/payments" | "/v2/refunds";
  collectionKey: "payments" | "refunds";
  options: SquareListOptions;
}): Promise<T[]> {
  const results: T[] = [];
  const seenCursors = new Set<string>();
  const maxPages = input.options.maxPages ?? 100;
  if (!Number.isInteger(maxPages) || maxPages <= 0 || maxPages > 1_000) {
    throw new Error("square_pagination_limit_invalid");
  }
  const endTime = input.options.endTime ?? new Date();
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
    const payload = await squareRequest<
      Partial<Record<"payments" | "refunds", T[]>> & {
        cursor?: string;
      }
    >(`${input.path}?${params.toString()}`, input.options);
    const pageRows = payload[input.collectionKey];
    if (Array.isArray(pageRows)) results.push(...pageRows);

    const nextCursor = payload.cursor?.trim() || null;
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
    path: "/v2/payments",
    collectionKey: "payments",
    options: input,
  });
}

export async function listSquareRefunds(
  input: SquareListOptions,
): Promise<SquareRefund[]> {
  return listSquarePages<SquareRefund>({
    path: "/v2/refunds",
    collectionKey: "refunds",
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
