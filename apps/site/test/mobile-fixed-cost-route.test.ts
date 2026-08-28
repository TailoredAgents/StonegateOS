import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));

void test("mobile fixed-cost proxies stay owner-only and preserve mutation methods", async () => {
  const [collection, series, proxy] = await Promise.all([
    readFile(
      `${siteRoot}/src/app/api/mobile/expenses/fixed-costs/route.ts`,
      "utf8",
    ),
    readFile(
      `${siteRoot}/src/app/api/mobile/expenses/fixed-costs/[seriesId]/route.ts`,
      "utf8",
    ),
    readFile(
      `${siteRoot}/src/app/api/mobile/expenses/lib/expense-proxy.ts`,
      "utf8",
    ),
  ]);

  assert.match(collection, /permission: "expenses\.approve"/u);
  assert.match(collection, /export async function GET/u);
  assert.match(collection, /export async function POST/u);
  assert.match(collection, /method: "POST"/u);
  assert.match(collection, /\/api\/admin\/expenses\/fixed-costs/u);
  assert.match(collection, /searchParams\.getAll\("asOf"\)/u);
  assert.match(collection, /invalid_as_of_date/u);
  assert.match(
    collection,
    /fixed-costs\?asOf=\$\{encodeURIComponent\(value\)\}/u,
  );
  assert.match(series, /export async function PATCH/u);
  assert.match(series, /method: "PATCH"/u);
  assert.match(series, /permission: "expenses\.approve"/u);
  assert.match(series, /encodeExpenseRouteId\(seriesId\)/u);
  assert.match(proxy, /"idempotency-key"/u);
  assert.match(proxy, /"if-match"/u);
  assert.match(proxy, /"Cache-Control": "private, no-store"/u);
});

void test("mobile fixed-cost forms send idempotent version-bound revisions", async () => {
  const [component, spend, donut] = await Promise.all([
    readFile(`${siteRoot}/src/app/mobile/MobileFixedCosts.tsx`, "utf8"),
    readFile(`${siteRoot}/src/app/mobile/MobileSpendV2.tsx`, "utf8"),
    readFile(`${siteRoot}/src/app/mobile/MobileExpenseDonut.tsx`, "utf8"),
  ]);

  assert.match(component, /getExpenseMutationAttempt/u);
  assert.match(component, /acknowledgeExpenseMutationAttempt/u);
  assert.match(component, /"Idempotency-Key": attempt\.idempotencyKey/u);
  assert.match(component, /"If-Match": String\(input\.version\)/u);
  assert.match(component, /action: "revise"/u);
  assert.match(component, /action: "end"/u);
  assert.match(component, /expectedVersion: mode\.cost\.version/u);
  assert.match(
    component,
    /link it to this fixed cost under More details[\s\S]*counted once/u,
  );
  assert.match(component, /min-h-11/u);
  assert.match(component, /aria-live="polite"/u);
  assert.match(donut, /motion-reduce:transition-none/u);
  assert.match(donut, /aria-hidden="true"/u);
  assert.match(
    spend,
    /canApprove && canViewOverview && capabilities\?\.fixedCosts === true/u,
  );
  assert.equal((spend.match(/id: "scan"/gu) ?? []).length, 1);
  assert.equal((spend.match(/id: "ads"/gu) ?? []).length, 1);
  assert.equal((spend.match(/id: "manual"/gu) ?? []).length, 1);
});

void test("desktop corrections can preserve or explicitly clear fixed-cost coverage", async () => {
  const [formUtils, correctionRoute, expensesSection] = await Promise.all([
    readFile(`${siteRoot}/src/app/api/team/expenses/form-utils.ts`, "utf8"),
    readFile(
      `${siteRoot}/src/app/api/team/expenses/[expenseId]/correct/route.ts`,
      "utf8",
    ),
    readFile(`${siteRoot}/src/app/team/components/ExpensesSection.tsx`, "utf8"),
  ]);

  assert.match(formUtils, /includeFixedCostCoverage\?: boolean/u);
  assert.match(
    formUtils,
    /body\.set\("coveredByFixedCostSeriesId", seriesId\)/u,
  );
  assert.match(correctionRoute, /includeFixedCostCoverage: true/u);
  assert.match(expensesSection, /Overview treatment/u);
  assert.match(expensesSection, /Count the replacement separately/u);
});
