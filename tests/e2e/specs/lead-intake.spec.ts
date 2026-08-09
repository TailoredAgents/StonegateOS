import { randomUUID } from "node:crypto";
import { test, expect } from "../test";
import {
  ApiClient,
  uniqueEmail,
  uniquePhone,
  drainOutbox,
  findSpeedToLeadCustomerFollowUpByLeadId,
  findLeadByEmail,
  getOutboxEventsByLeadId,
  waitForMailhogMessage,
  waitForTwilioMessage,
  waitFor,
} from "../support/sdk";

test.describe("Lead Intake Journey", () => {
  test("visitor requests an on-site estimate and queues a customer follow-up", async ({
    page,
  }) => {
    const email = uniqueEmail("lead");
    const phoneDigits = uniquePhone();
    const phoneDisplay = `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
    const phoneE164 = `+1${phoneDigits}`;
    const preferredDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const alternateDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    await test.step("Submit lead form", async () => {
      await page.goto("/estimate");
      await expect(
        page.getByRole("heading", { name: /request an on-site estimate/i }),
      ).toBeVisible();

      await page.getByRole("button", { name: /Furniture Removal/ }).click();
      await page.getByRole("button", { name: /Construction Debris/ }).click();

      await page
        .getByPlaceholder("Jamie Customer", { exact: true })
        .fill("Jordan Lead");
      await page
        .getByPlaceholder("(404) 777-2631", { exact: true })
        .fill(phoneDisplay);
      await page
        .getByPlaceholder("you@example.com", { exact: true })
        .fill(email);
      await page
        .getByPlaceholder("Street address", { exact: true })
        .fill("123 Lead Intake Lane");
      await page.getByPlaceholder("City", { exact: true }).fill("Roswell");
      await page.getByPlaceholder("GA", { exact: true }).fill("GA");
      await page.getByPlaceholder("ZIP", { exact: true }).fill("30075");

      const visitDates = page.locator('input[type="date"]');
      await visitDates.first().fill(preferredDate);
      await visitDates.nth(1).fill(alternateDate);
      await page
        .getByPlaceholder(/stairs, gate codes/i)
        .fill("Playwright E2E lead intake scenario.");

      await page.getByRole("button", { name: "Request estimate" }).click();
      await expect(
        page.getByRole("heading", { name: "You’re all set" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Request received. We'll follow up to confirm the exact time.",
          { exact: true },
        ),
      ).toBeVisible();
    });

    await test.step("Verify DB + outbox", async () => {
      const record = await waitFor(() => findLeadByEmail(email), {
        description: "lead in database",
      });
      expect(record.services).toEqual(
        expect.arrayContaining(["furniture", "construction-debris"]),
      );
      expect(record.contactEmail).toBe(email);
      expect(record.contactPhoneE164).toBe(phoneE164);
      expect(record.appointmentId).toBeNull();

      const events = await getOutboxEventsByLeadId(record.leadId);
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["lead.alert", "lead.created"]),
      );
      const leadCreated = events.find((event) => event.type === "lead.created");
      expect(leadCreated?.payload).toMatchObject({
        appointmentType: "web_lead",
        scheduling: {
          preferredDate,
          alternateDate,
          timeWindow: "morning",
        },
      });
      const customerFollowUp = await waitFor(
        async () => {
          await drainOutbox(50);
          return findSpeedToLeadCustomerFollowUpByLeadId(record.leadId);
        },
        { description: "automated customer follow-up SMS" },
      );
      expect(customerFollowUp.toAddress).toBe(phoneE164);
      expect(["queued", "sending", "sent"]).toContain(
        customerFollowUp.deliveryStatus,
      );
      expect(customerFollowUp.isDraft).toBe(false);
      expect(customerFollowUp.body).toMatch(/Stonegate.+about to call/i);
    });
  });

  test("in-person estimate API creates an appointment and sends confirmations", async () => {
    const api = new ApiClient();
    const email = uniqueEmail("estimate-confirmation");
    const phoneDigits = uniquePhone();
    const phoneDisplay = `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`;
    const phoneE164 = `+1${phoneDigits}`;
    const preferredDate = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const response = await api.post<{ appointmentId: string | null }>(
      "/api/web/lead-intake",
      {
        services: ["furniture"],
        name: "Morgan Estimate",
        phone: phoneDisplay,
        email,
        addressLine1: "456 Estimate Confirmation Way",
        city: "Roswell",
        state: "GA",
        postalCode: "30075",
        appointmentType: "in_person_estimate",
        scheduling: {
          preferredDate,
          timeWindow: "morning",
        },
        consent: true,
      },
      {
        admin: false,
        headers: {
          "idempotency-key": `lead-intake-e2e:${randomUUID()}`,
        },
      },
    );
    expect(response.appointmentId).toEqual(expect.any(String));

    const record = await waitFor(() => findLeadByEmail(email), {
      description: "in-person estimate appointment",
    });
    expect(record.appointmentId).toBe(response.appointmentId);

    const events = await getOutboxEventsByLeadId(record.leadId);
    expect(events.map((event) => event.type)).toContain("estimate.requested");

    await drainOutbox(50);
    await drainOutbox(50);

    const confirmationEmail = await waitForMailhogMessage((message) => {
      const toHeader = message.Content.Headers["To"] ?? [];
      return (
        toHeader.some((value) => value.includes(email)) &&
        message.Content.Body.toLowerCase().includes("you're booked")
      );
    });
    expect(confirmationEmail.Content.Body).toMatch(/Stonegate/i);

    const confirmationSms = await waitForTwilioMessage(
      (message) =>
        message.to === phoneE164 &&
        message.body.toLowerCase().includes("you're booked"),
    );
    expect(confirmationSms.body).toContain("Stonegate");
  });
});
