import { closeDbForTests, getDb } from "@/db";
import { readExpenseOperationsMonitor } from "@/lib/expense-operations-monitor";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

describeOrSkip("expense operations monitor database integration", () => {
  afterAll(async () => {
    await closeDbForTests();
  });

  it("executes the production aggregate queries without exposing receipt contents", async () => {
    const monitor = await readExpenseOperationsMonitor(
      getDb(),
      { lookbackDays: 30, overviewWeeks: 2 },
      { now: new Date("2026-08-27T14:00:00.000Z") },
    );

    expect(monitor.schemaVersion).toBe(2);
    expect(monitor.timezone).toBe("America/New_York");
    expect(monitor.window).toMatchObject({
      lookbackDays: 30,
      overviewWeeks: 2,
    });
    expect(monitor.receipts.latencyMs.measurement).toBe(
      "uploaded_to_analysis_completed",
    );
    expect(monitor.receipts.clientQueue).toMatchObject({
      source: "client_reported_metadata",
      freshness: {
        basis: "server_received_at",
        windowMinutes: 15,
        freshAfter: "2026-08-27T13:45:00.000Z",
      },
    });
    for (const value of [
      monitor.receipts.clientQueue.current.reportCount,
      monitor.receipts.clientQueue.current.deviceCount,
      monitor.receipts.clientQueue.current.queuedCount,
      monitor.receipts.clientQueue.current.failedCount,
      monitor.receipts.clientQueue.stale.reportCount,
      monitor.receipts.clientQueue.stale.deviceCount,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    for (const status of [
      "pending_upload",
      "queued",
      "analyzing",
      "failed",
    ] as const) {
      expect(Number.isInteger(monitor.receipts.statusCounts[status])).toBe(
        true,
      );
    }
    expect(monitor.advertising.yesterdayBusinessDate).toBe("2026-08-26");

    const serialized = JSON.stringify(monitor);
    for (const sensitiveField of [
      "filename",
      "originalObjectKey",
      "normalizedObjectKey",
      "sha256",
      "extraction",
      "analysisWarnings",
      "failureMessage",
      "paymentLastFour",
      "vendor",
      "teamMemberId",
      "clientDeviceId",
    ]) {
      expect(serialized).not.toContain(sensitiveField);
    }
  });
});
