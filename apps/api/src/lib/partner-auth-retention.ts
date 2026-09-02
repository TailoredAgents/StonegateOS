import { sql } from "drizzle-orm";
import { getDb, type DatabaseClient } from "@/db";

export const PARTNER_AUTH_DETAIL_RETENTION_DAYS = 90;
export const DEFAULT_PARTNER_AUTH_RETENTION_BATCH_SIZE = 500;

export type PartnerAuthRetentionResult = {
  retentionDays: number;
  prunedAt: string;
  challengesExpired: number;
  challengesSanitized: number;
  applicantSessionsSanitized: number;
  authTransactionsDeleted: number;
  sessionsSanitized: number;
  loginTokensDeleted: number;
  batchMayHaveMore: boolean;
};

function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

function safeCount(row: Record<string, unknown>, key: string): number {
  const count = Number(row[key]);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Partner authentication retention returned invalid ${key}.`);
  }
  return count;
}

export function parsePartnerAuthRetentionBatchSize(
  value: string | number | null | undefined,
): number {
  const parsed = typeof value === "number" ? value : Number(value ?? "");
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 5_000
    ? parsed
    : DEFAULT_PARTNER_AUTH_RETENTION_BATCH_SIZE;
}

/**
 * Removes expired authentication credentials and detailed network/device
 * metadata while preserving account, membership, application, and audit
 * evidence. The database procedure is bounded and uses SKIP LOCKED so this is
 * safe when a worker deployment briefly overlaps during release.
 */
export async function prunePartnerAuthenticationMetadata(input?: {
  now?: Date;
  limit?: number;
  database?: DatabaseClient;
}): Promise<PartnerAuthRetentionResult> {
  const now = input?.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Partner authentication retention requires a valid time.");
  }
  const limit = parsePartnerAuthRetentionBatchSize(input?.limit);
  const database = input?.database ?? getDb();
  const rows = resultRows(
    await database.execute(sql`
      SELECT *
      FROM "prune_partner_authentication_metadata"(
        ${now.toISOString()}::timestamptz,
        ${limit}::integer
      )
    `),
  );
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Partner authentication retention returned no result.");
  }
  const record = row as Record<string, unknown>;
  const counts = {
    challengesExpired: safeCount(record, "challenges_expired"),
    challengesSanitized: safeCount(record, "challenges_sanitized"),
    applicantSessionsSanitized: safeCount(
      record,
      "applicant_sessions_sanitized",
    ),
    authTransactionsDeleted: safeCount(
      record,
      "auth_transactions_deleted",
    ),
    sessionsSanitized: safeCount(record, "sessions_sanitized"),
    loginTokensDeleted: safeCount(record, "login_tokens_deleted"),
  };
  return {
    retentionDays: PARTNER_AUTH_DETAIL_RETENTION_DAYS,
    prunedAt: now.toISOString(),
    ...counts,
    batchMayHaveMore: Object.values(counts).some((count) => count === limit),
  };
}
