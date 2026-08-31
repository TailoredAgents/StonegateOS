import { resolveSquareApiEndpoint } from "@myst-os/sdk";
import { SQUARE_API_VERSION } from "@/lib/square-client";

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PartnerHostedCheckoutRequest = Readonly<{
  intentId: string;
  invoiceId: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: "USD";
  redirectUrl: string;
}>;

export type PartnerHostedCheckoutResult = Readonly<{
  provider: "square";
  providerLinkId: string;
  providerOrderId: string;
  url: string;
  createdAt: string | null;
}>;

export interface PartnerHostedCheckoutProvider {
  readonly provider: "square";
  readonly locationId: string;
  createHostedCheckout(
    input: PartnerHostedCheckoutRequest,
  ): Promise<PartnerHostedCheckoutResult>;
}

export class PartnerHostedCheckoutProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly providerStatus: number | null = null,
  ) {
    super(code);
    this.name = "PartnerHostedCheckoutProviderError";
  }
}

type SquareHostedCheckoutProviderOptions = Readonly<{
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

function boundedProviderString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum) return null;
  return hasControlCharacter(normalized) ? null : normalized;
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

export function isSafePartnerHostedCheckoutUrl(
  value: unknown,
): value is string {
  const raw = boundedProviderString(value, 2_048);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    const trustedHostname =
      hostname === "square.link" ||
      hostname.endsWith(".square.link") ||
      hostname === "square.site" ||
      hostname.endsWith(".square.site") ||
      hostname === "squareup.com" ||
      hostname.endsWith(".squareup.com");
    return (
      url.protocol === "https:" &&
      trustedHostname &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function isSecurePartnerPaymentReturnUrl(
  value: unknown,
): value is string {
  const raw = boundedProviderString(value, 2_048);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function readBoundedProviderJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new PartnerHostedCheckoutProviderError(
      "provider_response_too_large",
      true,
    );
  }
  if (!response.body) {
    throw new PartnerHostedCheckoutProviderError(
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
        throw new PartnerHostedCheckoutProviderError(
          "provider_response_too_large",
          true,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) {
    throw new PartnerHostedCheckoutProviderError(
      "provider_empty_response",
      true,
    );
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
    throw new PartnerHostedCheckoutProviderError(
      "provider_malformed_response",
      true,
    );
  }
}

function parseSquarePaymentLinkResponse(
  value: unknown,
): PartnerHostedCheckoutResult {
  if (!isRecord(value) || !isRecord(value["payment_link"])) {
    throw new PartnerHostedCheckoutProviderError(
      "provider_invalid_response",
      true,
    );
  }
  const link = value["payment_link"];
  const providerLinkId = boundedProviderString(link["id"], 255);
  const providerOrderId = boundedProviderString(link["order_id"], 255);
  const url = link["url"];
  const createdAtRaw = link["created_at"];
  const createdAt =
    typeof createdAtRaw === "string" &&
    Number.isFinite(new Date(createdAtRaw).getTime())
      ? new Date(createdAtRaw).toISOString()
      : null;
  if (
    !providerLinkId ||
    !providerOrderId ||
    !isSafePartnerHostedCheckoutUrl(url)
  ) {
    throw new PartnerHostedCheckoutProviderError(
      "provider_invalid_response",
      true,
    );
  }
  return {
    provider: "square",
    providerLinkId,
    providerOrderId,
    url,
    createdAt,
  };
}

export function createSquarePartnerHostedCheckoutProvider(
  options: SquareHostedCheckoutProviderOptions = {},
): PartnerHostedCheckoutProvider {
  const environment = options.environment ?? process.env;
  const accessToken =
    options.accessToken?.trim() ?? environment["SQUARE_ACCESS_TOKEN"]?.trim();
  const locationId =
    options.locationId?.trim() ?? environment["SQUARE_LOCATION_ID"]?.trim();
  if (
    !accessToken ||
    accessToken.length > 4_096 ||
    hasControlCharacter(accessToken)
  ) {
    throw new PartnerHostedCheckoutProviderError(
      "provider_not_configured",
      false,
    );
  }
  if (
    !locationId ||
    locationId.length > 255 ||
    hasControlCharacter(locationId)
  ) {
    throw new PartnerHostedCheckoutProviderError(
      "provider_not_configured",
      false,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new PartnerHostedCheckoutProviderError(
      "provider_timeout_invalid",
      false,
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    provider: "square",
    locationId,
    async createHostedCheckout(
      input: PartnerHostedCheckoutRequest,
    ): Promise<PartnerHostedCheckoutResult> {
      if (
        !UUID_PATTERN.test(input.intentId) ||
        !UUID_PATTERN.test(input.invoiceId) ||
        !Number.isSafeInteger(input.amountMinor) ||
        input.amountMinor <= 0 ||
        input.amountMinor > 2_147_483_647 ||
        input.currency !== "USD" ||
        !isSecurePartnerPaymentReturnUrl(input.redirectUrl)
      ) {
        throw new PartnerHostedCheckoutProviderError(
          "provider_request_invalid",
          false,
        );
      }
      const invoiceLabel = safeInvoiceLabel(input.invoiceNumber);
      const attemptReference = `attempt ${input.intentId}`;
      const requestBody = {
        idempotency_key: input.intentId,
        description: `Stonegate partner invoice ${invoiceLabel}`,
        quick_pay: {
          name: `Stonegate invoice ${invoiceLabel}; ${attemptReference}`,
          price_money: {
            amount: input.amountMinor,
            currency: input.currency,
          },
          location_id: locationId,
        },
        checkout_options: {
          allow_tipping: false,
          ask_for_shipping_address: false,
          redirect_url: input.redirectUrl,
          accepted_payment_methods: {
            apple_pay: false,
            google_pay: false,
            cash_app_pay: false,
            afterpay_clearpay: false,
          },
        },
        payment_note: `Stonegate invoice ${input.invoiceId}; ${attemptReference}`,
      };
      let response: Response;
      try {
        response = await fetchImpl(
          resolveSquareApiEndpoint({ kind: "paymentLinks" }, environment),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "Square-Version": SQUARE_API_VERSION,
            },
            body: JSON.stringify(requestBody),
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch {
        throw new PartnerHostedCheckoutProviderError(
          "provider_request_indeterminate",
          true,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        const retryable =
          response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500;
        throw new PartnerHostedCheckoutProviderError(
          `provider_http_${response.status}`,
          retryable,
          response.status,
        );
      }
      return parseSquarePaymentLinkResponse(
        await readBoundedProviderJson(response),
      );
    },
  };
}
