import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require("@playwright/test");
const base = process.env["PARTNER_BROWSER_SITE_URL"] ?? "http://127.0.0.1:3100";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error(
    "This browser suite is restricted to the local rehearsal server",
  );
const artifactDir = await mkdtemp(
  join(tmpdir(), "stonegate-partner-service-browser-"),
);
const results: unknown[] = [];
for (const engine of [chromium, firefox, webkit]) {
  test(
    `${engine.name()}: compact access, keyboard, no overflow and automated accessibility`,
    { timeout: 120_000 },
    async () => {
      const browser = await engine.launch();
      try {
        for (const width of [320, 375, 768, 1024, 1440]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            reducedMotion: "reduce",
          });
          const page = await context.newPage();
          for (const path of [
            "/partners",
            "/partners/login",
            "/partners/request-access",
            "/partners/forgot-password",
          ]) {
            const response = await page.goto(`${base}${path}`);
            assert.ok(response?.ok(), `${path} loads`);
            assert.match(
              await page.locator('meta[name="robots"]').getAttribute("content"),
              /noindex/u,
            );
            assert.ok(
              await page
                .locator('a[href="mailto:sales@stonegatejunkremoval.com"]')
                .count(),
            );
            assert.ok(await page.locator('a[href="tel:+14047772631"]').count());
            if (path === "/partners" || path === "/partners/login") {
              assert.equal(
                await page.locator('input[name="email"]').count(),
                1,
              );
              assert.equal(
                await page.locator('input[name="password"]').count(),
                1,
              );
              assert.equal(
                await page
                  .locator("form")
                  .evaluate((form: HTMLFormElement) => form.method),
                "post",
              );
              await page.getByRole("button", { name: "Show password" }).click();
              assert.equal(
                await page
                  .locator('input[name="password"]')
                  .getAttribute("type"),
                "text",
              );
              await page.getByRole("button", { name: "Hide password" }).click();
            }
            if (path === "/partners/request-access")
              assert.equal(await page.locator("form").count(), 0);
            assert.equal(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth > window.innerWidth + 1,
              ),
              false,
              `${path} at ${width}px overflows`,
            );
            await page.addScriptTag({
              path: require.resolve("axe-core/axe.min.js"),
            });
            const axe = await page.evaluate(async () =>
              (window as any).axe.run(document, {
                runOnly: {
                  type: "tag",
                  values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
                },
              }),
            );
            results.push({
              browser: engine.name(),
              width,
              path,
              violations: axe.violations.map((item: any) => ({
                id: item.id,
                nodes: item.nodes.map((node: any) => node.target),
              })),
            });
            await writeFile(
              join(artifactDir, "results.json"),
              JSON.stringify(results, null, 2),
            );
            assert.deepEqual(
              axe.violations.map((item: any) => ({
                id: item.id,
                targets: item.nodes.map((node: any) => node.target),
              })),
              [],
              `${path} accessibility at ${width}px`,
            );
            if (path === "/partners") {
              await page.screenshot({
                path: join(artifactDir, `${engine.name()}-${width}.png`),
                fullPage: true,
              });
              await page.keyboard.press("Tab");
              assert.ok(await page.locator("body").textContent());
            }
          }
          await context.close();
        }
      } finally {
        await browser.close();
      }
    },
  );
}
test(
  "anonymous cache, retired applicant cookie, stale session and no-JavaScript credential fallback",
  { timeout: 60_000 },
  async () => {
    const response = await fetch(`${base}/partners`);
    assert.doesNotMatch(
      response.headers.get("cache-control") ?? "",
      /private|no-store/u,
    );
    const html = await response.text();
    assert.match(html, /name="password"/u);
    assert.doesNotMatch(
      html,
      /Example workspace|Choose your plan|Start a trial/u,
    );
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ javaScriptEnabled: false });
      await context.addCookies([
        {
          name: "myst-partner-application",
          value: "retired-applicant-cookie",
          url: base,
        },
      ]);
      const page = await context.newPage();
      await page.goto(`${base}/partners`);
      assert.equal(new URL(page.url()).pathname, "/partners");
      await context.addCookies([
        { name: "myst-partner-session", value: "malformed", url: base },
      ]);
      await page.goto(`${base}/partners`);
      assert.equal(await page.locator('input[name="password"]').count(), 1);
      assert.ok(
        !(await context.cookies()).some(
          (cookie: any) => cookie.name === "myst-partner-session",
        ),
      );
      await page
        .getByLabel("Email", { exact: true })
        .fill("unknown-local-partner@example.test");
      const password = "Not a real partner password 2026!";
      await page.locator('input[name="password"]').fill(password);
      const requests: Array<{ method: string; url: string }> = [];
      page.on("request", (request: any) => {
        if (request.isNavigationRequest())
          requests.push({ method: request.method(), url: request.url() });
      });
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(/\/partners\/login\?error=/u);
      assert.ok(requests.some((request) => request.method === "POST"));
      assert.ok(
        requests.every(
          (request) => !decodeURIComponent(request.url).includes(password),
        ),
      );
      assert.ok(
        await page
          .locator('a[href="mailto:sales@stonegatejunkremoval.com"]')
          .count(),
      );
      await context.close();
    } finally {
      await browser.close();
    }
  },
);
console.log(`Browser evidence: ${artifactDir}`);
