import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileSpendV2 } from "../src/app/mobile/MobileSpendV2";
import {
  expenseCaptureQueueStatus,
  shouldPollExpenseCaptureStatus,
} from "../src/app/mobile/lib/expense-capture-queue";
import {
  acknowledgeExpenseMutationAttempt,
  canonicalExpenseMutationPayload,
  getExpenseMutationAttempt,
  type ExpenseMutationGenerationStore,
} from "../src/app/mobile/lib/expense-mutation-idempotency";
import {
  addDateKeyDays,
  easternDateKey,
  expenseAllocationTotal,
  expenseReceiptContentType,
  mondayForDateKey,
  moneyInputToCents,
} from "../src/app/mobile/spend-v2-utils";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));

void test("money input remains exact in integer cents", () => {
  assert.equal(moneyInputToCents("$1,234.56"), 123_456);
  assert.equal(moneyInputToCents("0"), 0);
  assert.equal(moneyInputToCents("12.3"), 1_230);
  assert.equal(moneyInputToCents("12.345"), null);
  assert.equal(moneyInputToCents("-1.00"), null);
  assert.equal(moneyInputToCents("1000000.01"), null);
});

void test("Eastern business dates survive both DST transitions", () => {
  assert.equal(
    easternDateKey(new Date("2026-03-08T04:59:00.000Z")),
    "2026-03-07",
  );
  assert.equal(
    easternDateKey(new Date("2026-03-08T05:01:00.000Z")),
    "2026-03-08",
  );
  assert.equal(
    easternDateKey(new Date("2026-11-01T03:59:00.000Z")),
    "2026-10-31",
  );
  assert.equal(
    easternDateKey(new Date("2026-11-01T04:01:00.000Z")),
    "2026-11-01",
  );
});

void test("week controls always normalize to Monday through Sunday", () => {
  assert.equal(mondayForDateKey("2026-08-27"), "2026-08-24");
  assert.equal(mondayForDateKey("2026-08-30"), "2026-08-24");
  assert.equal(addDateKeyDays("2026-08-24", 6), "2026-08-30");
  assert.equal(addDateKeyDays("2026-08-24", -7), "2026-08-17");
});

void test("allocation totals surface incomplete rows instead of rounding", () => {
  assert.equal(
    expenseAllocationTotal([{ amountCents: 1_001 }, { amountCents: 999 }]),
    2_000,
  );
  assert.equal(
    expenseAllocationTotal([{ amountCents: 1_001 }, { amountCents: null }]),
    null,
  );
});

void test("receipt type inference supports camera and plan-approved file types", () => {
  assert.equal(
    expenseReceiptContentType({ name: "receipt.HEIC", type: "" }),
    "image/heic",
  );
  assert.equal(
    expenseReceiptContentType({ name: "receipt.pdf", type: "application/pdf" }),
    "application/pdf",
  );
  assert.equal(
    expenseReceiptContentType({ name: "receipt.gif", type: "image/gif" }),
    null,
  );
});

class MemoryMutationGenerationStore implements ExpenseMutationGenerationStore {
  readonly generations = new Map<string, number>();

  constructor(private readonly deviceId = "test-device-00000001") {}

  getOrCreateDeviceId(): Promise<string> {
    return Promise.resolve(this.deviceId);
  }

  getOrCreateGeneration(stateKey: string): Promise<number> {
    const generation = this.generations.get(stateKey) ?? 0;
    this.generations.set(stateKey, generation);
    return Promise.resolve(generation);
  }

  advanceGeneration(
    stateKey: string,
    expectedGeneration: number,
  ): Promise<void> {
    const current = this.generations.get(stateKey) ?? 0;
    if (current === expectedGeneration) {
      this.generations.set(stateKey, current + 1);
    }
    return Promise.resolve();
  }
}

void test("expense mutation keys survive reload ambiguity and rotate safely", async () => {
  const store = new MemoryMutationGenerationStore();
  const first = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  const afterReload = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { notes: null, vendor: "Acme", amountCents: 1_234 },
    },
    store,
  );
  assert.equal(afterReload.idempotencyKey, first.idempotencyKey);
  assert.equal(afterReload.fingerprintHash, first.fingerprintHash);
  assert.match(first.idempotencyKey, /^expense-v1-[0-9a-f]{64}$/u);

  const changedPayload = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_235, vendor: "Acme", notes: null },
    },
    store,
  );
  const changedEmployee = await getExpenseMutationAttempt(
    {
      employeeId: "employee-b",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  assert.notEqual(changedPayload.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changedEmployee.idempotencyKey, first.idempotencyKey);

  await acknowledgeExpenseMutationAttempt(first, store);
  const afterSuccess = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  assert.notEqual(afterSuccess.idempotencyKey, first.idempotencyKey);
  assert.equal(afterSuccess.generation, 1);

  await acknowledgeExpenseMutationAttempt(first, store);
  const afterStaleAcknowledgement = await getExpenseMutationAttempt(
    {
      employeeId: "employee-a",
      operation: "manual-expense-submit",
      payload: { amountCents: 1_234, vendor: "Acme", notes: null },
    },
    store,
  );
  assert.equal(
    afterStaleAcknowledgement.idempotencyKey,
    afterSuccess.idempotencyKey,
  );
});

void test("expense payload fingerprints are canonical and reject unsafe values", () => {
  assert.equal(
    canonicalExpenseMutationPayload({ z: 2, a: { y: 1, x: true } }),
    '{"a":{"x":true,"y":1},"z":2}',
  );
  assert.throws(
    () => canonicalExpenseMutationPayload({ amount: Number.NaN }),
    /finite/u,
  );
  assert.throws(
    () => canonicalExpenseMutationPayload({ date: new Date(0) }),
    /plain objects/u,
  );
});

void test("confirmed captures are terminal while failed analysis remains tracked", () => {
  assert.equal(expenseCaptureQueueStatus("confirmed"), "confirmed");
  assert.equal(expenseCaptureQueueStatus("discarded"), "discarded");
  assert.equal(expenseCaptureQueueStatus("ready"), "ready");
  assert.equal(expenseCaptureQueueStatus("failed"), "failed");
  assert.equal(expenseCaptureQueueStatus("analyzing"), "processing");
  assert.equal(shouldPollExpenseCaptureStatus("failed"), true);
  assert.equal(shouldPollExpenseCaptureStatus("processing"), true);
  assert.equal(shouldPollExpenseCaptureStatus("confirmed"), false);
  assert.equal(shouldPollExpenseCaptureStatus("discarded"), false);
});

void test("Spend V2 keeps the locked navigation and offline-store contracts", async () => {
  const [component, session, offlineMedia, mutationKeys, worker] =
    await Promise.all([
      readFile(`${siteRoot}/src/app/mobile/MobileSpendV2.tsx`, "utf8"),
      readFile(`${siteRoot}/src/app/mobile/lib/session.ts`, "utf8"),
      readFile(`${siteRoot}/src/app/mobile/lib/offline-media.ts`, "utf8"),
      readFile(
        `${siteRoot}/src/app/mobile/lib/expense-mutation-idempotency.ts`,
        "utf8",
      ),
      readFile(`${siteRoot}/public/mobile-sw.js`, "utf8"),
    ]);

  assert.match(component, /\["add", "overview", "history"\]/u);
  assert.match(component, /id: "scan" as const/u);
  assert.match(component, /id: "ads" as const/u);
  assert.match(component, /id: "manual" as const/u);
  assert.match(component, /Waiting to sync/u);
  assert.match(component, /aria-live="polite"/u);
  assert.match(component, /role="tablist"/u);
  assert.match(component, /role="tab"/u);
  assert.match(component, /aria-selected=/u);
  assert.match(component, /focus-visible:ring-2/u);
  assert.match(component, /min-h-11/u);
  assert.match(component, /Submit for approval/u);
  assert.match(component, /Reimbursement/u);
  assert.match(component, /getExpenseMutationAttempt/u);
  assert.match(component, /acknowledgeExpenseMutationAttempt/u);
  assert.doesNotMatch(component, /mutationKeyForPayload/u);
  assert.match(component, /overrideReason\.trim\(\)\.length < 10/u);
  assert.match(component, /minLength=\{10\}/u);
  assert.match(component, /It remains safely stored/u);
  assert.match(component, /refreshExpenseCapture/u);
  assert.match(component, /vendorPrimary\?: boolean/u);
  assert.match(component, /vendorPrimary = false,/u);
  assert.match(component, /\{vendorPrimary \? vendorField : null\}/u);
  assert.match(component, /\{vendorPrimary \? null : vendorField\}/u);
  assert.match(
    component,
    /attentionFields=\{extracted\.attention\}\s+vendorPrimary\s+duplicateRisk=/u,
  );
  assert.match(
    component,
    /const vendorField = \([\s\S]*?attentionFields\.includes\("vendor"\) \? <AttentionBadge \/> : null/u,
  );
  assert.doesNotMatch(component, /pie chart/iu);
  assert.match(session, /"expenses\.submit"/u);
  assert.match(session, /"expenses\.approve"/u);
  assert.doesNotMatch(session, /"expenses\.write"/u);
  assert.match(offlineMedia, /DATABASE_VERSION = 4/u);
  assert.match(offlineMedia, /appointment-snapshots/u);
  assert.match(offlineMedia, /media-upload-queue/u);
  assert.match(offlineMedia, /expense-capture-queue/u);
  assert.match(mutationKeys, /expense-mutation:v1:/u);
  assert.match(mutationKeys, /advanceGeneration/u);
  assert.match(worker, /stonegate-expense-receipts/u);
  assert.match(worker, /stonegate-media-sync/u);
  assert.match(worker, /capture\?\.status === "confirmed"/u);
});

void test("the initial mobile surface exposes three focused Add choices", () => {
  const html = renderToStaticMarkup(
    createElement(MobileSpendV2, {
      employee: { id: "11111111-1111-4111-8111-111111111111", name: "Crew" },
      canSubmit: true,
      canApprove: false,
      canViewOverview: false,
      canWriteAdSpend: false,
      members: [],
      jobs: [],
    }),
  );

  assert.match(html, />Add</u);
  assert.match(html, />Overview</u);
  assert.match(html, />History</u);
  assert.match(html, /Scan receipt/u);
  assert.match(html, /Daily ad spend/u);
  assert.match(html, /Manual entry/u);
  assert.match(html, /Overview, owner only/u);
  assert.doesNotMatch(html, /Recent expenses/u);
});
