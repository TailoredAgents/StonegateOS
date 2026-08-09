import { createHash } from "node:crypto";

/**
 * Produces a compact opaque revision for Inbox polling responses. Only the
 * digest is returned to the browser; source fields never leave the server.
 */
export function buildInboxSnapshotSignature(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("base64url");
}
