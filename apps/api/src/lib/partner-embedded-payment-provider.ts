import { getSquareApiBaseUrl } from "@myst-os/sdk";
import { SQUARE_API_VERSION } from "@/lib/square-client";
import { squareAttemptNote } from "@/lib/square-pos";

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const MAX_PAYMENT_MINOR = 2_147_483_647;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PartnerWebPaymentsConfiguration = Readonly<{
  applicationId: string;
  locationId: string;
  environment: "sandbox" | "production";
  sdkUrl:
    | "https://sandbox.web.squarecdn.com/v1/square.js"
    | "https://web.squarecdn.com/v1/square.js";
  methods: Readonly<{ card: true; ach: false }>;
  achUnavailableReason: "merchant_and_return_configuration_required";
}>;

export type PartnerEmbeddedOrderRequest = Readonly<{
  intentId: string;
  appointmentId: string;
  invoiceNumber: string;
  purpose: "deposit" | "one_off";
  amountMinor: number;
  currency: "USD";
}>;

export type PartnerEmbeddedOrderResult = Readonly<{
  provider: "square";
  providerOrderId: string;
  locationId: string;
}>;

export type PartnerEmbeddedPaymentRequest = Readonly<{
  intentId: string;
  appointmentId: string;
  providerOrderId: string;
  sourceToken: string;
  amountMinor: number;
  currency: "USD";
}>;

export type PartnerEmbeddedPaymentResult = Readonly<{
  provider: "square";
  providerOrderId: string;
  providerPaymentId: string;
  locationId: string;
  providerStatus: "COMPLETED" | "PENDING";
}>;

export interface PartnerEmbeddedPaymentProvider {
  readonly provider: "square";
  readonly locationId: string;
  readonly webPayments: PartnerWebPaymentsConfiguration;
  createOrder(
    input: PartnerEmbeddedOrderRequest,
  ): Promise<PartnerEmbeddedOrderResult>;
  createPayment(
    input: PartnerEmbeddedPaymentRequest,
  ): Promise<PartnerEmbeddedPaymentResult>;
}

export class PartnerEmbeddedPaymentProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly providerStatus: number | null = null,
    readonly indeterminate = false,
  ) {
    super(code);
    this.name = "PartnerEmbeddedPaymentProviderError";
  }
}

type SquareEmbeddedPaymentProviderOptions = Readonly<{
  applicationId?: string;
  accessToken?: string;
  locationId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  environment?: Readonly<Record<string, string | undefined>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}

function providerString(value: unknown, maximum = 255): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized &&
    normalized.length <= maximum &&
    !hasControlCharacter(normalized)
    ? normalized
    : null;
}

function safeInvoiceLabel(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const safe = [...normalized]
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127;
    })
    .join("")
    .slice(0, 80);
  return safe || "payment";
}

function assertPaymentRequest(input: {
  intentId: string;
  appointmentId: string;
  amountMinor: number;
  currency: string;
}): void {
  if (
    !UUID_PATTERN.test(input.intentId) ||
    !UUID_PATTERN.test(input.appointmentId) ||
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    input.amountMinor > MAX_PAYMENT_MINOR ||
    input.currency !== "USD"
  ) {
    throw new PartnerEmbeddedPaymentProviderError(
      "provider_request_invalid",
      false,
    );
  }
}

async function readBoundedProviderJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new PartnerEmbeddedPaymentProviderError(
      "provider_response_too_large",
      true,
    );
  }
  if (!response.body) {
    throw new PartnerEmbeddedPaymentProviderError(
      "provider_empty_response",
      true,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PartnerEmbeddedPaymentProviderError(
          "provider_response_too_large",
          true,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new PartnerEmbeddedPaymentProviderError(
      "provider_malformed_response",
      true,
    );
  }
}

function providerHttpError(status: number, indeterminate: boolean) {
  const retryable =
    status === 408 || status === 409 || status === 429 || status >= 500;
  return new PartnerEmbeddedPaymentProviderError(
    `provider_http_${status}`,
    retryable,
    status,
    indeterminate && retryable,
  );
}

function moneyMatches(
  value: unknown,
  amountMinor: number,
  currency: "USD",
): boolean {
  if (!isRecord(value)) return false;
  const amount = value["amount"];
  const parsed =
    typeof amount === "number"
      ? amount
      : typeof amount === "string" && /^\d+$/u.test(amount)
        ? Number(amount)
        : Number.NaN;
  return (
    Number.isSafeInteger(parsed) &&
    parsed === amountMinor &&
    value["currency"] === currency
  );
}

function buildEndpoint(
  baseUrl: URL,
  suffix: "/v2/orders" | "/v2/payments",
): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${suffix}`.replace(/\/{2,}/gu, "/");
  return url.toString();
}

export function createSquarePartnerEmbeddedPaymentProvider(
  options: SquareEmbeddedPaymentProviderOptions = {},
): PartnerEmbeddedPaymentProvider {
  const environment = options.environment ?? process.env;
  const applicationId = providerString(
    options.applicationId ?? environment["SQUARE_APPLICATION_ID"],
  );
  const accessToken = providerString(
    options.accessToken ?? environment["SQUARE_ACCESS_TOKEN"],
    4_096,
  );
  const locationId = providerString(
    options.locationId ?? environment["SQUARE_LOCATION_ID"],
  );
  if (!applicationId || !accessToken || !locationId) {
    throw new PartnerEmbeddedPaymentProviderError(
      "provider_not_configured",
      false,
    );
  }
  const squareEnvironment =
    environment["SQUARE_ENVIRONMENT"]?.trim().toLowerCase() === "sandbox"
      ? "sandbox"
      : "production";
  const webPayments: PartnerWebPaymentsConfiguration = {
    applicationId,
    locationId,
    environment: squareEnvironment,
    sdkUrl:
      squareEnvironment === "sandbox"
        ? "https://sandbox.web.squarecdn.com/v1/square.js"
        : "https://web.squarecdn.com/v1/square.js",
    methods: { card: true, ach: false },
    // ACH requires merchant eligibility plus Square's browser authorization
    // redirect/transaction configuration. Neither can be inferred safely from
    // the credentials used for card processing.
    achUnavailableReason: "merchant_and_return_configuration_required",
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new PartnerEmbeddedPaymentProviderError(
      "provider_timeout_invalid",
      false,
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = getSquareApiBaseUrl(environment);
  } catch {
    throw new PartnerEmbeddedPaymentProviderError(
      "provider_not_configured",
      false,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_API_VERSION,
  };

  return {
    provider: "square",
    locationId,
    webPayments,
    async createOrder(input) {
      assertPaymentRequest(input);
      const note = squareAttemptNote({
        appointmentId: input.appointmentId,
        attemptId: input.intentId,
      });
      const label = safeInvoiceLabel(input.invoiceNumber);
      const requestBody = {
        idempotency_key: `${input.intentId}-order`,
        order: {
          location_id: locationId,
          reference_id: input.intentId,
          line_items: [
            {
              name:
                input.purpose === "deposit"
                  ? `Stonegate invoice ${label} deposit`
                  : `Stonegate invoice ${label} immediate payment`,
              note,
              quantity: "1",
              base_price_money: {
                amount: input.amountMinor,
                currency: input.currency,
              },
            },
          ],
        },
      };
      let response: Response;
      try {
        response = await fetchImpl(buildEndpoint(baseUrl, "/v2/orders"), {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new PartnerEmbeddedPaymentProviderError(
          "provider_order_request_indeterminate",
          true,
          null,
          true,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw providerHttpError(response.status, true);
      }
      const body = await readBoundedProviderJson(response);
      const order =
        isRecord(body) && isRecord(body["order"]) ? body["order"] : null;
      const providerOrderId = providerString(order?.["id"]);
      if (
        !order ||
        !providerOrderId ||
        order["location_id"] !== locationId ||
        (order["state"] !== undefined && order["state"] !== "OPEN") ||
        (order["total_money"] !== undefined &&
          !moneyMatches(
            order["total_money"],
            input.amountMinor,
            input.currency,
          ))
      ) {
        throw new PartnerEmbeddedPaymentProviderError(
          "provider_invalid_response",
          true,
          null,
          true,
        );
      }
      return {
        provider: "square",
        providerOrderId,
        locationId,
      };
    },
    async createPayment(input) {
      assertPaymentRequest(input);
      const providerOrderId = providerString(input.providerOrderId);
      const sourceToken = providerString(input.sourceToken, 2_048);
      if (!providerOrderId || !sourceToken) {
        throw new PartnerEmbeddedPaymentProviderError(
          "provider_request_invalid",
          false,
        );
      }
      const note = squareAttemptNote({
        appointmentId: input.appointmentId,
        attemptId: input.intentId,
      });
      const requestBody = {
        source_id: sourceToken,
        idempotency_key: input.intentId,
        amount_money: {
          amount: input.amountMinor,
          currency: input.currency,
        },
        autocomplete: true,
        order_id: providerOrderId,
        location_id: locationId,
        reference_id: input.intentId,
        note,
      };
      let response: Response;
      try {
        response = await fetchImpl(buildEndpoint(baseUrl, "/v2/payments"), {
          method: "POST",
          headers,
          // The one-use Square token exists only in this provider call. It is
          // never included in metadata, audit logs, or any returned DTO.
          body: JSON.stringify(requestBody),
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new PartnerEmbeddedPaymentProviderError(
          "provider_payment_request_indeterminate",
          true,
          null,
          true,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw providerHttpError(response.status, true);
      }
      const body = await readBoundedProviderJson(response);
      const payment =
        isRecord(body) && isRecord(body["payment"]) ? body["payment"] : null;
      const providerPaymentId = providerString(payment?.["id"]);
      const status = payment?.["status"];
      if (
        !payment ||
        !providerPaymentId ||
        payment["order_id"] !== providerOrderId ||
        payment["location_id"] !== locationId ||
        (status !== "COMPLETED" && status !== "PENDING") ||
        payment["source_type"] !== "CARD" ||
        !moneyMatches(
          payment["amount_money"],
          input.amountMinor,
          input.currency,
        )
      ) {
        throw new PartnerEmbeddedPaymentProviderError(
          "provider_invalid_response",
          true,
          null,
          true,
        );
      }
      return {
        provider: "square",
        providerOrderId,
        providerPaymentId,
        locationId,
        providerStatus: status,
      };
    },
  };
}
