import { test, expect } from "../test";
import { createE2EPhoneOnlyContact } from "../support/db";

test.describe("Mobile contact messaging", () => {
  test.use({ storageState: "tests/e2e/storage/mobile-sales.json" });

  test("starts an SMS thread from a phone-only contact and sends the first message", async ({ page }) => {
    const contact = await createE2EPhoneOnlyContact();
    const contactName = `${contact.firstName} ${contact.lastName}`;

    await page.goto(`/mobile?screen=contacts&contactId=${encodeURIComponent(contact.contactId)}`);

    await expect(page.getByRole("heading", { name: contactName })).toBeVisible();
    await expect(page.getByRole("button", { name: "Message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Call" })).toBeVisible();

    await Promise.all([
      page.waitForURL(/\/mobile\?threadId=/),
      page.getByRole("button", { name: "Message" }).click()
    ]);

    await expect(page.getByRole("heading", { name: contactName })).toBeVisible();
    await expect(page.getByText("No messages yet.")).toBeVisible();
    await expect(page.getByLabel("Reply")).toBeVisible();

    const body = `E2E first mobile message ${Date.now()}`;
    const sendResponse = page.waitForResponse((response) =>
      response.url().includes("/api/mobile/inbox/threads/") &&
      response.url().includes("/messages") &&
      response.request().method() === "POST"
    );

    await page.getByLabel("Reply").fill(body);
    await page.getByRole("button", { name: "Send reply" }).click();

    expect((await sendResponse).ok()).toBe(true);
    await expect(page.getByText(body)).toBeVisible();
  });
});
