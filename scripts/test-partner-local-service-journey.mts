import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const base = process.env["PARTNER_BROWSER_SITE_URL"] ?? "http://127.0.0.1:3100";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw Error("Local rehearsal servers only");
const accountId = process.env["PARTNER_BROWSER_ACCOUNT_ID"];
if (!accountId || !/^[0-9a-f-]{36}$/u.test(accountId))
  throw Error(
    "Seed the disposable local browser fixture and provide PARTNER_BROWSER_ACCOUNT_ID",
  );
const password = "Local browser service test passphrase 2026!";

test(
  "real password login, four role views, 105th location and review-only request",
  { timeout: 240_000 },
  async () => {
    const browser = await chromium.launch();
    try {
      for (const role of [
        "administrator",
        "operations",
        "billing_approver",
        "viewer",
      ]) {
        const context = await browser.newContext({
          viewport: { width: 375, height: 900 },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const assertAccessible = async (surface: string) => {
          await page.addScriptTag({
            path: require.resolve("axe-core/axe.min.js"),
          });
          const violations = await page.evaluate(async () => {
            const result = await (window as any).axe.run(document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
              },
            });
            return result.violations.map((violation: any) => ({
              id: violation.id,
              targets: violation.nodes.map((node: any) => node.target),
            }));
          });
          assert.deepEqual(violations, [], `${role}: ${surface} accessibility`);
        };
        page.on("request", async (request: any) => {
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith("/booking-drafts")
          ) {
            const headers = await request.allHeaders();
            console.log(
              JSON.stringify({
                origin: headers["origin"],
                fetchSite: headers["sec-fetch-site"],
                host: new URL(request.url()).host,
                method: "POST",
              }),
            );
          }
        });
        page.on("response", async (response: any) => {
          if (
            response.status() >= 400 &&
            new URL(response.url()).pathname.startsWith("/api/partners/portal/")
          ) {
            const body = await response.json().catch(() => null);
            console.log(
              JSON.stringify({
                status: response.status(),
                path: new URL(response.url()).pathname,
                code:
                  typeof body?.error === "string"
                    ? body.error
                    : body?.error?.code,
                message: body?.message,
              }),
            );
          }
        });
        const browserRequest = {
          get: async (url: string) => {
            const value = await page.evaluate(async (target: string) => {
              const response = await fetch(target);
              return {
                status: response.status,
                body: await response.json().catch(() => null),
              };
            }, url);
            return { status: () => value.status, json: async () => value.body };
          },
        };
        await page.goto(`${base}/partners/login`);
        await page
          .getByLabel("Email", { exact: true })
          .fill(`${role}-${accountId}@example.test`);
        await page.locator('input[name="password"]').fill(password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page.waitForURL(/\/partners\/overview/u, { timeout: 45_000 });
        const meResponse = await browserRequest.get(
          `${base}/api/partners/portal/me`,
        );
        assert.equal(meResponse.status(), 200, `${role} current account`);
        const me = await meResponse.json();
        assert.equal(me.account.id, accountId);
        const overviewResponse = await browserRequest.get(
          `${base}/api/partners/portal/overview`,
        );
        assert.equal(overviewResponse.status(), 200);
        await assertAccessible("job home");
        const overview = await overviewResponse.json();
        if (role === "viewer" || role === "operations")
          assert.equal(
            overview.outstandingBalances,
            null,
            "No billing summary for operational-only users",
          );
        const catalogResponse = await browserRequest.get(
          `${base}/api/partners/portal/service-catalog`,
        );
        if (role === "administrator" || role === "operations") {
          const exportResponse = await browserRequest.get(
            `${base}/api/partners/portal/locations/export`,
          );
          assert.equal(
            exportResponse.status(),
            404,
            "Disabled portfolio tool cannot be used directly",
          );
        }
        const oldestJobId = process.env["PARTNER_BROWSER_OLDEST_JOB_ID"];
        if (role === "administrator" && oldestJobId) {
          assert.match(oldestJobId, /^[0-9a-f-]{36}$/u);
          await page.goto(`${base}/partners/photos?jobId=${oldestJobId}`);
          await page
            .getByRole("heading", { name: "Choose a job to view" })
            .waitFor();
          assert.ok(
            await page
              .locator(`a[aria-current="page"][href*="${oldestJobId}"]`)
              .count(),
          );
          await page
            .getByRole("link", { name: "More jobs", exact: true })
            .click();
          await page.waitForURL(/cursor=/u);
          assert.equal(
            new URL(page.url()).searchParams.get("jobId"),
            oldestJobId,
            "Pagination preserves the selected older job",
          );
          await page
            .getByLabel("Find a job", { exact: true })
            .fill("LOCAL-HISTORY-105");
          await page
            .getByRole("button", { name: "Search jobs", exact: true })
            .click();
          await page.waitForURL(/search=LOCAL-HISTORY-105/u);
          await page
            .getByRole("navigation", { name: "Jobs with proof" })
            .getByRole("link")
            .first()
            .waitFor();
          assert.equal(
            await page
              .getByRole("navigation", { name: "Jobs with proof" })
              .getByRole("link")
              .count(),
            1,
          );
          await assertAccessible("older-job proof search");
          await page.goto(
            `${base}/partners/photos?jobId=00000000-0000-4000-8000-000000000001`,
          );
          await page
            .getByRole("heading", { name: "This job could not be opened" })
            .waitFor();
          assert.equal(
            await page
              .getByRole("heading", { name: "Choose a job to view" })
              .count(),
            0,
            "Missing jobs never fall back to another job",
          );
        }
        if (role === "operations") {
          assert.equal(catalogResponse.status(), 200);
          await page.goto(`${base}/partners/book`);
          await page.getByLabel("Find a saved location").fill("Local site 105");
          const site = page.getByRole("radio", { name: /Local site 105/u });
          await site.check({ timeout: 25_000 });
          await assertAccessible("request location");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await page
            .getByRole("checkbox", { name: "Junk removal", exact: true })
            .check();
          await page
            .getByRole("textbox", {
              name: "What needs to be done?",
              exact: true,
            })
            .fill(
              "Local rehearsal only: remove two empty boxes. No real service requested.",
            );
          await assertAccessible("request scope");
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          const date = new Date();
          date.setDate(date.getDate() + 2);
          await page
            .locator('input[type="date"]')
            .first()
            .fill(date.toISOString().slice(0, 10));
          await assertAccessible("request preferred date");
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await assertAccessible("check and send");
          await page
            .getByRole("button", { name: "Send service request", exact: true })
            .click();
          await page.waitForURL(/\/partners\/bookings\/[0-9a-f-]{36}/u, {
            timeout: 30_000,
          });
          const jobId = new URL(page.url()).pathname.split("/").at(-1)!;
          const jobResponse = await browserRequest.get(
            `${base}/api/partners/portal/jobs/${jobId}`,
          );
          assert.equal(jobResponse.status(), 200);
          const payload = await jobResponse.json();
          const job = payload.job ?? payload.data;
          assert.equal(job.status, "under_review");
          assert.equal(job.confirmationMode, "review");
          assert.equal(job.schedule.arrivalWindow, null);
          assert.equal(job.location.name, "Local site 105");
          await assertAccessible("submitted review request");
          assert.doesNotMatch(
            JSON.stringify(job),
            /appointmentId|providerPayload|commission/u,
          );
        }
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          ),
          false,
          `${role} mobile overflow`,
        );
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
