import { isControlledProviderTestRuntime } from "./provider-test-runtime";

export type SquareProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type SquareApiEndpoint =
  | { kind: "order"; orderId: string }
  | { kind: "payment"; paymentId: string }
  | { kind: "refund"; refundId: string }
  | { kind: "paymentLinks" }
  | { kind: "payments" }
  | { kind: "refunds" };

export const DEFAULT_SQUARE_PRODUCTION_API_BASE_URL =
  "https://connect.squareup.com";
export const DEFAULT_SQUARE_SANDBOX_API_BASE_URL =
  "https://connect.squareupsandbox.com";

export function isLoopbackSquareHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }

  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number.parseInt(part, 10) <= 255,
    )
  );
}

function defaultSquareApiBaseUrl(
  environment: SquareProviderEnvironment,
): string {
  return environment["SQUARE_ENVIRONMENT"]?.trim().toLowerCase() === "sandbox"
    ? DEFAULT_SQUARE_SANDBOX_API_BASE_URL
    : DEFAULT_SQUARE_PRODUCTION_API_BASE_URL;
}

export function getSquareApiBaseUrl(
  environment: SquareProviderEnvironment,
): URL {
  let url: URL;
  try {
    url = new URL(
      environment["SQUARE_API_BASE_URL"]?.trim() ||
        defaultSquareApiBaseUrl(environment),
    );
  } catch {
    throw new Error("SQUARE_API_BASE_URL must be a valid absolute URL.");
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "SQUARE_API_BASE_URL must not contain credentials, query parameters, or a fragment.",
    );
  }

  const loopback = isLoopbackSquareHostname(url.hostname);
  const production =
    environment["NODE_ENV"]?.trim().toLowerCase() === "production";
  const controlledTestMode = isControlledProviderTestRuntime(environment);
  if (production && loopback && !controlledTestMode) {
    throw new Error(
      "SQUARE_API_BASE_URL cannot target a loopback host in production.",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "SQUARE_API_BASE_URL must use HTTPS unless it targets a loopback service.",
    );
  }
  if (controlledTestMode && !loopback) {
    throw new Error(
      "SQUARE_API_BASE_URL must target a loopback service during E2E or CRM audit runs.",
    );
  }

  return url;
}

function safeProviderId(value: string, label: string): string {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (normalized.length < 1 || normalized.length > 255 || hasControlCharacter) {
    throw new Error(`${label} must be a non-empty provider identifier.`);
  }
  return normalized;
}

export function resolveSquareApiEndpoint(
  endpoint: SquareApiEndpoint,
  environment: SquareProviderEnvironment,
): string {
  const base = getSquareApiBaseUrl(environment);
  const basePath = base.pathname.replace(/\/+$/u, "");
  let suffix: string;
  switch (endpoint.kind) {
    case "order":
      suffix = `/v2/orders/${encodeURIComponent(
        safeProviderId(endpoint.orderId, "orderId"),
      )}`;
      break;
    case "payment":
      suffix = `/v2/payments/${encodeURIComponent(
        safeProviderId(endpoint.paymentId, "paymentId"),
      )}`;
      break;
    case "refund":
      suffix = `/v2/refunds/${encodeURIComponent(
        safeProviderId(endpoint.refundId, "refundId"),
      )}`;
      break;
    case "paymentLinks":
      suffix = "/v2/online-checkout/payment-links";
      break;
    case "payments":
      suffix = "/v2/payments";
      break;
    case "refunds":
      suffix = "/v2/refunds";
      break;
  }

  base.pathname = `${basePath}${suffix}`.replace(/\/{2,}/gu, "/");
  return base.toString();
}
