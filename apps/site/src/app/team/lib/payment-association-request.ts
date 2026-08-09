import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/**
 * The Site is the API caller for a server action. Deriving the key from the
 * exact action, record version, and canonical payload makes a duplicate or an
 * ambiguous retry reuse its key, while an intentional field correction gets
 * a new key. Only the SHA-256 digest is sent or stored.
 */
export function buildStablePaymentAssociationKey(input: {
  action: "attach" | "detach";
  paymentId: string;
  expectedVersion: string;
  payload: Record<string, unknown>;
}): string {
  const canonical = canonicalize([
    input.action,
    input.paymentId,
    input.expectedVersion,
    input.payload,
  ]);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return `payment-association:${input.action}:${fingerprint}`;
}
