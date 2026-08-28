import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createKeyedSingleFlight } from "../src/app/mobile/lib/expense-capture-queue";

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

void test("same-key concurrent operations share one in-flight promise", async () => {
  const runSingleFlight = createKeyedSingleFlight<string, string>();
  const gate = deferred<string>();
  let operationCount = 0;

  const first = runSingleFlight("capture-a", () => {
    operationCount += 1;
    return gate.promise;
  });
  const second = runSingleFlight("capture-a", () => {
    operationCount += 1;
    return Promise.resolve("duplicate-operation");
  });

  assert.strictEqual(second, first);
  await Promise.resolve();
  assert.equal(operationCount, 1);

  gate.resolve("acknowledged");
  assert.deepEqual(await Promise.all([first, second]), [
    "acknowledged",
    "acknowledged",
  ]);
  assert.equal(operationCount, 1);
});

void test("a failed operation releases its key for a later retry", async () => {
  const runSingleFlight = createKeyedSingleFlight<string, string>();
  let operationCount = 0;

  await assert.rejects(
    runSingleFlight("capture-a", () => {
      operationCount += 1;
      return Promise.reject(new Error("receipt-sync-failed"));
    }),
    /receipt-sync-failed/u,
  );

  const retried = await runSingleFlight("capture-a", () => {
    operationCount += 1;
    return Promise.resolve("retried");
  });
  assert.equal(retried, "retried");
  assert.equal(operationCount, 2);
});

void test("different keys remain independent", async () => {
  const runSingleFlight = createKeyedSingleFlight<string, string>();
  const firstGate = deferred<string>();
  const secondGate = deferred<string>();
  const started: string[] = [];

  const first = runSingleFlight("capture-a", () => {
    started.push("capture-a");
    return firstGate.promise;
  });
  const second = runSingleFlight("capture-b", () => {
    started.push("capture-b");
    return secondGate.promise;
  });

  assert.notStrictEqual(second, first);
  await Promise.resolve();
  assert.deepEqual(started.sort(), ["capture-a", "capture-b"]);

  secondGate.resolve("second");
  assert.equal(await second, "second");
  firstGate.resolve("first");
  assert.equal(await first, "first");
});

void test("capture and employee receipt sync paths both use keyed single-flight", async () => {
  const source = await readFile(
    new URL("../src/app/mobile/lib/expense-capture-queue.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const runCaptureSyncSingleFlight = createKeyedSingleFlight<[\s\S]*?>\(\);/u,
  );
  assert.match(
    source,
    /const runEmployeeSyncSingleFlight = createKeyedSingleFlight<string, void>\(\);/u,
  );
  assert.match(
    source,
    /export function syncExpenseCapture\([\s\S]*?return runCaptureSyncSingleFlight\(clientCaptureId,/u,
  );
  assert.match(
    source,
    /export function syncEmployeeExpenseCaptures\([\s\S]*?return runEmployeeSyncSingleFlight\(employeeId,/u,
  );
});

void test("background sync registration cannot block foreground receipt sync", async () => {
  const source = await readFile(
    new URL("../src/app/mobile/lib/expense-capture-queue.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /await writeRow\(queued\);\s+void registerExpenseBackgroundSync\(\);\s+return queued;/u,
  );
  assert.match(source, /SERVICE_WORKER_READY_TIMEOUT_MS/u);
  assert.doesNotMatch(source, /await registerExpenseBackgroundSync\(\)/u);
});

void test("the Spend surface has a local recovery boundary", async () => {
  const [page, boundary] = await Promise.all([
    readFile(new URL("../src/app/mobile/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../src/app/mobile/MobileSpendErrorBoundary.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(
    page,
    /<MobileSpendErrorBoundary>\s*<MobileSpendV2[\s\S]*?<\/MobileSpendErrorBoundary>/u,
  );
  assert.match(boundary, /role="alert"/u);
  assert.match(boundary, /The rest of the CRM is still available/u);
  assert.match(boundary, /Try Spend again/u);
});
