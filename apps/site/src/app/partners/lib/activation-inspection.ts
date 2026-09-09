import { isIP } from "node:net";

/** Uses the deployment's existing trusted-hop policy (also used by the public
 * quote proxy), never a caller-selected leftmost address, CF or Real-IP header.
 * Unconfigured/malformed ingress stays in the conservative shared bucket. */
export function activationInspectionHeaders(
  incoming: Pick<Headers, "get">,
  trustedApiUrl: string,
  options: { trustedProxyHops?: string } = {},
): Headers {
  const result = new Headers({ Origin: new URL(trustedApiUrl).origin });
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
