import { test, expect } from "../test";
import {
  uniqueEmail,
  uniquePhone,
  waitForMailhogMessage,
  waitForTwilioMessage,
  drainOutbox,
  findLeadByEmail,
  getOutboxEventsByLeadId,
  waitFor
} from "../support/sdk";

test.describe("Lead Intake Journey", () => {
  test("visitor schedules an in-person estimate and receives notifications", async ({ page }) => {
    const email = uniqueEmail("lead");
    const phoneDigits = uniquePhone();
    const phoneDisplay = `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
    const phoneE164 = `+1${phoneDigits}`;
    const preferredDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const alternateDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await test.step("Submit lead form", async () => {
      await page.goto("/");
      const formAnchor = page.locator("#schedule-estimate");
      await formAnchor.scrollIntoViewIfNeeded();

      await page.getByLabel("Whole Home Soft Wash").check();
      await page.getByLabel("Driveway & Walkway").check();

      await page.getByLabel("Service address").fill("123 Lead Intake Lane");
      await page.getByLabel("City").fill("Atlanta");
      await page.getByLabel("State").fill("GA");
      await page.getByLabel("ZIP").fill("30301");

      await page.getByRole("button", { name: "Next: Contact & time" }).click();

      await page.getByLabel("Full name").fill("Jordan Lead");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Mobile phone").fill(phoneDisplay);
      await page.getByLabel("Preferred visit date").fill(preferredDate);
      await page.getByLabel("Alternate date (optional)").fill(alternateDate);
      await page.getByLabel(/Morning/).check();
      await page.getByLabel("Notes for the crew (gate codes, surfaces, pets)").fill(
        "Playwright E2E lead intake scenario."
      );
      await page.getByLabel(/I agree to receive appointment updates/).check();

      await page.getByRole("button", { name: "Book in-person estimate" }).click();
      await expect(page.getByRole("heading", { name: /in-person schedule/i })).toBeVisible();
    });

    await test.step("Verify DB + outbox", async () => {
      await drainOutbox(10);
      const record = await waitFor(() => findLeadByEmail(email), { description: "lead in database" });
      expect(record.services).toEqual(expect.arrayContaining(["house-wash", "driveway"]));
      expect(record.appointmentId).toBeTruthy();

      const events = await getOutboxEventsByLeadId(record.leadId);
      expect(events.map((event) => event.type)).toContain("estimate.requested");
    });

    await test.step("Validate notifications", async () => {
      const confirmationEmail = await waitForMailhogMessage((message) => {
        const toHeader = message.Content.Headers["To"] ?? [];
        return toHeader.some((value) => value.includes(email));
      });
      expect(confirmationEmail.Content.Body).toContain("estimate");

      const confirmationSms = await waitForTwilioMessage(
        (message) => message.to === phoneE164 && message.body.toLowerCase().includes("estimate")
      );
      expect(confirmationSms.body).toContain("Stonegate");

      // No-op: rely on unique email/phone per test instead of clearing shared inboxes.
    });
  });
});
