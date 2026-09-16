/**
 * This is a nonsecret browser origin, never an object URL or storage credential.
 * Reject malformed configuration instead of widening the policy or echoing it.
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function partnerMediaStorageOrigin(value) {
  const candidate = value?.trim();
  if (!candidate) return null;
  const invalid = () =>
    new Error("PARTNER_MEDIA_STORAGE_ORIGIN must be one exact HTTPS origin.");
  if (candidate.length > 1024 || /[\s*\\]/u.test(candidate)) throw invalid();
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== candidate
  ) {
    throw invalid();
  }
  return url.origin;
}

/**
 * Billing's document policy survives client-side navigation to other portal
 * pages. Permit only the configured private-storage origin for photo transfers
 * and signed previews. Storage access still requires a signed API-issued URL.
 * @param {string | undefined} configuredMediaOrigin
 * @returns {string}
 */
export function createPartnerBillingCsp(configuredMediaOrigin) {
  const mediaOrigin = partnerMediaStorageOrigin(configuredMediaOrigin);
  const mediaSource = mediaOrigin ? ` ${mediaOrigin}` : "";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' https://web.squarecdn.com https://sandbox.web.squarecdn.com",
    "style-src 'self' 'unsafe-inline' https://web.squarecdn.com https://sandbox.web.squarecdn.com",
    "frame-src https://web.squarecdn.com https://sandbox.web.squarecdn.com",
    `connect-src 'self' https://pci-connect.squareup.com https://pci-connect.squareupsandbox.com https://o160250.ingest.sentry.io${mediaSource}`,
    "font-src 'self' data: https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net",
    `img-src 'self' data: blob:${mediaSource}`,
    "upgrade-insecure-requests",
  ].join("; ");
}
