import { test, expect } from "../test";
import { detectCustomerIntent, type CustomerWorkspace } from "../../../apps/site/src/app/team/lib/customer-workspace";
import { getLatestE2ESeedSummary } from "../support/db";

const adminStorage = "tests/e2e/storage/admin.json";

function futureDate(days = 6): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function workspaceFixture(seed: {
  contactId: string;
  propertyId: string;
  quoteId?: string | null;
  appointmentId?: string | null;
}, intent: CustomerWorkspace["recommendedIntent"]): CustomerWorkspace {
  return {
    ok: true,
    contact: {
      id: seed.contactId,
      name: "E2E Contact",
      firstName: "E2E",
      lastName: "Contact",
      email: "e2e-contact@mystos.test",
      phone: "404-555-0100",
      phoneE164: "+14045550100",
      salespersonMemberId: null,
      pipeline: { stage: "new", notes: null },
      stats: { appointments: seed.appointmentId ? 1 : 0, quotes: seed.quoteId ? 1 : 0 },
      notesCount: 1,
      remindersCount: 0,
      lastActivityAt: new Date().toISOString()
    },
    properties: [
      {
        id: seed.propertyId,
        addressLine1: "123 E2E Lane",
        addressLine2: null,
        city: "Atlanta",
        state: "GA",
        postalCode: "30301"
      }
    ],
    upcomingAppointments: seed.appointmentId
      ? [
          {
            id: seed.appointmentId,
            status: "requested",
            startAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            durationMinutes: 90,
            travelBufferMinutes: 30,
            appointmentType: "job",
            rescheduleToken: "e2e-reschedule-token",
            property: {
              id: seed.propertyId,
              addressLine1: "123 E2E Lane",
              addressLine2: null,
              city: "Atlanta",
              state: "GA",
              postalCode: "30301"
            }
          }
        ]
      : [],
    quotes: seed.quoteId
      ? [
          {
            id: seed.quoteId,
            status: "pending",
            displayStatus: "pending",
            quoteNumber: "E2E-Q",
            total: 325,
            shareToken: "e2e-share-token",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sentAt: null,
            pdfDownloadCount: 0,
            lastPdfDownloadedAt: null,
            changeRequestCount: 0,
            latestChangeRequest: null,
            property: {
              addressLine1: "123 E2E Lane",
              city: "Atlanta",
              state: "GA",
              postalCode: "30301"
            }
          }
        ]
      : [],
    missingFields: [],
    recommendedIntent: intent
  };
}

async function latestSeed() {
  const seed = await getLatestE2ESeedSummary();
  expect(seed, "e2e seed summary").not.toBeNull();
  expect(seed?.appointmentId, "seed appointment").toBeTruthy();
  return seed!;
}

test.describe("Inbox CRM workspace API", () => {
  test("protects workspace route from anonymous access", async ({ request }) => {
    const response = await request.get("/api/team/contacts/workspace?contactId=test-contact");
    expect(response.status()).toBe(401);
  });

  test.describe("as admin", () => {
    test.use({ storageState: adminStorage });

    test("validates missing and valid workspace requests", async ({ page }) => {
      const missing = await page.request.get("/api/team/contacts/workspace");
      expect(missing.status()).toBe(400);

      const seed = await latestSeed();
      const valid = await page.request.get(`/api/team/contacts/workspace?contactId=${seed.contactId}`);
      expect(valid.status()).toBe(200);
      const payload = (await valid.json()) as CustomerWorkspace;
      expect(payload.ok).toBe(true);
      expect(payload.contact.id).toBe(seed.contactId);
      expect(payload.properties.map((property) => property.id)).toContain(seed.propertyId);
      expect(payload.missingFields).not.toContain("address");
      expect(payload.quotes.length).toBeGreaterThanOrEqual(0);
      expect(payload.upcomingAppointments.length).toBeGreaterThanOrEqual(0);
    });
  });
});

test.describe("Inbox CRM intent detection", () => {
  const cases: Array<[string, CustomerWorkspace["recommendedIntent"]]> = [
    ["please text me a professional quote", "quote"],
    ["how much would this cost?", "quote"],
    ["can I get on the schedule", "booking"],
    ["can you come out tomorrow", "booking"],
    ["I need to change my appointment", "reschedule"],
    ["I can't make my appointment", "reschedule"],
    ["what address do you need", "missing_info"]
  ];

  for (const [message, expected] of cases) {
    test(`classifies: ${message}`, () => {
      expect(detectCustomerIntent(message)).toBe(expected);
    });
  }

  test("uses AI planner action when present", () => {
    expect(detectCustomerIntent("sounds good", "reschedule_appointment")).toBe("reschedule");
    expect(detectCustomerIntent("sounds good", "create_quote")).toBe("quote");
  });
});

test.describe("Inbox CRM drawers", () => {
  test.use({ storageState: adminStorage });

  test("opens workflow drawers and drafts owner-reviewed messages", async ({ page }) => {
    const seed = await latestSeed();
    let currentWorkspace = workspaceFixture(seed, "quote");

    await page.route("**/api/team/contacts/workspace?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(currentWorkspace)
      });
    });

    await page.goto(`/team?tab=inbox&contactId=${seed.contactId}&channel=sms`);
    await expect(page.getByText("Customer workspace")).toBeVisible();
    await expect(page.getByText("Customer likely wants a quote")).toBeVisible();
    await expect(page.getByText("1 upcoming")).toBeVisible();

    await test.step("Quote drawer creates a quote and fills composer", async () => {
      await page.getByRole("button", { name: "Start workflow" }).click();
      await expect(page.getByRole("heading", { name: "Create quote" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create quote and draft reply" })).toBeDisabled();

      const furnitureCard = page.locator("div").filter({ hasText: /^Furniture/ }).first();
      await furnitureCard.getByRole("checkbox").check();
      await furnitureCard.getByPlaceholder("Total price").fill("325");
      await page.getByLabel("Scope shown to customer").fill("Remove the furniture listed in the thread.");

      await page.getByRole("button", { name: "Create quote and draft reply" }).click();
      await expect(page.getByText("Draft added to the composer")).toBeVisible();
      await expect(page.locator("#inbox-thread-body")).toHaveValue(/I put together your quote here:/);
    });

    await test.step("Booking drawer creates appointment and fills composer", async () => {
      currentWorkspace = workspaceFixture(seed, "booking");
      await page.reload();
      await expect(page.getByText("Customer likely wants to get scheduled")).toBeVisible();
      await page.getByRole("button", { name: "Start workflow" }).click();
      await expect(page.getByRole("heading", { name: "Book appointment" })).toBeVisible();

      await page.getByLabel("Start time").fill(`${futureDate(7)}T10:00`);
      await page.getByLabel("Assigned associate").selectOption({ index: 1 });
      await page.getByLabel("Who sold the job?").selectOption({ index: 1 });
      await page.getByLabel("Where from?").selectOption("google");
      await page.getByLabel("Price range, exact quote, or both?").selectOption("exact");
      await page.getByLabel("Exact quote").fill("375");
      await page.getByLabel("How big is this load?").selectOption("quarter_to_half");
      await page.getByLabel("Appointment notes").fill("E2E booking drawer scenario.");

      await page.getByRole("button", { name: "Book and draft confirmation" }).click();
      await expect(page.getByText("Draft added to the composer")).toBeVisible();
      await expect(page.locator("#inbox-thread-body")).toHaveValue(/You're booked for/);
      await expect(page.locator("#inbox-thread-body")).toHaveValue(/Reply here if anything changes./);
    });

    await test.step("Reschedule drawer updates appointment and fills composer", async () => {
      currentWorkspace = workspaceFixture(seed, "reschedule");
      await page.reload();
      await expect(page.getByText("Customer likely wants to change an appointment")).toBeVisible();
      await page.getByRole("button", { name: "Start workflow" }).click();
      await expect(page.getByRole("heading", { name: "Reschedule appointment" })).toBeVisible();

      await page.getByLabel("New date").fill(futureDate(9));
      await page.getByLabel("New time").fill("14:00");
      await page.getByRole("button", { name: "Reschedule and draft confirmation" }).click();

      await expect(page.getByText("Draft added to the composer")).toBeVisible();
      await expect(page.locator("#inbox-thread-body")).toHaveValue(/I moved your appointment to/);
      await expect(page.locator("#inbox-thread-body")).toHaveValue(/Reply if that doesn't work./);
    });
  });
});
