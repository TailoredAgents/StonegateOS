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

  it("makes both initial and retry receipt upload intents write-once", () => {
    const service = read("apps/api/src/lib/expense-receipt-captures.ts");
    const intentStart = service.indexOf(
      "export async function createExpenseReceiptUploadIntent",
    );
    const duplicateLookupStart = service.indexOf(
      "async function firstExactDuplicateCapture",
    );
    const uploadIntent = service.slice(intentStart, duplicateLookupStart);

    expect(intentStart).toBeGreaterThan(0);
    expect(duplicateLookupStart).toBeGreaterThan(intentStart);
    expect(uploadIntent.match(/createMediaUploadUrl\(\{/gu)).toHaveLength(2);
    expect(uploadIntent.match(/writeOnce: true/gu)).toHaveLength(2);
    expect(service).toContain("putImmutableMediaObject");
  });

  it("enforces the owner-only pilot at both discovery and upload boundaries", () => {
    const capabilities = read(
      "apps/api/app/api/admin/expenses/capabilities/route.ts",
    );
    const captureCollection = read(
      "apps/api/app/api/admin/expenses/captures/route.ts",
    );
    expect(capabilities).toContain("canUseExpenseReceiptCapture(canApprove)");
    expect(captureCollection).toContain(
      "canUseExpenseReceiptCapture(canApprove)",
    );
    expect(
      captureCollection.indexOf("canUseExpenseReceiptCapture(canApprove)"),
    ).toBeLessThan(
      captureCollection.indexOf("createExpenseReceiptUploadIntent({"),
    );
  });

  it("keeps authorized captured evidence readable when intake flags are disabled", () => {
    const service = read("apps/api/src/lib/expense-receipt-captures.ts");
    const statusStart = service.indexOf(
      "export async function getExpenseReceiptCaptureStatus",
    );
    const discardStart = service.indexOf(
      "export async function discardExpenseReceiptCapture",
    );
    const contentStart = service.indexOf(
      "export async function getExpenseReceiptCaptureContentUrl",
    );
    const storedExtractionStart = service.indexOf("type StoredExtraction");

    expect(statusStart).toBeGreaterThan(0);
    expect(discardStart).toBeGreaterThan(statusStart);
    expect(contentStart).toBeGreaterThan(discardStart);
    expect(storedExtractionStart).toBeGreaterThan(contentStart);
    expect(service.slice(statusStart, discardStart)).not.toContain(
      "assertReceiptFeatureEnabled",
    );
    expect(service.slice(discardStart, contentStart)).not.toContain(
      "assertReceiptFeatureEnabled",
    );
    expect(service.slice(contentStart, storedExtractionStart)).not.toContain(
      "assertReceiptFeatureEnabled",
    );
  });
});
