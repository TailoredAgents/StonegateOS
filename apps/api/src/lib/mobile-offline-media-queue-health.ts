import { z } from "zod";

export const MAX_OFFLINE_MEDIA_QUEUE_COUNT = 10_000;
export const MAX_OFFLINE_MEDIA_HEALTH_PAYLOAD_BYTES = 2_048;

const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_REPORT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MIN_QUEUE_TIMESTAMP_MS = Date.parse("2020-01-01T00:00:00.000Z");

const RawQueueHealthSchema = z
  .object({
    deviceId: z.string().uuid(),
    queuedCount: z.number().int().min(0).max(MAX_OFFLINE_MEDIA_QUEUE_COUNT),
    failedCount: z.number().int().min(0).max(MAX_OFFLINE_MEDIA_QUEUE_COUNT),
    oldestQueuedAt: z.string().datetime({ offset: true }).nullable(),
    reportedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type MobileOfflineMediaQueueHealthReport = {
  deviceId: string;
  queuedCount: number;
  failedCount: number;
  oldestQueuedAt: Date | null;
  reportedAt: Date;
};

export type MobileOfflineMediaQueueHealthValidationResult =
  | {
      ok: true;
      report: MobileOfflineMediaQueueHealthReport;
    }
  | {
      ok: false;
      issues: Array<{
        field: string;
        code: string;
        message: string;
      }>;
    };

function issue(
  field: string,
  code: string,
  message: string,
): MobileOfflineMediaQueueHealthValidationResult {
  return {
    ok: false,
    issues: [{ field, code, message }],
  };
}

export function parseTeamMemberActorId(value: unknown): string | null {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export function parseMobileOfflineMediaQueueHealthReport(
  value: unknown,
  now = new Date(),
): MobileOfflineMediaQueueHealthValidationResult {
  const parsed = RawQueueHealthSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((entry) => ({
        field: entry.path.join(".") || "payload",
        code: entry.code,
        message: entry.message,
      })),
    };
  }

  const reportedAt = new Date(parsed.data.reportedAt);
  const oldestQueuedAt = parsed.data.oldestQueuedAt
    ? new Date(parsed.data.oldestQueuedAt)
    : null;
  const nowMs = now.getTime();
  const reportedAtMs = reportedAt.getTime();

  if (
    reportedAtMs < nowMs - MAX_REPORT_AGE_MS ||
    reportedAtMs > nowMs + MAX_CLIENT_CLOCK_SKEW_MS
  ) {
    return issue(
      "reportedAt",
      "timestamp_out_of_range",
      "reportedAt must be within the last 7 days and no more than 5 minutes in the future.",
    );
  }

  if (parsed.data.queuedCount === 0) {
    return {
      ok: true,
      report: {
        deviceId: parsed.data.deviceId.toLowerCase(),
        queuedCount: 0,
        failedCount: 0,
        oldestQueuedAt: null,
        reportedAt,
      },
    };
  }

  if (parsed.data.failedCount > parsed.data.queuedCount) {
    return issue(
      "failedCount",
      "failed_count_exceeds_queue",
      "failedCount cannot exceed queuedCount.",
    );
  }
  if (!oldestQueuedAt) {
    return issue(
      "oldestQueuedAt",
      "oldest_timestamp_required",
      "oldestQueuedAt is required when queuedCount is greater than zero.",
    );
  }
  const oldestQueuedAtMs = oldestQueuedAt.getTime();
  if (
    oldestQueuedAtMs < MIN_QUEUE_TIMESTAMP_MS ||
    oldestQueuedAtMs > reportedAtMs + MAX_CLIENT_CLOCK_SKEW_MS ||
    oldestQueuedAtMs > nowMs + MAX_CLIENT_CLOCK_SKEW_MS
  ) {
    return issue(
      "oldestQueuedAt",
      "timestamp_out_of_range",
      "oldestQueuedAt is outside the accepted queue timestamp range.",
    );
  }

  return {
    ok: true,
    report: {
      deviceId: parsed.data.deviceId.toLowerCase(),
      queuedCount: parsed.data.queuedCount,
      failedCount: parsed.data.failedCount,
      oldestQueuedAt,
      reportedAt,
    },
  };
}
