import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseClient } from "@/db";
import {
  DEFAULT_PARTNER_AUTH_RETENTION_BATCH_SIZE,
  parsePartnerAuthRetentionBatchSize,
  PARTNER_AUTH_DETAIL_RETENTION_DAYS,
  prunePartnerAuthenticationMetadata,
} from "@/lib/partner-auth-retention";

describe("Partner authentication metadata retention", () => {
  it("uses the locked 90-day policy and a bounded worker batch", () => {
    expect(PARTNER_AUTH_DETAIL_RETENTION_DAYS).toBe(90);
    expect(parsePartnerAuthRetentionBatchSize(undefined)).toBe(
      DEFAULT_PARTNER_AUTH_RETENTION_BATCH_SIZE,
    );
    expect(parsePartnerAuthRetentionBatchSize("1")).toBe(1);
    expect(parsePartnerAuthRetentionBatchSize(5_000)).toBe(5_000);
    expect(parsePartnerAuthRetentionBatchSize(0)).toBe(
      DEFAULT_PARTNER_AUTH_RETENTION_BATCH_SIZE,
    );
    expect(parsePartnerAuthRetentionBatchSize("5001")).toBe(
      DEFAULT_PARTNER_AUTH_RETENTION_BATCH_SIZE,
    );
  });

  it("returns only validated counts and detects another full batch", async () => {
    let executeCalls = 0;
    const execute = (_query: unknown): Promise<unknown> => {
      executeCalls += 1;
      return Promise.resolve([
        {
          challenges_expired: 2,
          challenges_sanitized: 1,
          applicant_sessions_sanitized: 0,
          auth_transactions_deleted: 5,
          sessions_sanitized: 3,
          login_tokens_deleted: 4,
        },
      ]);
    };
    const database = { execute } as unknown as DatabaseClient;
    await expect(
      prunePartnerAuthenticationMetadata({
        now: new Date("2026-09-02T12:00:00.000Z"),
        limit: 5,
        database,
      }),
    ).resolves.toEqual({
      retentionDays: 90,
      prunedAt: "2026-09-02T12:00:00.000Z",
      challengesExpired: 2,
      challengesSanitized: 1,
      applicantSessionsSanitized: 0,
      authTransactionsDeleted: 5,
      sessionsSanitized: 3,
      loginTokensDeleted: 4,
      batchMayHaveMore: true,
    });
    expect(executeCalls).toBe(1);
  });

  it("fails closed when the database procedure returns an invalid count", async () => {
    const execute = (_query: unknown): Promise<unknown> =>
      Promise.resolve([
        {
          challenges_expired: -1,
          challenges_sanitized: 0,
          applicant_sessions_sanitized: 0,
          auth_transactions_deleted: 0,
          sessions_sanitized: 0,
          login_tokens_deleted: 0,
        },
      ]);
    const database = { execute } as unknown as DatabaseClient;
    await expect(
      prunePartnerAuthenticationMetadata({ database }),
    ).rejects.toThrow("challenges_expired");
  });

  it("keeps business/audit evidence and sanitizes only terminal auth detail", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "src/db/migrations/0156_partner_account_lifecycle_and_auth_retention.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("interval '90 days'");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("partner_auth_challenges");
    expect(migration).toContain("partner_applicant_sessions");
    expect(migration).toContain("partner_auth_transactions");
    expect(migration).toContain("partner_sessions");
    expect(migration).toContain("partner_login_tokens");
    expect(migration).not.toContain('DELETE FROM "partner_users"');
    expect(migration).not.toContain('DELETE FROM "partner_accounts"');
    expect(migration).not.toContain('DELETE FROM "audit_logs"');
  });
});
