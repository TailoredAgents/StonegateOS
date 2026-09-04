export const PARTNER_SESSION_COOKIE = "myst-partner-session";

const PARTNER_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Partner session tokens are 32 random bytes encoded as unpadded base64url.
 * Reject malformed cookie values before they are forwarded to the API.
 */
export function isValidPartnerSessionToken(value: string): boolean {
  return PARTNER_SESSION_TOKEN_PATTERN.test(value);
}
