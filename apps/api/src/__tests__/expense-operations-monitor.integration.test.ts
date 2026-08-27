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

    expect(monitor.schemaVersion).toBe(1);
    expect(monitor.timezone).toBe("America/New_York");
    expect(monitor.window).toMatchObject({
      lookbackDays: 30,
      overviewWeeks: 2,
    });
    expect(monitor.receipts.latencyMs.measurement).toBe(
      "uploaded_to_analysis_completed",
    );
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
    ]) {
      expect(serialized).not.toContain(sensitiveField);
    }
  });
});
