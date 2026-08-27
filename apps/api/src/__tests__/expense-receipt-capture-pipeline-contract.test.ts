import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

describe("expense receipt capture pipeline contract", () => {
  it("queues analysis during finalization and never posts an expense", () => {
    const service = read("apps/api/src/lib/expense-receipt-captures.ts");
    expect(service).toContain('type: "expense.receipt.analyze"');
    expect(service).toContain("requiresHumanConfirmation: true");
    expect(service).not.toMatch(/insert\(expenses\)/u);
    expect(service).not.toContain("postExpense");
  });

  it("runs receipt analysis only in the durable outbox worker", () => {
    const outbox = read("apps/api/src/lib/outbox-processor.ts");
    const finalizeRoute = read(
      "apps/api/app/api/admin/expenses/captures/[captureId]/finalize/route.ts",
    );
    expect(outbox).toContain('case "expense.receipt.analyze"');
    expect(outbox).toContain("processExpenseReceiptAnalysisOutbox");
    expect(finalizeRoute).not.toContain("extractExpenseReceiptWithOpenAi");
    expect(finalizeRoute).toContain("queuedAsynchronously");
  });

  it("keeps originals private and status responses reference an authenticated path", () => {
    const service = read("apps/api/src/lib/expense-receipt-captures.ts");
    expect(service).toContain("createMediaUploadUrl");
    expect(service).toContain("createMediaReadUrl");
    expect(service).not.toContain("dataUrl");
    expect(service).toContain(
      "/api/admin/expenses/captures/${capture.id}/content",
    );
  });
});
