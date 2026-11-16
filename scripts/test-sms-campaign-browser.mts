import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

// Run against the isolated preview described in the campaign runbook.
const origin = "http://localhost:3200";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: "myst-team-session",
      value: "local-campaign-owner-preview-no-real-account",
      domain: "localhost",
      path: "/",
    },
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/team/marketing/campaigns`, {
    waitUntil: "networkidle",
  });
  const workspace = await (
    await context.request.get(`${origin}/api/team/sms-campaigns`)
  ).json();
  assert.equal(
    workspace.readiness.sendsEnabled,
    false,
    "Browser tests require live campaign sends to be disabled",
  );
  await page
    .getByRole("button", { name: "New winter campaign", exact: true })
    .click();
  await expect(
    page.getByText("Draft created. Nothing has been sent."),
  ).toBeVisible({ timeout: 10000 });
  await page
    .getByLabel("Campaign name", { exact: true })
    .fill("Winter sale preview");
  const saleDay = new Date(Date.now() + 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  const serviceDay = new Date(Date.now() + 18 * 86400000)
    .toISOString()
    .slice(0, 10);
  await page
    .getByLabel("Sale ends (Eastern time)", { exact: true })
    .fill(saleDay);
  await page.getByLabel("Last service date", { exact: true }).fill(serviceDay);
  await page.getByLabel(/^Existing quotes/).selectOption("new_quotes_only");
  await page.getByLabel(/^Other promotions/).selectOption("no_stacking");
  await page.getByRole("button", { name: "Save offer", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /saved/i }),
  ).toBeVisible({ timeout: 10000 });
  await page
    .locator("label")
    .filter({ hasText: "Eligible" })
    .first()
    .getByRole("checkbox")
    .check();
  await page
    .getByRole("button", { name: "Review 1 messages", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "4. Review and release this batch" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send this batch of 1" }),
  ).toBeDisabled();
  await page
    .getByRole("heading", { name: "4. Review and release this batch" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/campaign-mobile-review.png" });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `No horizontal overflow at ${width}px`,
    );
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/campaign-desktop-top.png" });
  const unauthorized = await browser.newContext();
  const denied = await unauthorized.request.get(
    `${origin}/api/team/sms-campaigns`,
  );
  assert.ok(denied.status() >= 400, "Anonymous users cannot read the audience");
  const csrf = await context.request.post(`${origin}/api/team/sms-campaigns`, {
    headers: { Origin: "https://untrusted.invalid" },
    data: { action: "create", terms: {} },
  });
  assert.equal(csrf.status(), 403);
  assert.deepEqual(errors, []);
  console.log(
    "PASS desktop/mobile draft, dates, recipient selection, exact review, disabled sends, anonymous access and cross-origin rejection. No messages sent.",
  );
} finally {
  await browser.close();
}
