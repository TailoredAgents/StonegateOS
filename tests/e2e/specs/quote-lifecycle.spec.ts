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
  drainOutbox,
} from "../support/sdk";
import { getEnvVar } from "../support/env";

test.describe("Quote lifecycle journey", () => {
  test("admin issues a quote and customer accepts via public link", async ({
    page,
  }) => {
    const api = new ApiClient();
    const contactEmail = uniqueEmail("quote");
    const phoneDigits = uniquePhone();
    const phoneE164 = `+1${phoneDigits}`;
    const phoneDisplay = `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
    const browserSiteUrl = getEnvVar(
      "NEXT_PUBLIC_SITE_URL",
      "http://localhost:3000",
    );
    const publicSiteUrl = new URL(getEnvVar("SITE_URL")).origin;
    const publicQuoteUrlPrefix = `${publicSiteUrl}/quote/`;
    let bookedFromQuote = false;

    await test.step("Seed contact via public lead intake", async () => {
      await api.post(
        "/api/web/lead-intake",
        {
          services: ["furniture"],
          name: "Casey Quote",
          phone: phoneDisplay,
          email: contactEmail,
          addressLine1: "456 Quote Lifecycle Ave",
          city: "Roswell",
          state: "GA",
          postalCode: "30075",
          appointmentType: "web_lead",
          scheduling: {
            preferredDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
              .toISOString()
              .slice(0, 10),
          },
          consent: true,
          utm: {
            source: "playwright",
            medium: "e2e",
            campaign: "quote-lifecycle",
          },
        },
        { admin: false },
      );
    });

    const leadRecord = await waitFor(() => findLeadByEmail(contactEmail), {
      description: "lead for quote data",
    });

    const sendResult = await test.step("Create and send quote", async () => {
      const quoteCreate = await api.post<{
        ok: boolean;
        quote: { id: string };
      }>("/api/quotes", {
        contactId: leadRecord.contactId,
        propertyId: leadRecord.propertyId,
        zoneId: "zone-core",
        selectedServices: ["furniture"],
        applyBundles: true,
        notes: "Playwright automated quote scenario.",
      });

      const sendResponse = await api.post<{
        shareUrl: string;
        shareToken: string;
      }>(`/api/quotes/${quoteCreate.quote.id}/send`, {
        expiresInDays: 7,
        shareBaseUrl: publicSiteUrl,
      });

      await drainOutbox(50);
      await drainOutbox(50);
      return { quoteId: quoteCreate.quote.id, shareUrl: sendResponse.shareUrl };
    });

    const quoteId = sendResult.quoteId;
    const shareUrl = sendResult.shareUrl;

    await test.step("Validate send notifications", async () => {
      const sendEmail = await waitForMailhogMessage((message) => {
        const toHeader = message.Content.Headers["To"] ?? [];
        return (
          toHeader.some((value) => value.includes(contactEmail)) &&
          message.Content.Body.includes(publicQuoteUrlPrefix)
        );
      });
      expect(sendEmail.Content.Body).toContain("quote");
      expect(sendEmail.Content.Body).toContain(publicQuoteUrlPrefix);

      const sendSms = await waitForTwilioMessage(
        (message) =>
          message.to === phoneE164 &&
          message.body.toLowerCase().includes("quote") &&
          message.body.includes(publicQuoteUrlPrefix),
      );
      expect(sendSms.body.toLowerCase()).toContain("quote");
      expect(sendSms.body).toContain(publicQuoteUrlPrefix);

      // Skip clearing shared inboxes; rely on unique email/phone tags per test run.
    });

    await test.step("Customer accepts quote", async () => {
      expect(new URL(shareUrl).origin).toBe(publicSiteUrl);
      const localShareUrl = new URL(
        new URL(shareUrl).pathname,
        browserSiteUrl,
      ).toString();
      await page.goto(localShareUrl);
      await expect(
        page.getByRole("heading", { name: /your junk removal proposal/i }),
      ).toBeVisible();

      const approveAndBook = page
        .getByRole("button", { name: /^Approve and book /i })
        .first();
      const approveForScheduling = page.getByRole("button", {
        name: "Approve quote and have Stonegate schedule me",
      });
      if ((await approveAndBook.count()) > 0) {
        bookedFromQuote = true;
        await approveAndBook.click();
        await expect(
          page.getByText(/your service window is booked/i),
        ).toBeVisible();
      } else {
        await expect(approveForScheduling).toBeVisible();
        await approveForScheduling.click();
        await expect(page.getByText(/quote approved/i)).toBeVisible();
      }

      await expect(page.getByText(/^(Accepted|Booked)$/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Approve and book /i }),
      ).toHaveCount(0);
      await expect(approveForScheduling).toHaveCount(0);
    });

    await drainOutbox(50);
    await drainOutbox(50);

    await test.step("Verify DB + notifications post decision", async () => {
      const quoteRecord = await waitFor(() => getQuoteById(quoteId), {
        description: "quote status update",
      });
      expect(quoteRecord.status).toBe("accepted");

      const quoteEvents = await getOutboxEventsByQuoteId(quoteId);
      const eventTypes = quoteEvents.map((event) => event.type);
      expect(eventTypes).toContain("quote.sent");

      if (bookedFromQuote) {
        expect(eventTypes).toContain("estimate.requested");
        expect(eventTypes).not.toContain("quote.decision");

        const bookingEmail = await waitForMailhogMessage((message) => {
          const toHeader = message.Content.Headers["To"] ?? [];
          return (
            toHeader.some((value) => value.includes(contactEmail)) &&
            message.Content.Body.toLowerCase().includes("you're booked")
          );
        });
        expect(bookingEmail.Content.Body.toLowerCase()).toContain(
          "you're booked",
        );

        const bookingSms = await waitForTwilioMessage(
          (message) =>
            message.to === phoneE164 &&
            message.body.toLowerCase().includes("you're booked"),
        );
        expect(bookingSms.body).toContain("Stonegate");
      } else {
        expect(eventTypes).toContain("quote.decision");
        expect(eventTypes).not.toContain("estimate.requested");

        const decisionEmail = await waitForMailhogMessage((message) => {
          const toHeader = message.Content.Headers["To"] ?? [];
          return (
            toHeader.some((value) => value.includes(contactEmail)) &&
            message.Content.Body.toLowerCase().includes("thanks for approving")
          );
        });
        expect(decisionEmail.Content.Body.toLowerCase()).toContain(
          "thanks for approving",
        );

        const decisionSms = await waitForTwilioMessage(
          (message) =>
            message.to === phoneE164 &&
            message.body.toLowerCase().includes("thanks for approving"),
        );
        expect(decisionSms.body).toContain("Stonegate");
      }

      // Skip clearing shared inboxes; rely on unique email/phone tags per test run.
    });
  });
});
