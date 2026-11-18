import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import postgres from "postgres";

const url = new URL(process.env["DATABASE_URL"] ?? "http://missing");
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/stonegate_individual_sms_test");
assert.equal(process.env["TWILIO_API_BASE_URL"], "http://127.0.0.1:4155");
const db = postgres(url.toString(), { max: 1 });
const browser = await chromium.launch({ headless: true });
const origin = "http://localhost:3003";
try {
  const [owner] = await db<
    { id: string }[]
  >`select id from team_members where name='Fictional Austin'`;
  assert(owner);
  const token = randomUUID();
  await db`insert into team_sessions(team_member_id,session_hash,expires_at) values(${owner.id},${createHash("sha256").update(token).digest("base64url")},now()+interval '1 hour')`;
  const [contact] = await db<
    { id: string }[]
  >`insert into contacts(first_name,last_name,phone,phone_e164) values('Fictional','Browser Prospect','+12025550187','+12025550187') on conflict(phone) do update set first_name='Fictional' returning id`;
  assert(contact);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    { name: "myst-team-session", value: token, domain: "localhost", path: "/" },
  ]);
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/team/marketing/campaigns", {
    waitUntil: "networkidle",
  });
  await page
    .getByRole("button", { name: "New individual 30% campaign", exact: true })
    .click();
  await expect(
    page.getByText("Individual campaign created.", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Sale ends (Eastern time)", { exact: true })
    .fill(new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
  await page
    .getByLabel("Last service date", { exact: true })
    .fill(new Date(Date.now() + 18 * 86400000).toISOString().slice(0, 10));
  await page
    .getByLabel(/^Existing quotes/)
    .selectOption("include_unaccepted_quotes");
  await page.getByLabel(/^Other promotions/).selectOption("no_stacking");
  await page.getByRole("button", { name: "Save offer", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /saved/i }),
  ).toBeVisible();
  const body =
    "Hi Fictional Browser Prospect, Jeffrey at Stonegate here. We have 30% off winter cleanups.";
  await page
    .getByLabel("Reviewed drafts JSON file")
    .setInputFiles({
      name: "fictional-reviewed.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          records: [
            {
              contactId: contact.id,
              body,
              sourceReference: "fictional:browser-reviewed",
            },
          ],
        }),
      ),
    });
  await expect(page.getByText(/1 draft rows loaded locally/)).toBeVisible();
  await page.getByRole("button", { name: "Run dry run", exact: true }).click();
  await expect(
    page.getByText(/1 rows · 1 new versions · 0 unchanged · 0 issues/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import reviewed file", exact: true })
    .click();
  await expect(
    page.getByText("Reviewed drafts imported. Nothing has been sent."),
  ).toBeVisible();
  const [saved] = await db<
    { body: string }[]
  >`select body from sms_campaign_drafts where contact_id=${contact.id}`;
  assert.equal(saved?.body, body);
  await page
    .getByText("Review a contact’s history and exclusions", { exact: true })
    .click();
  await page
    .getByLabel("Exact CRM contact ID", { exact: true })
    .fill(contact.id);
  await page.getByRole("button", { name: "Load review", exact: true }).click();
  await page
    .getByLabel("Relationship", { exact: true })
    .selectOption("quote_only");
  await page
    .getByLabel("Facebook outreach", { exact: true })
    .selectOption("clear");
  await page
    .getByLabel("Secure evidence reference", { exact: true })
    .fill("fictional-vault:review-proof");
  await page
    .getByRole("checkbox", { name: /I reviewed the referenced evidence/ })
    .check();
  await page
    .getByRole("button", { name: "Save owner review", exact: true })
    .click();
  await expect(page.getByText(/History review saved/)).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(
      page.getByText("30% off all services", { exact: true }),
    ).toBeVisible();
    const overflowing = await page.evaluate(() =>
      Array.from(document.querySelectorAll("main *"))
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
        .map((e) => ({
          tag: e.tagName,
          text: e.textContent?.slice(0, 80),
          width: e.getBoundingClientRect().width,
        }))
        .slice(-12),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `Overflow at ${width}px ${JSON.stringify(overflowing)}`,
    );
  }
  await page
    .getByRole("heading", { name: "Import reviewed individual drafts" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../artifacts/individual-sms-owner-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("heading", { name: "Import reviewed individual drafts" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../artifacts/individual-sms-owner-mobile.png",
  });
  const denied = await context.request.post(
    origin + "/api/team/sms-campaigns/drafts",
    { headers: { Origin: "https://untrusted.invalid" }, data: {} },
  );
  assert.equal(denied.status(), 403);
  assert.deepEqual(errors, []);
  const [count] = await db<
    { count: number }[]
  >`select count(*)::int count from sms_campaign_recipients where contact_id=${contact.id}`;
  assert.equal(count!.count, 0);
  console.log(
    "PASS owner UI: 30% campaign, exact draft dry-run/import, evidence review, CSRF, 320/390/1440px layouts; zero sends",
  );
} finally {
  await browser.close();
  await db.end();
}
