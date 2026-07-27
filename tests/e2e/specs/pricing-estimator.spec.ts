import { test, expect } from "../test";
import type { Locator } from "@playwright/test";

async function setRange(locator: Locator, value: number) {
  const current = Number(await locator.inputValue());
  const step = Number((await locator.getAttribute("step")) ?? "1");
  const distance = value - current;
  if (!Number.isFinite(current) || step <= 0 || distance % step !== 0) {
    throw new Error(
      `Cannot move range from ${current} to ${value} in steps of ${step}`,
    );
  }

  await locator.focus();
  const key = distance >= 0 ? "ArrowRight" : "ArrowLeft";
  for (let index = 0; index < Math.abs(distance / step); index += 1) {
    await locator.press(key);
  }

  await expect(locator).toHaveValue(String(value));
}

test.describe("Pricing estimator", () => {
  test("updates price range by load tier", async ({ page }) => {
    await page.goto("/pricing");

    const slider = page.locator("#dumpster-load-slider");
    const price = page.getByRole("status").filter({ hasText: /^Pricing:/ });

    await expect(slider).toBeVisible();
    await expect(price).toContainText("$195");
    await expect(price).toContainText("$310");

    await setRange(slider, 50);
    await expect(price).toContainText("$320");
    await expect(price).toContainText("$470");

    await setRange(slider, 75);
    await expect(price).toContainText("$480");
    await expect(price).toContainText("$620");

    await setRange(slider, 100);
    await expect(price).toContainText("$630");
    await expect(price).toContainText("$850");
  });

  test("applies add-ons and carries selection into estimate notes", async ({
    page,
  }) => {
    await page.goto("/pricing");

    const slider = page.locator("#dumpster-load-slider");
    await setRange(slider, 25);

    const addMattress = page.getByRole("button", {
      name: /add one mattresses/i,
    });
    await addMattress.click();

    const price = page.getByRole("status").filter({ hasText: /^Pricing:/ });
    await expect(price).toContainText("$225");
    await expect(price).toContainText("$340");

    await expect(page).toHaveURL(/pe_load=quarter/);
    await expect(page).toHaveURL(/pe_mattress=1/);

    const scheduleLink = page
      .locator('a[href^="/estimate"][href*="pe_load="]')
      .first();
    await expect(scheduleLink).toBeVisible();
    await scheduleLink.click();
    await expect(
      page.getByRole("heading", { name: /request an on-site estimate/i }),
    ).toBeVisible();

    const notes = page.getByPlaceholder(/stairs, gate codes/i);
    await expect(notes).toHaveValue(/Pricing estimator selection:/);
    await expect(notes).toHaveValue(/Load size:/);
    await expect(notes).toHaveValue(/Estimated range:/);
  });
});
