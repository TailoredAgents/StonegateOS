import { test, expect } from "../test";

const heroHeading = /junk removal that clears clutter fast and responsibly/i;

test.describe("MystOS smoke", () => {
  test("home hero renders call-to-action", async ({ page }) => {
    await test.step("Navigate to home page", async () => {
      await page.goto("/");
    });
    await test.step("Assert hero content", async () => {
      await expect(page.getByRole("heading", { name: heroHeading })).toBeVisible();
      await expect(page.getByRole("link", { name: /get my estimate/i })).toBeVisible();
    });
  });

  test("API health endpoint responds", async ({ request }) => {
    const apiBase = process.env["API_BASE_URL"] ?? "http://localhost:3001";
    await test.step("Fetch api healthz", async () => {
      const response = await request.get(new URL("/api/healthz", apiBase).toString());
      expect(response.status()).toBe(200);
      await expect(response.text()).resolves.toContain("ok");
    });
  });
});
