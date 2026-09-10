import { isIP } from "node:net";

/** The API explicitly trusts configured Site origins, not its external
 * transport URL (which can differ from the request URL behind a proxy). */
export function resolveActivationInspectionOrigin(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  for (const raw of [
    environment["NEXT_PUBLIC_SITE_URL"],
    environment["SITE_URL"],
  ]) {
    if (!raw?.trim()) continue;
    try {
      const url = new URL(raw.trim());
      if (
        !["https:", "http:"].includes(url.protocol) ||
        (environment["NODE_ENV"] === "production" &&
          url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        continue;
      return url.origin;
    } catch {
      // Try the other operator-configured Site URL, never request headers.
    }
  }
  return environment["NODE_ENV"] === "development" ||
    environment["NODE_ENV"] === "test"
    ? "http://localhost:3000"
    : null;
}

/** Uses the deployment's existing trusted-hop policy (also used by the public
 * quote proxy), never a caller-selected leftmost address, CF or Real-IP header.
 * Unconfigured/malformed ingress stays in the conservative shared bucket. */
export function activationInspectionHeaders(
  incoming: Pick<Headers, "get">,
  trustedSiteOrigin: string,
  options: { trustedProxyHops?: string } = {},
): Headers {
  const result = new Headers({ Origin: trustedSiteOrigin });
  const configured = (
    options.trustedProxyHops ??
    process.env["QUOTE_PUBLIC_TRUSTED_PROXY_HOPS"] ??
    ""
  ).trim();
  const hops = /^\d{1,2}$/u.test(configured) ? Number(configured) : 0;
  const forwarded = incoming.get("x-forwarded-for") ?? "";
  if (hops >= 1 && hops <= 10 && forwarded.length <= 4096) {
    const chain = forwarded.split(",").map((part) => part.trim());
    const address =
      chain.length >= hops && chain.length <= 32
        ? (chain[chain.length - hops] ?? "")
        : "";
    if (address.length <= 128 && isIP(address))
      result.set("X-Forwarded-For", address);
  }
  const agent = incoming.get("user-agent")?.trim();
  if (agent) result.set("User-Agent", agent.slice(0, 512));
  return result;
}
