import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export const QUOTE_PUBLIC_NETWORK_KEY_HEADER = "x-stonegate-quote-network-key";
export const QUOTE_PUBLIC_NETWORK_TIMESTAMP_HEADER =
  "x-stonegate-quote-network-timestamp";
export const QUOTE_PUBLIC_NETWORK_SIGNATURE_HEADER =
  "x-stonegate-quote-network-signature";

function requiredSecret(name: string): string {
  const secret = process.env[name]?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return secret;
}

function ipv6NetworkClass(address: string): string | null {
  let candidate = address.toLowerCase();
  const embeddedIpv4 = candidate.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (embeddedIpv4) {
    const octets = embeddedIpv4.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet > 255)) {
      return null;
    }
    const first = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const second = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    candidate = candidate.replace(
      embeddedIpv4,
      `${first.toString(16)}:${second.toString(16)}`,
    );
  }
  const halves = candidate.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))
  ) {
    return null;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

function networkClass(address: string): string | null {
  const candidate = address.normalize("NFKC").trim();
  const version = isIP(candidate);
  if (version === 4) {
    const octets = candidate.split(".");
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  return version === 6 ? ipv6NetworkClass(candidate) : null;
}

export type QuotePublicProxyRequestContext = {
  headers: Pick<Headers, "get">;
  method: string;
};

function trustedNetworkClass(
  request: QuotePublicProxyRequestContext,
): string | null {
  const hopsValue =
    process.env["QUOTE_PUBLIC_TRUSTED_PROXY_HOPS"]?.trim() ?? "";
  if (!hopsValue) return null;
  if (!/^\d{1,2}$/u.test(hopsValue)) {
    throw new Error(
      "QUOTE_PUBLIC_TRUSTED_PROXY_HOPS must be configured for the quote proxy",
    );
  }
  const hops = Number(hopsValue);
  if (hops < 1 || hops > 10) {
    throw new Error("QUOTE_PUBLIC_TRUSTED_PROXY_HOPS must be between 1 and 10");
  }
  const chain =
    request.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (chain.length < hops || chain.length > 32) return null;
  return networkClass(chain[chain.length - hops] ?? "");
}

function networkKeyHash(value: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`quote-v2-rate-limit:network-class\0${value}`, "utf8")
    .digest("hex");
}

/**
 * Produces an authenticated site-to-API network identity. It contains only an
 * HMAC of the trusted /24 or /64 class; neither the client address nor the
 * forwarded chain leaves the site service.
 */
export function quotePublicProxyNetworkHeaders(
  request: QuotePublicProxyRequestContext,
  target: URL,
  now = new Date(),
): Record<string, string> {
  const trusted = trustedNetworkClass(request);
  const controlledLocal =
    process.env.NODE_ENV !== "production" ||
    (Boolean(process.env["E2E_RUN_ID"]?.trim()) &&
      process.env["TEAM_CRM_AUDIT_MODE"] === "1");
  const resolvedNetworkClass =
    trusted ?? (controlledLocal ? "controlled-local" : null);
  if (!resolvedNetworkClass) {
    throw new Error("A trusted client network could not be resolved");
  }
  const rateLimitSecret = requiredSecret("QUOTE_RATE_LIMIT_HMAC_SECRET");
  const proxySecret = requiredSecret("QUOTE_PUBLIC_PROXY_SHARED_SECRET");
  if (rateLimitSecret === proxySecret) {
    throw new Error("Quote public rate-limit and proxy secrets must differ");
  }
  const keyHash = networkKeyHash(resolvedNetworkClass, rateLimitSecret);
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const signaturePayload = [
    "quote-v2-public-network-v1",
    timestamp,
    request.method.toUpperCase(),
    target.pathname,
    keyHash,
  ].join("\n");
  const signature = createHmac("sha256", proxySecret)
    .update(signaturePayload, "utf8")
    .digest("hex");
  return {
    [QUOTE_PUBLIC_NETWORK_KEY_HEADER]: keyHash,
    [QUOTE_PUBLIC_NETWORK_TIMESTAMP_HEADER]: timestamp,
    [QUOTE_PUBLIC_NETWORK_SIGNATURE_HEADER]: signature,
  };
}
