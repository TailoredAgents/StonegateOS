import { createHash } from "node:crypto";

export type SelfSessionVersionRecord = {
  id: string;
  authMethod: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type SelfSessionStatus = "active" | "expired" | "revoked";

export function selfSessionStatus(
  session: Pick<SelfSessionVersionRecord, "expiresAt" | "revokedAt">,
  now: Date,
): SelfSessionStatus {
  if (session.revokedAt) return "revoked";
  return session.expiresAt <= now ? "expired" : "active";
}

/**
 * Opaque collection version for optimistic self-session revocation. Raw
 * session IDs never leave the API, but a newly created/revoked session makes a
 * previously rendered confirmation stale.
 */
export function selfSessionCollectionVersion(
  sessions: readonly SelfSessionVersionRecord[],
): string {
  const canonical = [...sessions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((session) => [
      session.id,
      session.authMethod,
      session.createdAt.toISOString(),
      session.expiresAt.toISOString(),
      session.revokedAt?.toISOString() ?? null,
    ]);
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}
