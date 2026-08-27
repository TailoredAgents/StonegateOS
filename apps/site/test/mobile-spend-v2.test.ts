import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileSpendV2 } from "../src/app/mobile/MobileSpendV2";
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

void test("Spend V2 keeps the locked navigation and offline-store contracts", async () => {
  const [component, session, offlineMedia, worker] = await Promise.all([
    readFile(`${siteRoot}/src/app/mobile/MobileSpendV2.tsx`, "utf8"),
    readFile(`${siteRoot}/src/app/mobile/lib/session.ts`, "utf8"),
    readFile(`${siteRoot}/src/app/mobile/lib/offline-media.ts`, "utf8"),
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
  assert.doesNotMatch(component, /pie chart/iu);
  assert.match(session, /"expenses\.submit"/u);
  assert.match(session, /"expenses\.approve"/u);
  assert.doesNotMatch(session, /"expenses\.write"/u);
  assert.match(offlineMedia, /DATABASE_VERSION = 4/u);
  assert.match(offlineMedia, /appointment-snapshots/u);
  assert.match(offlineMedia, /media-upload-queue/u);
  assert.match(offlineMedia, /expense-capture-queue/u);
  assert.match(worker, /stonegate-expense-receipts/u);
  assert.match(worker, /stonegate-media-sync/u);
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
