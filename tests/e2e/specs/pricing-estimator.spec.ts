import { test, expect } from "../test";
import type { Locator } from "@playwright/test";

async function setRange(locator: Locator, value: number) {
  await locator.evaluate((element, next) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }

    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!nativeValueSetter) {
      throw new Error("Expected the native input value setter");
    }

    nativeValueSetter.call(element, String(next));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
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
