import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect, type Page } from "@playwright/test";
import type { PartnerRequestDetails } from "@myst-os/sdk";
import tailwindConfig from "../apps/site/tailwind.config";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const theme = (
  "default" in tailwindConfig ? tailwindConfig.default : tailwindConfig
) as typeof tailwindConfig;
const fixture: PartnerRequestDetails = {
  version: 1,
  jobId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  accountName: "Sample Bakery",
  service: {
    key: "cleanout",
    label: "Facility cleanout",
    tierKey: "large",
    tierLabel: "Large collection",
  },
  publicStatus: "requested",
  confirmationMode: "review",
  originalJob: null,
  visibility: { financials: true, photos: true },
  location: {
    id: "location-1",
    name: "Bakery warehouse",
    externalPropertyId: "BAKERY-NORTH",
    timezone: "America/New_York",
    address: {
      line1: "100 Sample Road",
      line2: "Suite 8",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    },
  },
  description:
    "Remove the old shelving and twelve empty ingredient boxes. Keep the labelled delivery pallets.",
  onSiteContact: {
    name: "Morgan Lee",
    phone: "+14045550100",
    email: "morgan@example.test",
  },
  alternateContact: {
    name: "Taylor Reed",
    phone: "+14045550102",
    email: "taylor@example.test",
  },
  accessDetails: "Use the loading dock on the east side.",
  crewInstructions: "Keep the cold-room door closed while working.",
  scope: {
    itemCount: 12,
    volumeCubicYards: 4,
    restrictedItems: true,
    nonStandard: true,
    hazardCategories: ["paint"],
    equipmentNeeds: ["heavy_lift"],
    requiredCompletion: { localDate: "2026-10-04", localTime: "16:00" },
    multiStop: true,
    multiStopDetails: "Collect the second shelf from Suite 9.",
    additionalFields: [],
  },
  addOns: [
    {
      key: "stairs",
      label: "Stair carry",
      unitLabel: "floor",
      quantity: 3,
      unitAmountMinor: 4500,
      lineTotalMinor: 13500,
      currency: "USD",
      requiresReview: true,
    },
  ],
  commercial: {
    poNumber: "PO-BAKERY-123",
    costCenter: "OPS-41",
    projectReference: "Autumn fitout",
    billingContact: { name: "Jordan Finance", email: "accounts@example.test" },
  },
  proof: { before: 0, after: 2, package: true },
  scheduling: {
    timezone: "America/New_York",
    preferredWindows: [
      {
        localDate: "2026-10-02",
        timeOfDay: "afternoon",
        timezone: "America/New_York",
      },
    ],
    requestedWindow: null,
    confirmedWindow: null,
    confirmedStartAt: null,
    assistancePreference: "callback",
  },
  photos: { count: 1, detailPath: "/staff/request/photos" },
};
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{PartnerRequestDetailsPanel}from'./src/app/team/components/PartnerRequestDetailsPanel';
const fixture=${JSON.stringify(fixture)};function App(){const[data,setData]=React.useState(fixture);React.useEffect(()=>{window.__setRequest=setData},[]);const dark=new URLSearchParams(location.search).get('dark')==='1';return <main className={'mx-auto min-h-screen max-w-3xl p-4 '+(dark?'bg-slate-950':'bg-white')}><h1 className={'text-lg font-semibold '+(dark?'text-white':'text-slate-950')}>Staff booking</h1><PartnerRequestDetailsPanel compact appearance={dark?'dark':'light'} details={data}/></main>}createRoot(document.getElementById('root')).render(<App/>);`;
let built: Promise<{ script: Uint8Array; css: string }> | undefined;
function assets() {
  return (built ??= (async () => {
    const [bundle, styles] = await Promise.all([
      build({
        stdin: {
          contents: entry,
          resolveDir: `${repo}/apps/site`,
          loader: "tsx",
        },
        absWorkingDir: `${repo}/apps/site`,
        tsconfig: `${repo}/apps/site/tsconfig.json`,
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        minify: true,
        define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
        logLevel: "error",
        plugins: [
          {
            name: "local-staff-action",
            setup(builder: any) {
              builder.onResolve(
                { filter: /^\.\.\/actions\/partner-service-reviews$/ },
                () => ({ path: "staff-action", namespace: "fixture" }),
              );
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                loader: "js",
                contents:
                  "export const loadPartnerServiceReviews=()=>fetch('/photo-response').then(response=>response.json())",
              }));
            },
          },
        ],
      }),
      siteRequire("postcss")([
        siteRequire("tailwindcss")({
          ...theme,
          content: [
            `${repo}/apps/site/src/app/team/components/PartnerRequestDetailsPanel.tsx`,
            { raw: entry, extension: "tsx" },
          ],
        }),
      ]).process(
        readFileSync(`${repo}/apps/site/src/app/globals.css`, "utf8"),
        { from: undefined },
      ),
    ]);
    return { script: bundle.outputFiles[0].contents, css: styles.css };
  })());
}
async function replace(page: Page, value: unknown) {
  await page.evaluate(
    (next) =>
      (
        window as unknown as { __setRequest: (value: unknown) => void }
      ).__setRequest(next),
    value,
  );
}
async function open(page: Page, title: string) {
  const summary = page
    .locator("summary")
    .filter({ hasText: new RegExp(`^${title}`) });
  const expanded = await summary.evaluate((element) =>
    element.parentElement?.hasAttribute("open"),
  );
  if (!expanded) {
    await summary.focus();
    await summary.press("Enter");
  }
}
async function fits(page: Page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
    "Partner request fits the viewport",
  );
}

for (const engine of [chromium, webkit])
  for (const width of [1440, 375]) {
    void test(
      `${engine.name()} ${width}px: complete partner details, safe visibility and photo refresh recovery`,
      { timeout: 60_000 },
      async () => {
        const output = await assets();
        let mode: "ok" | "malformed" | "failed" = "ok";
        let reads = 0;
        const server = createServer((request, response) => {
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          if (path === "/client.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(output.script);
          } else if (path === "/styles.css") {
            response.setHeader("Content-Type", "text/css");
            response.end(output.css);
          } else if (path === "/photo.png") {
            response.setHeader("Content-Type", "image/png");
            response.end(
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4HsAAAAASUVORK5CYII=",
                "base64",
              ),
            );
          } else if (path === "/photo-response") {
            reads++;
            response.setHeader("Content-Type", "application/json");
            response.end(
              JSON.stringify(
                mode === "failed"
                  ? {
                      ok: false,
                      message: "Photos are temporarily unavailable.",
                    }
                  : {
                      ok: true,
                      detail: {
                        id: fixture.jobId,
                        accountId: fixture.accountId,
                        photos:
                          mode === "malformed"
                            ? [{ id: "broken" }]
                            : [
                                {
                                  id: "photo-1",
                                  category: "issue",
                                  filename: "loading-dock.png",
                                  caption:
                                    "Inspect the loading dock before arrival.",
                                  status: "ready",
                                  url: `http://${request.headers.host}/photo.png`,
                                },
                              ],
                      },
                    },
              ),
            );
          } else {
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
            );
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const browser = await engine.launch();
        try {
          const page = await browser.newPage({
            viewport: { width, height: 1000 },
          });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(
            `http://127.0.0.1:${address.port}/?dark=${width === 375 ? "1" : "0"}`,
          );
          await expect(
            page.getByText(fixture.description!, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(fixture.crewInstructions!, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByLabel("Important work instructions"),
          ).toContainText("Paint or coatings");
          const directory =
            process.env["PARTNER_REQUEST_DETAILS_PREVIEW_DIR"] ??
            "/tmp/stonegate-partner-request-panel";
          mkdirSync(directory, { recursive: true });
          await page.screenshot({
            path: `${directory}/${engine.name()}-${width}-compact.png`,
            fullPage: true,
          });
          // WebKit can report a nested native summary as visible while its
          // ancestor details is closed. Check the disclosure and real tab order.
          const outerSummary = page
            .locator("summary")
            .filter({ hasText: /^Request details/ });
          await expect(outerSummary.locator("..")).toHaveJSProperty(
            "open",
            false,
          );
          await outerSummary.focus();
          await page.keyboard.press("Tab");
          assert.equal(
            await page.evaluate(() => {
              const active = document.activeElement;
              return (
                active instanceof HTMLElement &&
                Boolean(active.closest("details:not([open])"))
              );
            }),
            false,
            "Closed request groups must not receive keyboard focus",
          );
          assert.equal(
            (await page.locator("main").ariaSnapshot()).includes(
              "Contact and access",
            ),
            false,
            "Closed request groups must not be exposed in the accessibility tree",
          );
          await fits(page);
          await open(page, "Request details");
          for (const title of [
            "Service details",
            "Contact and access",
            "Special requirements",
            "Work order and billing",
            "Completion photos",
            "Scheduling",
          ])
            await open(page, title);
          for (const value of [
            "Multiple-person or heavy lift",
            "Paint or coatings",
            "Collect the second shelf from Suite 9.",
            "4 cubic yards",
            "Taylor Reed",
            "Suite 8",
            "OPS-41",
            "Autumn fitout",
            "accounts@example.test",
            "$135.00",
            "0 photos",
            "Call to arrange service",
          ])
            await expect(
              page.getByText(value, { exact: false }).first(),
            ).toBeVisible();
          const specialSummary = page
            .locator("summary")
            .filter({ hasText: /^Special requirements/ });
          const specialBody = specialSummary.locator("..");
          const originalSpecialText = await specialBody.innerText();
          await specialSummary.focus();
          await specialSummary.press("Space");
          await expect(specialBody).toHaveJSProperty("open", false);
          await expect(specialSummary).toContainText("Multiple stops");
          await open(page, "Special requirements");
          assert.equal(
            await specialBody.innerText(),
            originalSpecialText,
            "The CRM preserves every requirement when its disclosure is closed and reopened",
          );
          await fits(page);
          await page.screenshot({
            path: `${directory}/${engine.name()}-${width}-expanded.png`,
            fullPage: true,
          });
          await open(page, "Photos");
          await expect(
            page.getByText("loading-dock.png", { exact: true }),
          ).toBeVisible();
          await expect(page.getByText("issue", { exact: true })).toBeVisible();
          await expect(
            page.getByText("Inspect the loading dock before arrival.", {
              exact: true,
            }),
          ).toBeVisible();
          mode = "malformed";
          await page
            .getByRole("button", { name: "Refresh photos", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "Photos could not be loaded",
          );
          await expect(
            page.getByText("loading-dock.png", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText("No photos were attached.", { exact: true }),
          ).toHaveCount(0);
          mode = "failed";
          await page
            .getByRole("button", { name: "Try loading photos again" })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "temporarily unavailable",
          );
          await expect(
            page.getByText("loading-dock.png", { exact: true }),
          ).toBeVisible();
          mode = "ok";
          await page
            .getByRole("button", { name: "Try loading photos again" })
            .click();
          await expect(page.getByRole("alert")).toHaveCount(0);
          assert.equal(reads, 4);
          // Older requests still carry structured quantities and equipment
          // removed from the new-request questions. Staff must retain them.
          await replace(page, {
            ...fixture,
            scope: {
              ...fixture.scope,
              itemCount: 0,
              equipmentNeeds: ["demolition", "heavy_lift", "lift_gate"],
            },
          });
          await open(page, "Service details");
          await open(page, "Special requirements");
          const itemCount = page
            .getByText("Item count", { exact: true })
            .locator("..")
            .locator("dd");
          await expect(itemCount).toBeVisible();
          await expect(itemCount).toHaveText("0");
          for (const value of [
            "4 cubic yards",
            "Lift gate or loading equipment",
            "Light demolition",
          ])
            await expect(
              page.getByText(value, { exact: false }).first(),
            ).toBeVisible();
          await fits(page);
          await replace(page, {
            ...fixture,
            visibility: { financials: false, photos: false },
            commercial: {
              ...fixture.commercial,
              poNumber: "PO-" + "A".repeat(150),
            },
          });
          await expect(
            page.getByText("accounts@example.test", { exact: true }),
          ).toHaveCount(0);
          await expect(page.getByText(/\$135\.00/)).toHaveCount(0);
          await expect(
            page.getByText("Your role cannot view these partner photos."),
          ).toBeVisible();
          await fits(page);
          await replace(page, {
            ...fixture,
            photos: { count: 0, detailPath: null },
          });
          await expect(
            page.getByText("No photos were attached.", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText("Your role cannot view these partner photos."),
          ).toHaveCount(0);
          for (const [publicStatus, summary] of [
            ["canceled", "Request canceled"],
            ["declined", "Request declined"],
          ]) {
            await replace(page, { ...fixture, publicStatus });
            await expect(
              page.locator("summary").filter({ hasText: /^Scheduling/ }),
            ).toContainText(summary!);
            await expect(
              page.getByText("Staff confirmation required", { exact: true }),
            ).toHaveCount(0);
          }
          await replace(page, { ...fixture, scope: null });
          await expect(page.getByRole("alert")).toContainText(
            "could not be verified",
          );
          await replace(page, fixture);
          await expect(
            page.getByText(fixture.description!, { exact: true }),
          ).toBeVisible();
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }
