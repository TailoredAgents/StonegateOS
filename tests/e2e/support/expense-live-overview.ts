import { expect, type Page } from "@playwright/test";

/** Exercises the real Spend component; financial responses are test fixtures. */
export async function exerciseLiveExpenseOverview(page: Page): Promise<void> {
  let completed = false;
  let responseMode: "ready" | "unavailable" | "wrong_week" | "denied" = "ready";
  let reads = 0;
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/mobile/expenses/capabilities", (route) =>
    route.fulfill({
      json: { ok: true, capabilities: { overview: true, manualEntry: true } },
    }),
  );
  await page.route("**/api/mobile/expenses/categories", (route) =>
    route.fulfill({ json: { ok: true, categories: [] } }),
  );
  await page.route("**/api/mobile/expenses/overview?*", (route) => {
    reads += 1;
    if (responseMode === "unavailable" || responseMode === "denied") {
      return route.fulfill({
        status: responseMode === "denied" ? 401 : 503,
        json: { error: "unavailable" },
      });
    }
    const startDate = new URL(route.request().url()).searchParams.get(
      "weekStart",
    )!;
    const end = new Date(`${startDate}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    const laborCents = completed ? 123_395 : 107_670;
    const revenueCents = completed ? 450_000 : 407_500;
    const ratio = (laborCents / revenueCents) * 100;
    return route.fulfill({
      json: {
        ok: true,
        week: {
          startDate: responseMode === "wrong_week" ? "2000-01-03" : startDate,
          endDate: end.toISOString().slice(0, 10),
        },
        revenueCents,
        ordinaryExpensesCents: 0,
        laborCents,
        fixedCostsCents: 0,
        fixedCosts: {
          amountCents: 0,
          activeSeriesCount: 0,
          coveredExpenseCount: 0,
          coveredExpenseAmountCents: 0,
        },
        totalExpensesCents: laborCents,
        operatingProfitCents: revenueCents - laborCents,
        expenseRatioPercent: ratio,
        priorWeekChange: {
          available: true,
          states: {
            revenue: "zero_baseline",
            expenses: "zero_baseline",
            operatingProfit: "zero_baseline",
            expenseRatio: "undefined_ratio",
          },
          revenuePercent: null,
          expensesPercent: null,
          operatingProfitPercent: null,
          expenseRatioPercentagePoints: null,
          unavailableReasons: { currentWeek: [], priorWeek: [] },
        },
        priorWeek: { completeness: { state: "complete", reasons: [] } },
        categories: [
          {
            id: "labor",
            label: "Labor",
            amountCents: laborCents,
            percentOfExpenses: 100,
            percentOfRevenue: ratio,
            verified: true,
          },
        ],
        labor: {
          state: "actual",
          amountCents: laborCents,
          subrows: {
            crewCents: completed ? 66_700 : 58_200,
            managementCents: completed ? 56_695 : 49_470,
            salesCents: 0,
            otherPayrollAdjustmentsCents: 0,
          },
        },
        advertising: {
          amountCents: 0,
          subrows: { facebookCents: 0, googleCents: 0 },
          unattributedCents: 0,
        },
        pendingExpenseCount: 0,
        missingAdEntries: [],
        missingCommissionDataCount: 0,
        missingFinalTotalCount: 0,
        omittedUnverifiedHistoricalRecordCount: 0,
        unverifiedExpenseCategoryCount: 0,
        completeness: { state: "complete", reasons: [] },
      },
    });
  });

  await page.goto("/mobile?screen=expenses");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const details = page.locator("details").filter({
    has: page.getByText("Labor and advertising detail", { exact: true }),
  });
  await details.locator("summary").click();
  const laborRow = page
    .getByText("Labor (Actual)", { exact: true })
    .locator("..");
  const revenueCard = page.getByText("Revenue", { exact: true }).locator("..");
  await expect(laborRow).toContainText("$1,076.70");
  await expect(revenueCard).toContainText("$4,075.00");
  await expect(
    page.getByText("Automatically checks for updates every 10 seconds"),
  ).toBeVisible();
  await expect(page.getByText("Last updated", { exact: false })).toBeVisible();

  // Simulates the next server snapshot after a $425 job adds $157.25 labor.
  completed = true;
  await expect(laborRow).toContainText("$1,233.95", { timeout: 15_000 });
  await expect(revenueCard).toContainText("$4,500.00");
  await expect(
    page.getByText("Operating profit", { exact: true }).locator(".."),
  ).toContainText("$3,266.05");
  await expect(details).toHaveAttribute("open", "");
  const lastSuccess = await page
    .locator("time")
    .last()
    .getAttribute("datetime");

  responseMode = "unavailable";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Totals may be out of date")).toBeVisible();
  await expect(laborRow).toContainText("$1,233.95");
  await expect(page.locator("time").last()).toHaveAttribute(
    "datetime",
    lastSuccess!,
  );

  responseMode = "wrong_week";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText(
      "The latest weekly totals could not be verified. Retrying automatically.",
    ),
  ).toBeVisible();
  await expect(laborRow).toContainText("$1,233.95");

  responseMode = "ready";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Totals may be out of date")).toHaveCount(0);
  await expect(details).toHaveAttribute("open", "");
  await page.context().setOffline(true);
  await expect(page.getByText("Offline — updates paused")).toBeVisible();
  await expect(laborRow).toContainText("$1,233.95");
  const beforeReconnect = reads;
  await page.context().setOffline(false);
  await expect.poll(() => reads).toBeGreaterThan(beforeReconnect);
  await expect(page.getByText("Offline — updates paused")).toHaveCount(0);

  const weekControl = page.getByLabel("Week containing date");
  const previousWeek = new Date(`${await weekControl.inputValue()}T12:00:00Z`);
  previousWeek.setUTCDate(previousWeek.getUTCDate() - 7);
  const previousWeekStart = previousWeek.toISOString().slice(0, 10);
  previousWeek.setUTCDate(previousWeek.getUTCDate() + 6);
  const previousWeekEnd = previousWeek.toISOString().slice(0, 10);
  await weekControl.fill(previousWeekStart);
  await expect(
    page.getByText(`${previousWeekStart} through ${previousWeekEnd}`),
  ).toBeVisible();
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").click();
  await expect(laborRow).toContainText("$1,233.95");

  responseMode = "denied";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText(
      "Your session has expired. Sign in again to see the latest totals.",
    ),
  ).toBeVisible();
  await expect(laborRow).toHaveCount(0);
  await expect(page.getByText("$1,233.95", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeDisabled();
  expect(browserErrors).toEqual([]);
}
