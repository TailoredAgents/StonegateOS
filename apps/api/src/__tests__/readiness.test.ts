import fs from "node:fs";
import path from "node:path";
import migrationJournal from "@/db/migrations/meta/_journal.json";
import {
  evaluateMigrationReadiness,
  evaluateOutboxQueueReadiness,
  evaluateRequiredConfiguration,
  evaluateWorkerHeartbeat,
} from "@/lib/readiness";

const API_ROOT = process.cwd();
const REPO_ROOT = path.resolve(API_ROOT, "../..");

function apiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

describe("deployment readiness", () => {
  const validConfiguration = {
    DATABASE_URL: "postgres://synthetic.invalid/db",
    ADMIN_API_KEY: "synthetic-admin-key",
    TEAM_AUTH_RATE_LIMIT_SECRET: "synthetic-rate-limit-key",
    QUOTE_RATE_LIMIT_HMAC_SECRET:
      "synthetic-quote-rate-limit-key-at-least-32-bytes",
    QUOTE_PUBLIC_PROXY_SHARED_SECRET:
      "synthetic-quote-proxy-shared-key-at-least-32-bytes",
    QUOTE_PUBLIC_TRUSTED_PROXY_HOPS: "1",
    SITE_URL: "https://site.example.test",
    TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-twilio-token",
    TWILIO_FROM: "+15555550101",
    TWILIO_API_BASE_URL: "https://api.twilio.com",
    TWILIO_WEBHOOK_PUBLIC_BASE_URL: "https://api.example.test",
  };

  it("uses the no-I/O Twilio resolver and fails malformed provider configuration", () => {
    expect(evaluateRequiredConfiguration(validConfiguration)).toEqual({
      state: "ok",
    });
    for (const override of [
      { TWILIO_ACCOUNT_SID: "ACinvalid" },
      { TWILIO_FROM: "555-0101" },
      { TWILIO_API_BASE_URL: "https://credential-sink.example" },
      {
        NODE_ENV: "production",
        E2E_RUN_ID: "partial-sentinel",
      },
    ]) {
      expect(
        evaluateRequiredConfiguration({
          ...validConfiguration,
          ...override,
        }),
      ).toMatchObject({ state: "failed" });
    }
    for (const override of [
      { QUOTE_RATE_LIMIT_HMAC_SECRET: "short" },
      { QUOTE_PUBLIC_PROXY_SHARED_SECRET: "short" },
      {
        QUOTE_PUBLIC_PROXY_SHARED_SECRET:
          validConfiguration.QUOTE_RATE_LIMIT_HMAC_SECRET,
      },
      { QUOTE_PUBLIC_TRUSTED_PROXY_HOPS: "0" },
      { QUOTE_PUBLIC_TRUSTED_PROXY_HOPS: "not-a-number" },
    ]) {
      expect(
        evaluateRequiredConfiguration({
          ...validConfiguration,
          ...override,
        }),
      ).toMatchObject({ state: "failed" });
    }
  });

  it("requires the database migration history to match the release artifact", () => {
    const entries = migrationJournal.entries;
    const latest = entries.at(-1);
    expect(latest).toBeDefined();
    if (!latest) return;

    expect(
      evaluateMigrationReadiness({
        appliedCount: entries.length,
        latestCreatedAt: latest.when,
      }),
    ).toEqual({ state: "ok", detail: latest.tag });
    expect(
      evaluateMigrationReadiness({
        appliedCount: entries.length - 1,
        latestCreatedAt: latest.when,
      }),
    ).toMatchObject({ state: "failed" });
  });

  it("fails a missing, stale, or superseded worker heartbeat", () => {
    const now = new Date("2026-08-08T12:00:00.000Z");
    expect(
      evaluateWorkerHeartbeat({
        required: false,
        lastSuccessAt: null,
        lastFailureAt: null,
        now,
        maxAgeMs: 90_000,
      }),
    ).toMatchObject({ state: "skipped" });
    expect(
      evaluateWorkerHeartbeat({
        required: true,
        lastSuccessAt: null,
        lastFailureAt: null,
        now,
        maxAgeMs: 90_000,
      }),
    ).toMatchObject({ state: "failed" });
    expect(
      evaluateWorkerHeartbeat({
        required: true,
        lastSuccessAt: new Date("2026-08-08T11:59:30.000Z"),
        lastFailureAt: null,
        now,
        maxAgeMs: 90_000,
      }),
    ).toEqual({ state: "ok" });
    expect(
      evaluateWorkerHeartbeat({
        required: true,
        lastSuccessAt: new Date("2026-08-08T11:59:30.000Z"),
        lastFailureAt: new Date("2026-08-08T11:59:45.000Z"),
        now,
        maxAgeMs: 90_000,
      }),
    ).toMatchObject({ state: "failed" });
  });

  it("fails when dispatchable work exceeds the queue age budget", () => {
    const now = new Date("2026-08-08T12:00:00.000Z");
    expect(
      evaluateOutboxQueueReadiness({
        count: 2,
        oldestDueAt: new Date("2026-08-08T11:55:00.000Z"),
        now,
        maxAgeMs: 10 * 60_000,
      }),
    ).toMatchObject({ state: "ok" });
    expect(
      evaluateOutboxQueueReadiness({
        count: 7,
        oldestDueAt: new Date("2026-08-08T11:40:00.000Z"),
        now,
        maxAgeMs: 10 * 60_000,
      }),
    ).toMatchObject({ state: "failed" });
  });

  it("measures dispatchable queue age from its effective due time", () => {
    const readiness = apiSource("src/lib/readiness.ts");

    expect(readiness).toMatch(
      /min\(\s*coalesce\(\s*\$\{outboxEvents\.nextAttemptAt\},\s*\$\{outboxEvents\.createdAt\}\s*\)\s*\)/u,
    );
    expect(readiness).toContain("oldestDueAt: queue?.oldestDueAt ?? null");
  });

  it("keeps Render health checks cheap and retains deep readiness monitoring", () => {
    const apiLiveness = apiSource("app/api/healthz/route.ts");
    const siteLiveness = repoSource("apps/site/src/app/api/healthz/route.ts");
    const apiReadiness = apiSource("app/api/readyz/route.ts");
    const siteReadiness = repoSource("apps/site/src/app/api/readyz/route.ts");
    const worker = repoSource("scripts/outbox-worker.ts");
    const render = repoSource("render.yaml");

    expect(apiLiveness).not.toContain("getDb");
    expect(siteLiveness).not.toContain("fetch(");
    expect(apiReadiness).toContain("getApiReadinessSnapshot");
    expect(apiReadiness).toContain("status: snapshot.ok ? 200 : 503");
    expect(siteReadiness).toContain("/api/readyz");
    expect(siteReadiness).toContain("status: ok ? 200 : 503");
    expect(worker).toContain("await recordAndLogWorkerHeartbeat(true)");
    expect(worker).toContain("await recordWorkerHeartbeat(");
    expect(render.match(/healthCheckPath: \/api\/healthz/gu)).toHaveLength(2);
    expect(render).not.toContain("healthCheckPath: /api/readyz");
    expect(render).toContain("READINESS_REQUIRE_OUTBOX_WORKER");
  });
});
