import crypto from "node:crypto";

const UNCONFIGURED_SECRET_SENTINEL =
  "stonegate-unconfigured-legacy-session-secret-sentinel";

/**
 * Compare a legacy recovery cookie without leaking secret length or an early
 * mismatch. Missing configuration always fails closed while performing the
 * same fixed-length digest comparison.
 */
export function legacySessionSecretMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedValue = typeof provided === "string" ? provided : "";
  const expectedValue =
    typeof expected === "string" && expected.length > 0
      ? expected
      : UNCONFIGURED_SECRET_SENTINEL;
  const providedDigest = crypto
    .createHash("sha256")
    .update(providedValue, "utf8")
    .digest();
  const expectedDigest = crypto
    .createHash("sha256")
    .update(expectedValue, "utf8")
    .digest();
  const matches = crypto.timingSafeEqual(providedDigest, expectedDigest);
  return Boolean(providedValue && expected && matches);
}
