import { randomUUID } from "node:crypto";
import { expect, test } from "../test";
import { expectTeamStateToPassAutomatedWcag } from "../audit/accessibility";
import {
  archiveQuoteV2E2EFixtures,
  closeQuoteV2E2EFixtureConnection,
  createQuoteV2E2EFixture,
} from "../support/quote-v2";

test.use({
  storageState: "tests/e2e/storage/visitor.json",
  serviceWorkers: "block",
});
test.afterEach(async () => archiveQuoteV2E2EFixtures());
test.afterAll(async () => closeQuoteV2E2EFixtureConnection());

test.describe("Quote V2 narrow-screen accessibility", () => {
  test("320/375 proposal has no horizontal overflow and completes a response by keyboard", async ({
    browserName,
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const width = testInfo.project.name === "webkit-mobile" ? 375 : 320;
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await createQuoteV2E2EFixture();
    let submittedBody: Record<string, unknown> | null = null;

    await page.route(
      `**/api/public/quotes/${fixture.token}/availability`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            availability: {
              state: "empty",
              quoteId: fixture.quoteId,
              versionId: fixture.versionId,
              responseId: null,
              timezone: "America/New_York",
              durationMinutes: 120,
              travelBufferMinutes: 30,
              arrivalWindowMeaning:
                "The selected time is the scheduled service start in the timezone shown. Stonegate will confirm any separate arrival window in the booking confirmation.",
              recommendedSlots: [],
              days: [{ date: "2026-09-08", slots: [] }],
              generatedAt: "2026-08-31T16:00:00.000Z",
            },
          }),
        }),
    );
    await page.route(
      `**/api/public/quotes/${fixture.token}/changes`,
      async (route) => {
        submittedBody = route.request().postDataJSON() as Record<
          string,
          unknown
        >;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "x-correlation-id": randomUUID() },
          body: JSON.stringify({
            ok: true,
            data: {
              quoteId: fixture.quoteId,
              versionId: fixture.versionId,
              responseId: randomUUID(),
              responseType: "change_requested",
            },
          }),
        });
      },
    );

    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", {
        name: /Fixed quote for North warehouse cleanout/i,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
      })),
    ).toEqual({ viewport: width, page: width });

    for (const action of ["Approve & continue", "Request changes"]) {
      const box = await page
        .getByRole("button", { name: action })
        .first()
        .boundingBox();
      expect(
        box,
        `${action} must remain measurable at ${width}px`,
      ).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const requestChanges = page
      .getByRole("button", { name: "Request changes" })
      .first();
    await requestChanges.focus();
    await expect(requestChanges).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Request changes" }),
    ).toBeVisible();
    await expect(page.locator("#quote-v2-response")).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.getByLabel("What needs to change?")).toBeFocused();
    await page.keyboard.press("Tab");
    const details = page.getByRole("textbox", { name: "Details", exact: true });
    await expect(details).toBeFocused();
    await details.fill("Please revise the service access assumption.");
    // macOS WebKit uses Option+Tab to include buttons when the system's full
    // keyboard-access preference is off; this is the equivalent user path.
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    const submit = page.getByRole("button", { name: "Send change request" });
    await expect(submit).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByText(/Change request received/u)).toBeVisible();
    expect(submittedBody).toMatchObject({
      quoteId: fixture.quoteId,
      versionId: fixture.versionId,
      category: "scope",
      message: "Please revise the service access assumption.",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);

    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface: `Quote V2 customer proposal ${width}px`,
      state: "normal",
      context: "main",
    });
  });
});
