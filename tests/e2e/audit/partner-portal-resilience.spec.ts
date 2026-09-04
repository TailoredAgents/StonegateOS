import { expect, test, type Page } from "@playwright/test";
import { PARTNER_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-session";
import type { PartnerAvailability } from "../../../apps/site/src/app/partners/lib/portal-v2";
import { expectTeamStateToPassAutomatedWcag } from "./accessibility";
import {
  applyPartnerLongDataFixture,
  cleanupPartnerBookingFixture,
  closePartnerBookingFixtures,
  createPartnerBookingFixture,
  getPartnerReviewRequestSnapshot,
  setPartnerCalendarSyncFreshness,
  type PartnerBookingFixture,
} from "./partner-booking-fixtures";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

const BOOKING_SCOPE_LABEL =
  /What (?:needs to be done|should be completed at the facility)\?/u;
const DAY_MS = 86_400_000;

type AvailabilityEnvelope = {
  ok: true;
  availability: PartnerAvailability;
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
});

test.afterAll(async () => {
  await closePartnerBookingFixtures();
});

async function usePartnerSession(
  page: Page,
  baseURL: string,
  fixture: PartnerBookingFixture,
): Promise<void> {
  const siteUrl = new URL(baseURL);
  await page.context().addCookies([
    {
      name: PARTNER_SESSION_COOKIE,
      value: fixture.sessionToken,
      domain: siteUrl.hostname,
      path: "/",
      httpOnly: true,
      secure: siteUrl.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
}

async function openPartnerDraftAtProof(input: {
  page: Page;
  fixture: PartnerBookingFixture;
  description: string;
}): Promise<void> {
  await input.page.goto(
    `/partners/book?locationId=${input.fixture.locationId}&serviceKey=junk-removal`,
  );
  await expect(
    input.page.getByRole("heading", {
      name: "Request facility service",
      level: 1,
    }),
  ).toBeVisible();
  await expect(input.page.getByText("Saved", { exact: true })).toBeVisible();
  await input.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    input.page.getByRole("heading", { name: "Add service details" }),
  ).toBeVisible();
  await input.page
    .getByRole("textbox", { name: BOOKING_SCOPE_LABEL })
    .fill(input.description);
  await input.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    input.page.getByRole("heading", { name: "Confirm contact & access" }),
  ).toBeVisible();
  await input.page.getByLabel("On-site contact name").fill("E2E Site Lead");
  await input.page
    .getByLabel("Mobile phone")
    .fill(input.fixture.partnerPhoneE164);
  await input.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    input.page.getByRole("heading", { name: "Add photos & proof" }),
  ).toBeVisible();
}

function formattedLocalDate(localDate: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(`${localDate}T12:00:00Z`));
}

test(
  "booking validation summarizes linked required-field errors and moves focus",
  { tag: "@partner-stateful" },
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    try {
      await usePartnerSession(page, baseURL, fixture);
      await page.goto(
        `/partners/book?locationId=${fixture.locationId}&serviceKey=junk-removal`,
      );
      await expect(
        page.getByRole("heading", {
          name: "Request facility service",
          level: 1,
        }),
      ).toBeVisible();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { name: "Add service details" }),
      ).toBeVisible();

      const service = page.locator("#partner-book-service");
      const description = page.getByRole("textbox", {
        name: BOOKING_SCOPE_LABEL,
      });
      const originalServiceKey = await service.inputValue();
      await service.selectOption("");
      await description.fill("");
      await page.getByRole("button", { name: "Continue" }).click();

      const summary = page
        .getByRole("alert")
        .filter({ hasText: "Complete the highlighted details to continue." });
      await expect(summary).toBeVisible();
      await expect(summary).toBeFocused();
      const serviceSummaryLink = summary.getByRole("link", {
        name: "Choose a service.",
      });
      const descriptionSummaryLink = summary.getByRole("link", {
        name: "Describe the work to be completed.",
      });
      await expect(serviceSummaryLink).toHaveAttribute(
        "href",
        "#partner-book-service",
      );
      await expect(descriptionSummaryLink).toHaveAttribute(
        "href",
        "#partner-book-description",
      );

      await expect(service).toHaveAttribute("aria-invalid", "true");
      await expect(service).toHaveAttribute(
        "aria-describedby",
        "partner-book-service-error",
      );
      await expect(page.locator("#partner-book-service-error")).toHaveText(
        "Choose a service.",
      );
      await serviceSummaryLink.click();
      await expect(service).toBeFocused();

      await expect(description).toHaveAttribute("aria-invalid", "true");
      await expect(description).toHaveAttribute(
        "aria-describedby",
        "partner-book-description-error",
      );
      await expect(page.locator("#partner-book-description-error")).toHaveText(
        "Describe the work to be completed.",
      );
      await descriptionSummaryLink.click();
      await expect(description).toBeFocused();

      await service.selectOption(originalServiceKey);
      await description.fill(`Required-field recovery ${fixture.marker}`);
      const baseOption = page.locator("#partner-book-base-option");
      if ((await baseOption.count()) > 0 && !(await baseOption.inputValue())) {
        await baseOption.selectOption({ index: 1 });
      }
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { name: "Confirm contact & access" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      const contactSummary = page
        .getByRole("alert")
        .filter({ hasText: "Complete the highlighted details to continue." });
      await expect(contactSummary).toBeFocused();
      const contactName = page.getByLabel("On-site contact name");
      const contactPhone = page.getByLabel("Mobile phone");
      const contactEmail = page.locator("#partner-book-contact-email");
      await expect(contactName).toHaveAttribute(
        "aria-describedby",
        "partner-book-contact-name-error",
      );
      await expect(contactPhone).toHaveAttribute(
        "aria-describedby",
        "partner-book-contact-method-error",
      );
      await expect(contactEmail).toHaveAttribute(
        "aria-describedby",
        "partner-book-contact-method-error",
      );
      await expect(page.locator("#partner-book-contact-name-error")).toHaveText(
        "Add the on-site contact’s name.",
      );
      await expect(
        page.locator("#partner-book-contact-method-error"),
      ).toHaveText("Add a phone number or email for the on-site contact.");

      const contactNameSummaryLink = contactSummary.getByRole("link", {
        name: "Add the on-site contact’s name.",
      });
      const contactMethodSummaryLink = contactSummary.getByRole("link", {
        name: "Add a phone number or email for the on-site contact.",
      });
      await expect(contactNameSummaryLink).toHaveAttribute(
        "href",
        "#partner-book-contact-name",
      );
      await expect(contactMethodSummaryLink).toHaveAttribute(
        "href",
        "#partner-book-contact-phone",
      );
      await contactNameSummaryLink.click();
      await expect(contactName).toBeFocused();
      await contactMethodSummaryLink.click();
      await expect(contactPhone).toBeFocused();
    } finally {
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);

test(
  "an availability outage falls back truthfully and recovers the saved draft",
  { tag: "@partner-stateful" },
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    const description = `Availability outage recovery ${fixture.marker}`;
    let availabilityCalls = 0;
    try {
      await page.route(
        /\/api\/partners\/portal\/booking-drafts\/[0-9a-f-]+\/availability(?:\?|$)/iu,
        async (route) => {
          availabilityCalls += 1;
          if (availabilityCalls === 1) {
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              headers: {
                "x-correlation-id": "portal_e2e_availability_outage",
              },
              json: {
                ok: false,
                error: "service_unavailable",
                message: "Availability is temporarily unavailable.",
                retryable: true,
                correlationId: "portal_e2e_availability_outage",
              },
            });
            return;
          }
          await route.continue();
        },
      );
      await usePartnerSession(page, baseURL, fixture);
      await openPartnerDraftAtProof({ page, fixture, description });
      const savedDraftId = new URL(page.url()).searchParams.get("draftId");
      expect(savedDraftId).toMatch(/^[0-9a-f-]+$/u);

      await page.getByRole("button", { name: "Continue" }).click();
      await expect.poll(() => availabilityCalls).toBe(1);
      await expect(
        page.getByRole("heading", { name: "Choose an arrival window" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Request a reviewed schedule" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Live confirmation is unavailable for this request. Choose up to three preferred dates. Stonegate will review the scope and contact you before any arrival window is confirmed or capacity is reserved.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.locator('button[aria-label$="arrival window"]'),
      ).toHaveCount(0);
      const availabilityPanel = page
        .getByRole("heading", { name: "Choose a service window" })
        .locator("..")
        .locator("..");
      await expect(
        availabilityPanel.getByRole("button", { name: "Refresh" }),
      ).toBeVisible();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();

      await page.reload();
      expect(new URL(page.url()).searchParams.get("draftId")).toBe(
        savedDraftId,
      );
      await expect(
        page.getByRole("heading", { name: "Choose location" }),
      ).toBeVisible();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("textbox", { name: BOOKING_SCOPE_LABEL }),
      ).toHaveValue(description);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { name: "Confirm contact & access" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { name: "Add photos & proof" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect.poll(() => availabilityCalls).toBe(2);
      await expect(
        page.locator("fieldset button[aria-pressed]").first(),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Request a reviewed schedule" }),
      ).toBeHidden();
      await expect(
        page.getByRole("textbox", { name: BOOKING_SCOPE_LABEL }),
      ).toHaveCount(0);
    } finally {
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);

test(
  "stale calendar falls back to review and persists a waitlist request",
  { tag: "@partner-stateful" },
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    try {
      await setPartnerCalendarSyncFreshness("stale");
      await usePartnerSession(page, baseURL, fixture);
      await openPartnerDraftAtProof({
        page,
        fixture,
        description: `Stale-calendar review request ${fixture.marker}`,
      });
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByRole("heading", { name: "Choose an arrival window" }),
      ).toBeVisible();
      await expect(
        page.getByText("The connected calendar is stale."),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Request a reviewed schedule" }),
      ).toBeVisible();
      await expect(
        page.locator('button[aria-label$="arrival window"]'),
      ).toHaveCount(0);

      const preferredDate = new Date(Date.now() + 7 * DAY_MS)
        .toISOString()
        .slice(0, 10);
      await page.getByLabel("First choice").fill(preferredDate);
      const waitlist = page.getByRole("radio", {
        name: /Join the scheduling waitlist/u,
      });
      await waitlist.focus();
      await page.keyboard.press("Space");
      await expect(waitlist).toBeChecked();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { name: "Check & send" }),
      ).toBeVisible();
      await expect(
        page.getByText("Scheduling waitlist requested", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Send service request" }).click();
      await expect(page).toHaveURL(
        /\/partners\/bookings\/[0-9a-f-]+\?created=1$/iu,
      );
      const bookingId = new URL(page.url()).pathname.split("/").at(-1);
      if (!bookingId) throw new Error("Review booking ID was not returned.");
      await expect(
        page.getByText("Under Review", { exact: true }).first(),
      ).toBeVisible();

      const snapshot = await expect
        .poll(() => getPartnerReviewRequestSnapshot(fixture, bookingId), {
          timeout: 20_000,
        })
        .toMatchObject({
          publicStatus: "under_review",
          confirmationMode: "review",
          appointmentStartAt: null,
          bookingArrivalStartAt: null,
          bookingArrivalEndAt: null,
          scheduleAssistancePreference: "waitlist",
          assistanceRequestCount: 1,
          assistancePreference: "waitlist",
          assistanceState: "pending",
          calendarOutboxCount: 0,
        })
        .then(() => getPartnerReviewRequestSnapshot(fixture, bookingId));
      expect(snapshot.preferredWindows).toEqual([
        {
          localDate: preferredDate,
          timeOfDay: "anytime",
          timezone: "America/New_York",
        },
      ]);
      expect(snapshot.assistancePreferredWindows).toEqual(
        snapshot.preferredWindows,
      );
    } finally {
      await setPartnerCalendarSyncFreshness("current");
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);

test(
  "a filled slot refreshes into ranked review alternatives without promising capacity",
  { tag: "@partner-stateful" },
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    let availabilityCalls = 0;
    let holdCalls = 0;
    let expectedRankedDates: string[] = [];
    try {
      await usePartnerSession(page, baseURL, fixture);
      await page.route(
        /\/api\/partners\/portal\/booking-drafts\/[0-9a-f-]+\/availability(?:\?|$)/iu,
        async (route) => {
          availabilityCalls += 1;
          const response = await route.fetch();
          const payload = (await response.json()) as AvailabilityEnvelope;
          if (availabilityCalls === 1) {
            await route.fulfill({ response });
            return;
          }

          const uniqueDates = new Map<
            string,
            PartnerAvailability["windows"][number]
          >();
          for (const window of payload.availability.windows) {
            if (window.available && !uniqueDates.has(window.localDate)) {
              uniqueDates.set(window.localDate, window);
            }
          }
          const candidates = [...uniqueDates.values()].slice(0, 3);
          if (candidates.length < 3) {
            throw new Error(
              "The fixture did not expose three alternate dates.",
            );
          }
          const rawRanks = [3, 1, 2] as const;
          payload.availability.instantConfirmationEligible = false;
          payload.availability.reviewReasons = ["capacity_unavailable"];
          payload.availability.windows = payload.availability.windows.map(
            (window) => ({ ...window, available: false }),
          );
          payload.availability.rankedAlternatives = candidates.map(
            (window, index) => ({
              ...window,
              available: true,
              rank: rawRanks[index] ?? index + 1,
              reason: index === 1 ? "soonest_available" : "more_capacity",
            }),
          );
          expectedRankedDates = [...payload.availability.rankedAlternatives]
            .sort((left, right) => left.rank - right.rank)
            .map((window) => window.localDate);
          await route.fulfill({ response, json: payload });
        },
      );
      await page.route(
        /\/api\/partners\/portal\/booking-drafts\/[0-9a-f-]+\/hold$/iu,
        async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          holdCalls += 1;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            headers: { "x-correlation-id": "portal_e2e_slot_contention" },
            json: {
              ok: false,
              error: "slot_unavailable",
              message:
                "That arrival window just filled. Current alternatives were refreshed.",
              retryable: true,
              correlationId: "portal_e2e_slot_contention",
            },
          });
        },
      );

      await openPartnerDraftAtProof({
        page,
        fixture,
        description: `Filled-slot recovery request ${fixture.marker}`,
      });
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("heading", { name: "Choose an arrival window" }),
      ).toBeVisible();
      const availableWindows = page.locator("fieldset button[aria-pressed]");
      await expect(availableWindows.first()).toBeVisible();
      await availableWindows.first().click();

      await expect.poll(() => holdCalls).toBe(1);
      await expect.poll(() => availabilityCalls).toBe(2);
      await expect(
        page.getByRole("heading", { name: "Request a reviewed schedule" }),
      ).toBeVisible();
      await expect(
        page.getByText("Suggested dates from current capacity", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(/do not reserve a crew, truck, or arrival window/iu),
      ).toBeVisible();

      const suggestionPanel = page
        .getByText("Suggested dates from current capacity", { exact: true })
        .locator("..");
      const suggestedButtons = suggestionPanel.getByRole("button");
      await expect(suggestedButtons).toHaveCount(3);
      const expectedLabels = expectedRankedDates.map((date) =>
        formattedLocalDate(date, "America/New_York"),
      );
      await expect(suggestedButtons).toHaveText(expectedLabels);
      await suggestedButtons.first().focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("First choice")).toHaveValue(
        expectedRankedDates[0] ?? "",
      );
      const callback = page.getByRole("radio", {
        name: /Request a scheduling callback/u,
      });
      await callback.focus();
      await page.keyboard.press("Space");
      await expect(callback).toBeChecked();
    } finally {
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);

test(
  "long account and location data reflows at the 320 pixel boundary",
  { tag: "@partner-stateful" },
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    try {
      const longData = await applyPartnerLongDataFixture(fixture);
      await usePartnerSession(page, baseURL, fixture);
      await page.setViewportSize({ width: 320, height: 740 });
      await page.goto("/partners/properties");
      await expect(
        page.getByRole("heading", { name: "Locations", level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByText(longData.siteName, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(`Property ID: ${longData.externalPropertyId}`, {
          exact: true,
        }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);

      const openNavigation = page.getByRole("button", {
        name: "Open navigation",
      });
      await openNavigation.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", {
        name: "Partner portal navigation",
      });
      await expect(drawer).toBeVisible();
      await expect(
        drawer.getByText(longData.accountName, { exact: true }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(openNavigation).toBeFocused();
    } finally {
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);

test(
  "an interrupted private photo transfer retries the retained batch",
  { tag: "@partner-stateful" },
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    try {
      await usePartnerSession(page, baseURL, fixture);
      await page.addInitScript({
        content: `(() => {
          const originalOpen = XMLHttpRequest.prototype.open;
          const originalSend = XMLHttpRequest.prototype.send;
          const uploads = new WeakSet();
          const stats = { puts: 0, aborts: 0 };
          Object.defineProperty(window, "__partnerUploadTestStats", {
            value: stats,
            configurable: false,
          });
          XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            if (String(method).toUpperCase() === "PUT") uploads.add(this);
            return originalOpen.call(this, method, url, ...rest);
          };
          XMLHttpRequest.prototype.send = function(body) {
            originalSend.call(this, body);
            if (!uploads.has(this)) return;
            stats.puts += 1;
            if (stats.aborts === 0) {
              stats.aborts += 1;
              this.abort();
            }
          };
        })();`,
      });
      await openPartnerDraftAtProof({
        page,
        fixture,
        description: `Interrupted private photo upload ${fixture.marker}`,
      });

      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      await page.getByLabel("Photos", { exact: true }).setInputFiles({
        name: "interrupted-transfer.png",
        mimeType: "image/png",
        buffer: png,
      });
      await expect(page.getByText("1 photo selected")).toBeVisible();
      await page.getByRole("button", { name: "Attach photos" }).click();
      await expect(
        page.getByText(/The photo transfer was interrupted\./u),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry photos" }),
      ).toBeVisible();
      await expect(page.getByText("1 photo selected")).toBeVisible();

      await page.getByRole("button", { name: "Retry photos" }).click();
      await expect(
        page.getByText("Photos attached to this saved request.", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByText("interrupted-transfer.png", { exact: true }),
      ).toBeVisible();
      const uploadStats = await page.evaluate(() => {
        const value = (
          window as typeof window & {
            __partnerUploadTestStats?: { puts: number; aborts: number };
          }
        ).__partnerUploadTestStats;
        return value ?? null;
      });
      expect(uploadStats).toEqual({ puts: 2, aborts: 1 });
    } finally {
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);

test(
  "browser-level logout route failure keeps the session and shows recovery guidance",
  { tag: "@partner-stateful" },
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    let interceptedPosts = 0;
    try {
      await usePartnerSession(page, baseURL, fixture);
      await page.goto("/partners/settings");
      await expect(
        page.getByRole("heading", {
          name: "Account, updates & security",
          level: 1,
        }),
      ).toBeVisible();
      await page.route("**/partners/logout", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        interceptedPosts += 1;
        await route.fulfill({
          status: 303,
          headers: {
            location: "/partners/settings?error=logout_failed",
            "cache-control": "no-store",
          },
          body: "",
        });
      });

      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page).toHaveURL(
        /\/partners\/settings\?error=logout_failed$/u,
      );
      await expect(
        page.getByText(
          "We couldn’t confirm server sign-out, so this browser session remains active. Try again or revoke it from Active sessions.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(interceptedPosts).toBe(1);
      const sessionCookie = (await page.context().cookies()).find(
        (cookie) => cookie.name === PARTNER_SESSION_COOKIE,
      );
      expect(sessionCookie?.value).toBe(fixture.sessionToken);
      await expect(
        page.getByRole("heading", {
          name: "Account, updates & security",
          level: 1,
        }),
      ).toBeVisible();
    } finally {
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);

test(
  "partner shell reflows and preserves keyboard navigation at 200 and 400 percent zoom",
  { tag: "@partner-zoom" },
  async ({ page, baseURL }, testInfo) => {
    if (!baseURL) throw new Error("The audit Site base URL is required.");
    const fixture = await createPartnerBookingFixture();
    try {
      await usePartnerSession(page, baseURL, fixture);
      await page.goto("/partners/overview");
      await expect(
        page.getByRole("heading", { name: /Welcome back,/u, level: 1 }),
      ).toBeVisible();

      const expected = testInfo.project.name.includes("400")
        ? { cssWidth: 320, devicePixelRatio: 4, zoom: 400 }
        : { cssWidth: 640, devicePixelRatio: 2, zoom: 200 };
      const viewport = await page.evaluate(() => ({
        cssWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
        devicePixelRatio: window.devicePixelRatio,
      }));
      expect(viewport).toEqual({
        cssWidth: expected.cssWidth,
        contentWidth: expected.cssWidth,
        devicePixelRatio: expected.devicePixelRatio,
      });
      expect(viewport.cssWidth * viewport.devicePixelRatio).toBe(1_280);

      const openNavigation = page.getByRole("button", {
        name: "Open navigation",
      });
      await openNavigation.focus();
      await expect(openNavigation).toBeFocused();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", {
        name: "Partner portal navigation",
      });
      await expect(drawer).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Close navigation" }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      expect(
        await drawer.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(openNavigation).toBeFocused();

      const quickControls = page
        .getByRole("navigation", { name: "Quick navigation" })
        .locator("a, button");
      const controlCount = await quickControls.count();
      expect(controlCount).toBeGreaterThanOrEqual(4);
      for (let index = 0; index < controlCount; index += 1) {
        const box = await quickControls.nth(index).boundingBox();
        expect(box, `quick navigation control ${index + 1}`).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await expectNoHorizontalOverflow(page);
      await expectTeamStateToPassAutomatedWcag({
        page,
        testInfo,
        surface: `Partner Portal at effective ${expected.zoom}% zoom`,
        state: "normal",
        context: "main",
      });
    } finally {
      await cleanupPartnerBookingFixture(fixture);
    }
  },
);
