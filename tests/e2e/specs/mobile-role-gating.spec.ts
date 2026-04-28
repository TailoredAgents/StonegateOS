import { test, expect } from "../test";

test.describe("Mobile role gating", () => {
  test.describe("sales user", () => {
    test.use({ storageState: "tests/e2e/storage/mobile-sales.json" });

    test("cannot access owner mobile screens or APIs", async ({ page, request }) => {
      await page.goto("/mobile?screen=owner");

      await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
      await expect(page.locator("nav").getByRole("link", { name: /owner/i })).toHaveCount(0);
      await expect(page.getByText("E2E Mobile Sales")).toBeVisible();

      const meResponse = await request.get("/api/mobile/me");
      expect(meResponse.status()).toBe(200);
      const mePayload = (await meResponse.json()) as { allowedScreens?: string[]; teamMember?: { roleSlug?: string } };
      expect(mePayload.teamMember?.roleSlug).toBe("sales");
      expect(mePayload.allowedScreens ?? []).not.toContain("owner");
      expect(mePayload.allowedScreens ?? []).not.toContain("access");

      const ownerResponse = await request.get("/api/mobile/owner/summary");
      expect(ownerResponse.status()).toBe(403);
    });
  });

  test.describe("owner user", () => {
    test.use({ storageState: "tests/e2e/storage/mobile-owner.json" });

    test("can access owner mobile screens and APIs", async ({ page, request }) => {
      await page.goto("/mobile?screen=owner");

      await expect(page.getByRole("heading", { name: "Owner" })).toBeVisible();
      await expect(page.locator("nav").getByRole("link", { name: /owner/i })).toBeVisible();
      await expect(page.getByText("E2E Mobile Owner")).toBeVisible();

      const meResponse = await request.get("/api/mobile/me");
      expect(meResponse.status()).toBe(200);
      const mePayload = (await meResponse.json()) as { allowedScreens?: string[]; teamMember?: { roleSlug?: string } };
      expect(mePayload.teamMember?.roleSlug).toBe("owner");
      expect(mePayload.allowedScreens ?? []).toContain("owner");
      expect(mePayload.allowedScreens ?? []).toContain("access");

      const ownerResponse = await request.get("/api/mobile/owner/summary");
      expect(ownerResponse.status()).toBe(200);
      await expect(ownerResponse.json()).resolves.toMatchObject({
        ok: true,
        summary: {
          collectedTodayCents: expect.any(Number),
          collectedWeekCents: expect.any(Number),
          collectedMonthCents: expect.any(Number),
          collectedLast30DaysCents: expect.any(Number),
          projectedTodayCents: expect.any(Number),
          bookedJobsToday: expect.any(Number),
          openInboxLeads: expect.any(Number),
          payoutRuns: expect.any(Array)
        }
      });
    });
  });
});
