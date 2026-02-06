import { test, expect } from "../test";
import type { Locator } from "@playwright/test";

async function setRange(locator: Locator, value: number) {
  await locator.evaluate((element, next) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    element.value = String(next);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

test.describe("Pricing estimator", () => {
  test("updates price range by load tier", async ({ page }) => {
    await page.goto("/pricing");

    const slider = page.locator("#dumpster-load-slider");
    const price = page.getByText(/Pricing:\s*\\$/i).first();

    await expect(slider).toBeVisible();
    await expect(price).toContainText("$175");
    await expect(price).toContainText("$250");

    await setRange(slider, 50);
    await expect(price).toContainText("$350");
    await expect(price).toContainText("$500");

    await setRange(slider, 75);
    await expect(price).toContainText("$525");
    await expect(price).toContainText("$700");

    await setRange(slider, 100);
    await expect(price).toContainText("$700");
    await expect(price).toContainText("$900");
  });

  test("applies add-ons and carries selection into estimate notes", async ({ page }) => {
    await page.goto("/pricing");

    const slider = page.locator("#dumpster-load-slider");
    await setRange(slider, 25);

    const addMattress = page.getByRole("button", { name: /add one mattresses/i });
    await addMattress.click();

    const price = page.getByText(/Pricing:\s*\\$/i).first();
    await expect(price).toContainText("$205");
    await expect(price).toContainText("$280");

    await expect(page).toHaveURL(/pe_load=quarter/);
    await expect(page).toHaveURL(/pe_mattress=1/);

    const scheduleLink = page.locator('a[href^="/estimate"][href*="pe_load="]').first();
    await expect(scheduleLink).toBeVisible();
    await scheduleLink.click();
    await expect(page.getByRole("heading", { name: /request an on-site estimate/i })).toBeVisible();

    const notes = page.getByPlaceholder(/stairs, gate codes/i);
    await expect(notes).toContainText("Pricing estimator selection:");
    await expect(notes).toContainText("Load size:");
    await expect(notes).toContainText("Estimated range:");
  });
});
