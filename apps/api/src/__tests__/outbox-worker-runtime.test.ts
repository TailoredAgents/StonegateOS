import fs from "node:fs";
import path from "node:path";
import {
  formatOutboxWorkerLog,
  OutboxWorkerConfigurationError,
  outboxWorkerErrorDetail,
  parseOutboxWorkerConfiguration,
  shouldLogOutboxBatch,
  startOutboxWorkerHeartbeat,
} from "@/lib/outbox-worker-runtime";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

describe("outbox worker runtime", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

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

  it("records heartbeats on an independent interval without overlapping writes", async () => {
    jest.useFakeTimers();
    let finishFirstWrite: (() => void) | null = null;
    const record = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstWrite = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const onError = jest.fn();
    const heartbeat = startOutboxWorkerHeartbeat({
      intervalMs: 5_000,
      record,
      onError,
    });

    await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(record).toHaveBeenCalledTimes(1);

    finishFirstWrite?.();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(record).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();

    await heartbeat.stop();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("handles heartbeat write and error-handler failures without leaking rejections", async () => {
    jest.useFakeTimers();
    const heartbeat = startOutboxWorkerHeartbeat({
      intervalMs: 5_000,
      record: jest.fn().mockRejectedValue(new Error("database unavailable")),
      onError: () => {
        throw new Error("logger unavailable");
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    await heartbeat.stop();
  });

  it("wires the worker to activity-only batch logs and independent heartbeats", () => {
    const worker = fs.readFileSync(
      path.resolve(REPO_ROOT, "scripts/outbox-worker.ts"),
      "utf8",
    );

    expect(worker).toContain("shouldLogOutboxBatch(stats)");
    expect(worker).toContain("startOutboxWorkerHeartbeat({");
    expect(worker).toContain("await heartbeat.stop()");
    expect(worker).not.toContain("recordHeartbeatIfDue");
    expect(worker).toContain('"outbox.worker.started"');
    expect(worker).toContain('"outbox.worker.heartbeat"');
    expect(worker).toContain('"outbox.worker.failed"');
    expect(worker).not.toContain(
      "JSON.stringify({ ok: true, ...stats }, null, 2)",
    );
    expect(worker).not.toContain("JSON.stringify(");
  });
});
