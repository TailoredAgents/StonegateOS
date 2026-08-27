import { expect, test } from "../test";

test.describe("Mobile Spend V2", () => {
  test.use({
    storageState: "tests/e2e/storage/mobile-owner.json",
    serviceWorkers: "block",
  });

  test("keeps Add focused and exposes the essential manual and ad fields", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "This workflow is covered by the mobile projects.");

    await page.route("**/api/mobile/expenses/capabilities", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          capabilities: {
            manualEntry: true,
            receiptCapture: true,
            reimbursement: true,
            dailyAdSpend: true,
            overview: true,
            exactDuplicateReview: true,
          },
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/categories", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          categories: [
            { id: "fuel", name: "Fuel" },
            { id: "supplies", name: "Supplies" },
          ],
        }),
      }),
    );
    await page.route("**/api/mobile/expenses/daily-ad-spend?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          businessDate: new URL(route.request().url()).searchParams.get(
            "businessDate",
          ),
          facebook: null,
          google: null,
        }),
      }),
    );

    await page.goto("/mobile?screen=expenses");

    await expect(
      page.getByRole("heading", {
        name: "Expenses without the paperwork pile",
      }),
    ).toBeVisible();
    for (const tab of ["Add", "Overview", "History"]) {
      const control = page.getByRole("button", { name: tab, exact: true });
      await expect(control).toBeVisible();
      expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        44,
      );
    }
    await expect(
      page.getByRole("button", { name: "Add", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    const addChoices = ["Scan receipt", "Daily ad spend", "Manual entry"];
    for (const name of addChoices) {
      const control = page.getByRole("button", {
        name: new RegExp(`^${name}`),
      });
      await expect(control).toBeVisible();
      expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        44,
      );
    }

    await page.getByRole("button", { name: /^Manual entry/u }).click();
    for (const name of addChoices) {
      await expect(
        page.getByRole("button", { name: new RegExp(`^${name}`) }),
      ).toHaveCount(0);
    }
    await expect(
      page.getByRole("heading", { name: "Enter the essentials" }),
    ).toBeVisible();
    await expect(page.getByLabel("Date", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Expense amount in dollars")).toBeVisible();
    await expect(page.getByLabel("Category", { exact: true })).toBeVisible();
    await expect(page.getByText("Who paid?", { exact: true })).toBeVisible();
    await expect(page.getByText("More details", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Post expense", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: /^Daily ad spend/u }).click();
    await expect(page.getByLabel("Business date")).not.toHaveValue("");
    await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
    await expect(page.getByLabel("Facebook ad spend in dollars")).toBeVisible();
    await expect(page.getByLabel("Google ad spend in dollars")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save ad spend", exact: true }),
    ).toBeVisible();
  });
});
