import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const [directory, mode] = process.argv.slice(2);
if (!directory || !["baseline", "cloudflare"].includes(mode))
  throw Error(
    "Usage: site-browser-validation.mjs PRIVATE_DIRECTORY baseline|cloudflare",
  );
const origin = "https://stonegatejunkremoval.com";
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    for (const route of [
      "/",
      "/book",
      "/partners/login",
      "/team/login",
      "/mobile/login",
    ]) {
      const page = await context.newPage();
      const errors = [];
      const failed = [];
      let scriptCount = 0;
      page.on("pageerror", (e) => errors.push(e.message.slice(0, 240)));
      page.on("response", (r) => {
        const url = new URL(r.url());
        if (url.origin !== origin) return;
        if (url.pathname.startsWith("/_next/static/") && r.ok()) scriptCount++;
        if (r.status() >= 400 && url.pathname.startsWith("/_next/"))
          failed.push({ path: url.pathname, status: r.status() });
      });
      const started = performance.now();
      const response = await page.goto(origin + route, {
        waitUntil: "networkidle",
        timeout: 45000,
      });
      const visible = (await page.locator("body").innerText()).trim().length;
      const check = {
        width,
        route,
        status: response.status(),
        hosting: response.headers()["x-stonegate-hosting"] ?? "origin",
        visibleCharacters: visible,
        scriptResponses: scriptCount,
        pageErrors: errors,
        failedAssets: failed,
        ms: Math.round(performance.now() - started),
      };
      check.pass =
        check.status === 200 &&
        visible > 100 &&
        scriptCount > 0 &&
        errors.length === 0 &&
        failed.length === 0 &&
        (mode !== "cloudflare" || check.hosting === "cloudflare");
      checks.push(check);
      await page.close();
    }
    await context.close();
  }
} catch (error) {
  checks.push({ pass: false, error: error.name });
} finally {
  await browser.close();
}
const receipt = {
  at: new Date().toISOString(),
  mode,
  ok: checks.length === 10 && checks.every((x) => x.pass),
  checks,
  navigationOnly: true,
};
await writeFile(
  path.join(directory, "site-browser-" + mode + "-" + Date.now() + ".json"),
  JSON.stringify(receipt, null, 2),
  { mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify(receipt));
if (!receipt.ok) process.exitCode = 1;
