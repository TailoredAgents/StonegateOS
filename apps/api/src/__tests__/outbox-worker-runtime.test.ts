import fs from "node:fs";
import path from "node:path";
import {
  formatOutboxWorkerLog,
  OutboxWorkerConfigurationError,
  outboxWorkerErrorDetail,
  parseOutboxWorkerConfiguration,
  shouldLogOutboxBatch,
} from "@/lib/outbox-worker-runtime";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

describe("outbox worker runtime", () => {
  it("uses bounded defaults and supports the explicit one-shot mode", () => {
    expect(parseOutboxWorkerConfiguration({})).toEqual({
      batchSize: 10,
      pollIntervalMs: 0,
      heartbeatIntervalMs: 30_000,
    });
  });

  it("accepts bounded continuous-worker configuration", () => {
    expect(
      parseOutboxWorkerConfiguration({
        OUTBOX_BATCH_SIZE: " 100 ",
        OUTBOX_POLL_INTERVAL_MS: "250",
        OUTBOX_HEARTBEAT_INTERVAL_MS: "60000",
      }),
    ).toEqual({
      batchSize: 100,
      pollIntervalMs: 250,
      heartbeatIntervalMs: 60_000,
    });
  });

  it.each([
    ["OUTBOX_BATCH_SIZE", ""],
    ["OUTBOX_BATCH_SIZE", "0"],
    ["OUTBOX_BATCH_SIZE", "101"],
    ["OUTBOX_BATCH_SIZE", "1.5"],
    ["OUTBOX_BATCH_SIZE", "-1"],
    ["OUTBOX_BATCH_SIZE", "Infinity"],
    ["OUTBOX_POLL_INTERVAL_MS", ""],
    ["OUTBOX_POLL_INTERVAL_MS", "249"],
    ["OUTBOX_POLL_INTERVAL_MS", "30001"],
    ["OUTBOX_POLL_INTERVAL_MS", "0.5"],
    ["OUTBOX_POLL_INTERVAL_MS", "-1"],
    ["OUTBOX_HEARTBEAT_INTERVAL_MS", "4999"],
    ["OUTBOX_HEARTBEAT_INTERVAL_MS", "60001"],
    ["OUTBOX_HEARTBEAT_INTERVAL_MS", "NaN"],
  ])("fails closed for invalid %s=%s", (variableName, value) => {
    expect(() =>
      parseOutboxWorkerConfiguration({ [variableName]: value }),
    ).toThrow(OutboxWorkerConfigurationError);
  });

  it("suppresses idle batch summaries but preserves all activity and error summaries", () => {
    expect(
      shouldLogOutboxBatch({
        total: 0,
        processed: 0,
        skipped: 0,
        errors: 0,
      }),
    ).toBe(false);
    expect(
      shouldLogOutboxBatch({
        total: 1,
        processed: 1,
        skipped: 0,
        errors: 0,
      }),
    ).toBe(true);
    expect(
      shouldLogOutboxBatch({
        total: 0,
        processed: 0,
        skipped: 0,
        errors: 1,
      }),
    ).toBe(true);
  });

  it("emits compact structured records with an exact timestamp", () => {
    const output = formatOutboxWorkerLog(
      "outbox.worker.heartbeat",
      { ok: true },
      new Date("2026-08-09T12:34:56.000Z"),
    );

    expect(output).not.toContain("\n");
    expect(JSON.parse(output)).toEqual({
      event: "outbox.worker.heartbeat",
      at: "2026-08-09T12:34:56.000Z",
      ok: true,
    });
  });

  it("bounds fatal error details before they reach readiness or logs", () => {
    const detail = outboxWorkerErrorDetail(new Error("x".repeat(1_000)));
    expect(detail).toHaveLength(500);
    expect(detail).toBe("x".repeat(500));
  });

  it("wires the worker to activity-only batch logs and rate-limited heartbeats", () => {
    const worker = fs.readFileSync(
      path.resolve(REPO_ROOT, "scripts/outbox-worker.ts"),
      "utf8",
    );

    expect(worker).toContain("shouldLogOutboxBatch(stats)");
    expect(worker).toContain("Date.now() < nextHeartbeatAt");
    expect(worker).toContain(
      "nextHeartbeatAt = Date.now() + heartbeatIntervalMs",
    );
    expect(worker.match(/await recordHeartbeatIfDue\(\)/gu)).toHaveLength(2);
    expect(worker).toContain('"outbox.worker.started"');
    expect(worker).toContain('"outbox.worker.heartbeat"');
    expect(worker).toContain('"outbox.worker.failed"');
    expect(worker).not.toContain(
      "JSON.stringify({ ok: true, ...stats }, null, 2)",
    );
    expect(worker).not.toContain("JSON.stringify(");
  });
});
