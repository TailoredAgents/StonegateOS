import { test, expect } from "../test";
import {
  ApiClient,
  uniqueEmail,
  uniquePhone,
  waitForMailhogMessage,
  waitForTwilioMessage,
  waitFor,
  findLeadByEmail,
  getOutboxEventsByQuoteId,
  getQuoteById,
  drainOutbox
} from "../support/sdk";
import { getEnvVar } from "../support/env";

test.describe("Quote lifecycle journey", () => {
  test("admin issues a quote and customer accepts via public link", async ({ page }) => {
    const api = new ApiClient();
    const contactEmail = uniqueEmail("quote");
    const phoneDigits = uniquePhone();
    const phoneE164 = `+1${phoneDigits}`;
    const phoneDisplay = `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
    const siteUrl = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");

    await test.step("Seed contact via public lead intake", async () => {
      await api.post(
        "/api/web/lead-intake",
        {
          services: ["house-wash"],
          name: "Casey Quote",
          phone: phoneDisplay,
          email: contactEmail,
          addressLine1: "456 Quote Lifecycle Ave",
          city: "Roswell",
          state: "GA",
          postalCode: "30075",
          appointmentType: "web_lead",
          scheduling: {
            preferredDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
          },
          consent: true,
          utm: {
            source: "playwright",
            medium: "e2e",
            campaign: "quote-lifecycle"
          }
        },
        { admin: false }
      );
    });

    const leadRecord = await waitFor(() => findLeadByEmail(contactEmail), {
      description: "lead for quote data"
    });

    const sendResult = await test.step("Create and send quote", async () => {
      const quoteCreate = await api.post<{
        ok: boolean;
        quote: { id: string };
      }>("/api/quotes", {
        contactId: leadRecord.contactId,
        propertyId: leadRecord.propertyId,
        zoneId: "zone-core",
        selectedServices: ["house-wash"],
        applyBundles: true,
        notes: "Playwright automated quote scenario."
      });

      const sendResponse = await api.post<{
        shareUrl: string;
        shareToken: string;
      }>(`/api/quotes/${quoteCreate.quote.id}/send`, {
        expiresInDays: 7,
        shareBaseUrl: siteUrl
      });

      await drainOutbox(10);
      return { quoteId: quoteCreate.quote.id, shareUrl: sendResponse.shareUrl };
    });

    const quoteId = sendResult.quoteId;
    const shareUrl = sendResult.shareUrl;

    await test.step("Validate send notifications", async () => {
      const sendEmail = await waitForMailhogMessage((message) => {
        const toHeader = message.Content.Headers["To"] ?? [];
        return toHeader.some((value) => value.includes(contactEmail));
      });
      expect(sendEmail.Content.Body).toContain("quote");

      const sendSms = await waitForTwilioMessage(
        (message) => message.to === phoneE164 && message.body.toLowerCase().includes("quote")
      );
      expect(sendSms.body.toLowerCase()).toContain("quote");

      // Skip clearing shared inboxes; rely on unique email/phone tags per test run.
    });

    await test.step("Customer accepts quote", async () => {
      await page.goto(shareUrl);
      await expect(page.getByRole("heading", { name: /exterior cleaning quote/i })).toBeVisible();
      await page.getByRole("button", { name: "Accept quote" }).click();

      await expect(page.getByText("Accepted")).toBeVisible();
      await expect(page.getByRole("button", { name: "Accept quote" })).toHaveCount(0);
    });

    await drainOutbox(10);

    await test.step("Verify DB + notifications post decision", async () => {
      const quoteRecord = await waitFor(() => getQuoteById(quoteId), {
        description: "quote status update"
      });
      expect(quoteRecord.status).toBe("accepted");

      const quoteEvents = await getOutboxEventsByQuoteId(quoteId);
      expect(quoteEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining(["quote.sent", "quote.decision"])
      );

      const decisionEmail = await waitForMailhogMessage((message) => {
        const toHeader = message.Content.Headers["To"] ?? [];
        return toHeader.some((value) => value.includes(contactEmail));
      });
      expect(decisionEmail.Content.Body.toLowerCase()).toContain("thanks");

      const decisionSms = await waitForTwilioMessage(
        (message) => message.to === phoneE164 && message.body.toLowerCase().includes("thanks")
      );
      expect(decisionSms.body).toContain("Stonegate");

      // Skip clearing shared inboxes; rely on unique email/phone tags per test run.
    });
  });
});
