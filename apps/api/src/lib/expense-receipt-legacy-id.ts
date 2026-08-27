import { createHash } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Stable identity for an R2 copy of immutable legacy receipt evidence. Posted
 * ledger rows cannot be relinked without weakening their evidence guard, so
 * readers use this same identity to discover a verified migrated capture.
 */
export function deterministicLegacyReceiptCaptureId(expenseId: string): string {
  if (!UUID_PATTERN.test(expenseId)) {
    throw new Error("expense_id_invalid");
  }
  const bytes = createHash("sha256")
    .update("stonegate:legacy-expense-receipt:v1:", "utf8")
    .update(expenseId.toLowerCase(), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
