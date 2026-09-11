function configuredOrigin(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

/**
 * NextURL normalizes loopback IPs to "localhost". Recover the exact browser
 * origin only from an operator-configured Site URL whose authority matches the
 * request's HTTP Host. Forwarding headers and a caller's Origin cannot define
 * a trusted destination. Different ports and schemes are not interchangeable.
 */
export function resolveRequestOrigin(
  request: Pick<Request, "headers" | "url">,
  options: { configuredSiteUrls?: readonly (string | undefined)[] } = {},
): string {
  const host = request.headers.get("host")?.trim() ?? "";
  if (host && !/[/\\@?#,\s]/u.test(host)) {
    for (const raw of options.configuredSiteUrls ?? [
      process.env["SITE_URL"],
      process.env["NEXT_PUBLIC_SITE_URL"],
    ]) {
      const site = configuredOrigin(raw);
      if (!site) continue;
      try {
        const authority = new URL(site.protocol + "//" + host);
        if (authority.origin === site.origin) return site.origin;
      } catch {
        /* Malformed Host never expands trust. */
      }
    }
  }
  return new URL(request.url).origin;
}
