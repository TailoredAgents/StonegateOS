import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import migrationJournal from "@/db/migrations/meta/_journal.json";
import { getDb, outboxEvents, providerHealth } from "@/db";
import { inspectTwilioProviderConfiguration } from "@/lib/twilio-provider";
import { getTwilioWebhookPublicBaseUrl } from "@/lib/twilio-webhook-auth";

type ReadinessState = "ok" | "failed" | "skipped";

export type ReadinessCheck = {
  state: ReadinessState;
  detail?: string;
};

export type ApiReadinessSnapshot = {
  ok: boolean;
  checkedAt: string;
  checks: {
    configuration: ReadinessCheck;
    database: ReadinessCheck;
    migrations: ReadinessCheck;
    outboxWorker: ReadinessCheck;
    outboxQueue: ReadinessCheck;
  };
};

type MigrationJournalEntry = {
  idx: number;
  when: number;
  tag: string;
};

const entries = migrationJournal.entries as MigrationJournalEntry[];
const latestMigration = entries.at(-1);
const OUTBOX_WORKER_HEARTBEAT_PROVIDER = "worker:outbox";

export function evaluateMigrationReadiness(input: {
  appliedCount: number;
  latestCreatedAt: number;
}): ReadinessCheck {
  const current = entries.find(
    (entry) => entry.when === input.latestCreatedAt,
  )?.tag;
  return latestMigration &&
    input.appliedCount === entries.length &&
    input.latestCreatedAt === latestMigration.when
    ? { state: "ok", detail: latestMigration.tag }
    : {
        state: "failed",
        detail: `expected ${latestMigration?.tag ?? "unknown"}; found ${current ?? "incomplete history"}`,
      };
}

export function evaluateWorkerHeartbeat(input: {
  required: boolean;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  now: Date;
  maxAgeMs: number;
}): ReadinessCheck {
  if (!input.required) {
    return {
      state: "skipped",
      detail: "READINESS_REQUIRE_OUTBOX_WORKER is not enabled",
    };
  }
  const successAt = input.lastSuccessAt?.getTime() ?? 0;
  const failureAt = input.lastFailureAt?.getTime() ?? 0;
  const healthy =
    successAt > 0 &&
    input.now.getTime() - successAt <= input.maxAgeMs &&
    successAt >= failureAt;
  return healthy
    ? { state: "ok" }
    : {
        state: "failed",
        detail:
          successAt > 0
            ? "worker heartbeat is stale or failing"
            : "worker heartbeat is missing",
      };
}

export function evaluateOutboxQueueReadiness(input: {
  count: number;
  oldestDueAt: Date | null;
  now: Date;
  maxAgeMs: number;
}): ReadinessCheck {
  const oldestDueAt = input.oldestDueAt?.getTime() ?? 0;
  const stale =
    oldestDueAt > 0 && input.now.getTime() - oldestDueAt > input.maxAgeMs;
  return stale
    ? {
        state: "failed",
        detail: `${input.count} dispatchable event(s); oldest exceeds the readiness limit`,
      }
    : { state: "ok", detail: `${input.count} dispatchable event(s)` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return isRecord(first) ? first : null;
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true" || value?.trim() === "1";
}

export function evaluateRequiredConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadinessCheck {
  const values = [
    environment["DATABASE_URL"],
    environment["ADMIN_API_KEY"],
    environment["TEAM_AUTH_RATE_LIMIT_SECRET"],
    environment["SITE_URL"] ?? environment["NEXT_PUBLIC_SITE_URL"],
  ];
  let missingCount = values.filter((value) => !value?.trim()).length;
  const twilio = inspectTwilioProviderConfiguration(environment);
  if (!twilio.ok) missingCount += 1;
  try {
    getTwilioWebhookPublicBaseUrl(environment);
  } catch {
    missingCount += 1;
  }
  return missingCount === 0
    ? { state: "ok" }
    : {
        state: "failed",
        detail: `${missingCount} required setting${missingCount === 1 ? " is" : "s are"} missing`,
      };
}

export async function getApiReadinessSnapshot(
  now = new Date(),
): Promise<ApiReadinessSnapshot> {
  const checks: ApiReadinessSnapshot["checks"] = {
    configuration: evaluateRequiredConfiguration(),
    database: { state: "failed", detail: "database check did not run" },
    migrations: { state: "failed", detail: "migration check did not run" },
    outboxWorker: { state: "failed", detail: "worker check did not run" },
    outboxQueue: { state: "failed", detail: "queue check did not run" },
  };

  const db = getDb();
  try {
    const databaseRows = await db.execute(sql`select 1 as ready`);
    checks.database = firstRecord(databaseRows)?.["ready"]
      ? { state: "ok" }
      : { state: "failed", detail: "database returned no readiness row" };
  } catch (error) {
    checks.database = {
      state: "failed",
      detail:
        error instanceof Error
          ? error.message.slice(0, 160)
          : "database unavailable",
    };
  }

  if (checks.database.state === "ok") {
    try {
      const migrationRows = await db.execute(sql`
        select
          count(*)::int as count,
          max(created_at)::text as "latestCreatedAt"
        from drizzle.__drizzle_migrations
      `);
      const row = firstRecord(migrationRows);
      const appliedCount = Number(row?.["count"] ?? -1);
      const latestCreatedAt = Number(row?.["latestCreatedAt"] ?? -1);
      checks.migrations = evaluateMigrationReadiness({
        appliedCount,
        latestCreatedAt,
      });
    } catch (error) {
      checks.migrations = {
        state: "failed",
        detail:
          error instanceof Error
            ? error.message.slice(0, 160)
            : "migration history unavailable",
      };
    }

    const requireWorker = isEnabled(
      process.env["READINESS_REQUIRE_OUTBOX_WORKER"],
    );
    if (!requireWorker) {
      checks.outboxWorker = evaluateWorkerHeartbeat({
        required: false,
        lastSuccessAt: null,
        lastFailureAt: null,
        now,
        maxAgeMs: 90_000,
      });
    } else {
      try {
        const [worker] = await db
          .select({
            lastSuccessAt: providerHealth.lastSuccessAt,
            lastFailureAt: providerHealth.lastFailureAt,
          })
          .from(providerHealth)
          .where(eq(providerHealth.provider, OUTBOX_WORKER_HEARTBEAT_PROVIDER))
          .limit(1);
        const maxAgeMs = boundedPositiveInteger(
          process.env["READINESS_WORKER_MAX_AGE_MS"],
          90_000,
          15_000,
          15 * 60_000,
        );
        checks.outboxWorker = evaluateWorkerHeartbeat({
          required: true,
          lastSuccessAt: worker?.lastSuccessAt ?? null,
          lastFailureAt: worker?.lastFailureAt ?? null,
          now,
          maxAgeMs,
        });
      } catch (error) {
        checks.outboxWorker = {
          state: "failed",
          detail:
            error instanceof Error
              ? error.message.slice(0, 160)
              : "worker heartbeat unavailable",
        };
      }
    }

    try {
      const [queue] = await db
        .select({
          count: sql<number>`count(*)::int`.mapWith(Number),
          oldestDueAt:
            sql<Date | null>`min(coalesce(${outboxEvents.nextAttemptAt}, ${outboxEvents.createdAt}))`.mapWith(
              (value) => (value ? new Date(value as Date | string) : null),
            ),
        })
        .from(outboxEvents)
        .where(
          and(
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
            or(
              isNull(outboxEvents.nextAttemptAt),
              lte(outboxEvents.nextAttemptAt, now),
            ),
          ),
        );
      const maxQueueAgeMs = boundedPositiveInteger(
        process.env["READINESS_OUTBOX_MAX_AGE_MS"],
        10 * 60_000,
        60_000,
        24 * 60 * 60_000,
      );
      checks.outboxQueue = evaluateOutboxQueueReadiness({
        count: queue?.count ?? 0,
        oldestDueAt: queue?.oldestDueAt ?? null,
        now,
        maxAgeMs: maxQueueAgeMs,
      });
    } catch (error) {
      checks.outboxQueue = {
        state: "failed",
        detail:
          error instanceof Error
            ? error.message.slice(0, 160)
            : "outbox queue unavailable",
      };
    }
  }

  const requiredChecks = Object.values(checks).filter(
    (check) => check.state !== "skipped",
  );
  return {
    ok: requiredChecks.every((check) => check.state === "ok"),
    checkedAt: now.toISOString(),
    checks,
  };
}

export async function recordOutboxWorkerHeartbeat(input: {
  ok: boolean;
  detail?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const db = getDb();
  await db
    .insert(providerHealth)
    .values({
      provider: OUTBOX_WORKER_HEARTBEAT_PROVIDER,
      lastSuccessAt: input.ok ? now : null,
      lastFailureAt: input.ok ? null : now,
      lastFailureDetail: input.ok
        ? null
        : (input.detail ?? "worker_loop_failed").slice(0, 500),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: providerHealth.provider,
      set: input.ok
        ? {
            lastSuccessAt: now,
            lastFailureDetail: null,
            updatedAt: now,
          }
        : {
            lastFailureAt: now,
            lastFailureDetail: (input.detail ?? "worker_loop_failed").slice(
              0,
              500,
            ),
            updatedAt: now,
          },
    });
}
