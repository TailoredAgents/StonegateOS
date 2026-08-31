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

test.describe("Quote V2 200% zoom reflow", () => {
  test("a 1280px desktop proposal remains complete at effective 200% zoom", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-quote-zoom-200",
      "This deterministic zoom proof runs only in its 640 CSS px / 2x project.",
    );
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    const fixture = await createQuoteV2E2EFixture({
      schedulingMode: "approval_only",
    });

    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", {
        name: /Fixed quote for North warehouse cleanout/i,
      }),
    ).toBeVisible();

    const viewport = await page.evaluate(() => ({
      cssWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
      devicePixelRatio: window.devicePixelRatio,
    }));
    expect(viewport).toEqual({
      cssWidth: 640,
      contentWidth: 640,
      devicePixelRatio: 2,
    });
    expect(viewport.cssWidth * viewport.devicePixelRatio).toBe(1_280);

    for (const action of ["Approve & continue", "Request changes"]) {
      const control = page.getByRole("button", { name: action }).first();
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${action} must remain measurable at 200%`).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    // Target the native disclosure control rather than its text node so this
    // remains a real keyboard-focus proof in Chromium's accessibility tree.
    const scopeDisclosure = page
      .locator("summary")
      .filter({ hasText: "Scope, inclusions & exclusions" });
    await expect(scopeDisclosure).toBeVisible();
    await scopeDisclosure.focus();
    await expect(scopeDisclosure).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Labor", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(640);

    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface: "Quote V2 customer proposal at effective 200% zoom",
      state: "scope expanded",
      context: "main",
    });
  });
});
