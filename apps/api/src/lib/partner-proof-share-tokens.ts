import { createHash, createHmac } from "node:crypto";

export class PartnerProofShareTokenConfigurationError extends Error {
  constructor() {
    super("Proof-share token generation is unavailable.");
    this.name = "PartnerProofShareTokenConfigurationError";
  }
}

function signingKey(): Buffer {
  const encoded = process.env["PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64"]?.trim();
  if (!encoded) throw new PartnerProofShareTokenConfigurationError();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new PartnerProofShareTokenConfigurationError();
  return key;
}

/**
 * Derivation makes a safe idempotent retry reproduce the bearer value while
 * PostgreSQL stores only its SHA-256 hash. Reusing the same request key with
 * different input resolves to the same token hash and is rejected by the
 * route after comparing the persisted package and duration.
 */
export function derivePartnerProofShareToken(input: {
  partnerAccountId: string;
  idempotencyKeyHash: string;
}): { token: string; tokenHash: string } {
  if (!/^[0-9a-f]{64}$/u.test(input.idempotencyKeyHash)) {
    throw new TypeError("The proof-share request fingerprint is invalid.");
  }
  const token = createHmac("sha256", signingKey())
    .update("stonegate-partner-proof-share\0", "utf8")
    .update(input.partnerAccountId, "utf8")
    .update("\0", "utf8")
    .update(input.idempotencyKeyHash, "utf8")
    .digest("base64url");
  return {
    token,
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
  };
}

export function hashPartnerProofShareToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest("hex");
}
