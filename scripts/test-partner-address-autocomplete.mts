import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect, type Page } from "@playwright/test";
import tailwindConfig from "../apps/site/tailwind.config";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const postcss = siteRequire("postcss");
const tailwind = siteRequire("tailwindcss");
const suggestions = [
  {
    id: "marietta",
    label: "100 North Main Street, Marietta, GA 30060",
    address: {
      line1: "100 North Main Street",
      city: "Marietta",
      state: "GA",
      postalCode: "30060",
    },
  },
  {
    id: "smyrna",
    label: "100 North Main Street, Smyrna, GA 30080",
    address: {
      line1: "100 North Main Street",
      city: "Smyrna",
      state: "GA",
      postalCode: "30080",
    },
  },
];
const oldSuggestion = {
  id: "old",
  label: "10 Old Search Road, Atlanta, GA 30301",
  address: {
    line1: "10 Old Search Road",
    city: "Atlanta",
    state: "GA",
    postalCode: "30301",
  },
};
const newSuggestion = {
  id: "new",
  label: "20 New Search Road, Decatur, GA 30030",
  address: {
    line1: "20 New Search Road",
    city: "Decatur",
    state: "GA",
    postalCode: "30030",
  },
};
const emptyMessage =
  "No matching addresses found. You can enter the address manually.";
const unavailableMessage =
  "Address suggestions are unavailable. You can enter the address manually.";
type HarnessWindow = Window & {
  submittedForms: number;
  createdLocations: number;
};
type LocationPost = {
  siteName: string;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
  };
};

const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{PartnerInlineLocationForm}from'./src/app/partners/components/PartnerInlineLocationForm';
function App(){React.useEffect(()=>{document.documentElement.dataset.harnessReady='true';const count=()=>window.submittedForms++;document.addEventListener('submit',count);return()=>document.removeEventListener('submit',count)},[]);return <main className="mx-auto max-w-3xl p-4"><h1>Request service</h1><PartnerInlineLocationForm canManage onCreated={()=>window.createdLocations++}/></main>}
createRoot(document.getElementById('root')).render(<App/>);`;
let assetsPromise: Promise<{ script: Uint8Array; css: string }> | undefined;
function assets() {
  return (assetsPromise ??= (async () => {
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
            name: "next-test-boundaries",
            setup(builder: any) {
              builder.onResolve(
                { filter: /^next\/(link|navigation)$/ },
                (args: any) => ({ path: args.path, namespace: "next-test" }),
              );
              builder.onLoad(
                { filter: /.*/, namespace: "next-test" },
                (args: any) => ({
                  loader: "js",
                  resolveDir: `${repo}/apps/site`,
                  contents:
                    args.path === "next/link"
                      ? "import React from'react';export default function Link({href,children,...props}){return React.createElement('a',{...props,href},children)}"
                      : "export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>location.pathname;",
                }),
              );
            },
          },
        ],
      }),
      postcss([
        tailwind({
          ...tailwindConfig,
          content: [
            `${repo}/apps/site/src/app/partners/components/PartnerInlineLocationForm.tsx`,
            `${repo}/apps/site/src/app/partners/components/PartnerAddressAutocomplete.tsx`,
            `${repo}/apps/site/src/app/partners/components/PartnerPortalUi.tsx`,
            { raw: entry, extension: "tsx" },
          ],
        }),
      ]).process("@tailwind base;@tailwind components;@tailwind utilities;", {
        from: undefined,
      }),
    ]);
    return { script: bundle.outputFiles[0].contents, css: styles.css };
  })());
}

function savedLocation(body: LocationPost, sequence: number) {
  return {
    id: `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`,
    siteName: body.siteName,
    externalPropertyId: null,
    address: body.address,
    access: { details: null, parking: null, loading: null },
    onSiteContact: null,
    portfolio: {
      isDefault: false,
      isFavorite: false,
      parentLocationId: null,
      childCount: 0,
      directoryVersion: 1,
      mergedIntoLocationId: null,
      mergedAt: null,
    },
    addressVerification: {
      status: "review_required",
      provider: "unconfigured",
      confidence: null,
      suggestedAddress: null,
      verifiedAt: null,
    },
    serviceArea: { status: "review", reason: null },
    active: true,
    revision: 1,
    etag: '"location-1"',
    updatedAt: "2026-09-14T12:00:00Z",
  };
}

async function openForm(page: Page) {
  await page
    .getByRole("button", {
      name: "Add a location without leaving",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Location name", { exact: true })
    .fill("Service location");
  await page.getByLabel(/Suite, unit, building, or floor/).fill("Suite 5");
  await page.getByLabel("City", { exact: true }).fill("Original city");
  await page.getByLabel("State", { exact: true }).fill("AL");
  await page.getByLabel("ZIP code", { exact: true }).fill("99999");
}

for (const engine of [chromium, webkit]) {
  for (const width of [1440, 375]) {
    void test(
      `${engine.name()} ${width}px: inline address suggestions preserve manual entry, units, keyboard control and current results`,
      { timeout: 60_000 },
      async () => {
        const compiled = await assets();
        const server = createServer((request, response) => {
          if (request.url === "/client.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(compiled.script);
          } else if (request.url === "/styles.css") {
            response.setHeader("Content-Type", "text/css");
            response.end(compiled.css);
          } else {
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script>window.submittedForms=0;window.createdLocations=0;</script><script src="/client.js"></script></body></html>',
            );
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const browser = await engine.launch();
        let releaseOld: (() => void) | undefined;
        try {
          const page = await browser.newPage({
            viewport: { width, height: 1000 },
            hasTouch: width === 375,
            isMobile: width === 375,
          });
          page.setDefaultTimeout(8_000);
          const pageErrors: string[] = [],
            requests: string[] = [];
          const locations: LocationPost[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          // Simulate a transport that cannot cancel an already dispatched lookup.
          // The real component must still reject an older response after new input.
          await page.addInitScript(() => {
            const originalFetch = window.fetch.bind(window);
            window.fetch = (input, init) => {
              const url =
                typeof input === "string"
                  ? input
                  : input instanceof URL
                    ? input.href
                    : input.url;
              return originalFetch(
                input,
                url.includes("/address-suggestions")
                  ? { ...init, signal: undefined }
                  : init,
              );
            };
          });
          let oldStarted: (() => void) | undefined;
          const oldRequestStarted = new Promise<void>((resolve) => {
            oldStarted = resolve;
          });
          const oldGate = new Promise<void>((resolve) => {
            releaseOld = resolve;
          });
          await page.route("**/api/partners/portal/**", async (route) => {
            const request = route.request(),
              url = new URL(request.url());
            if (url.pathname.endsWith("/address-suggestions")) {
              assert.equal(request.method(), "POST");
              assert.equal(
                url.search,
                "",
                "Partial addresses stay out of URLs",
              );
              const body = request.postDataJSON() as { query: string };
              assert.equal(typeof body.query, "string");
              requests.push(body.query);
              if (body.query === "Old search") {
                oldStarted?.();
                await oldGate;
                await route
                  .fulfill({
                    json: {
                      ok: true,
                      suggestions: [oldSuggestion],
                      attribution: "© Mapbox",
                    },
                  })
                  .catch(() => undefined);
                return;
              }
              if (body.query === "700 Offline Avenue")
                return route.abort("failed");
              const matches =
                body.query === "100"
                  ? suggestions
                  : body.query === "New search"
                    ? [newSuggestion]
                    : [];
              return route.fulfill({
                json: {
                  ok: true,
                  suggestions: matches,
                  attribution: "© Mapbox",
                },
              });
            }
            assert.equal(url.pathname, "/api/partners/portal/locations");
            assert.equal(request.method(), "POST");
            const body = request.postDataJSON() as LocationPost;
            locations.push(body);
            return route.fulfill({
              json: {
                ok: true,
                location: savedLocation(body, locations.length),
              },
            });
          });
          await page.goto(`http://127.0.0.1:${address.port}/`);
          await expect(page.locator("html")).toHaveAttribute(
            "data-harness-ready",
            "true",
          );
          await openForm(page);
          const input = page.getByRole("combobox", {
            name: "Street address",
            exact: true,
          });
          await input.fill("10");
          await page.waitForTimeout(450);
          assert.equal(
            requests.length,
            0,
            "Fewer than three characters do not trigger lookup",
          );
          await input.fill("100");
          await expect(page.getByRole("option")).toHaveCount(2);
          await expect(input).toHaveAttribute("aria-expanded", "true");
          await expect(page.getByLabel("City", { exact: true })).toHaveValue(
            "Original city",
          );
          const dropdown = await page.getByRole("listbox").boundingBox();
          assert.ok(
            dropdown &&
              dropdown.x >= 0 &&
              dropdown.x + dropdown.width <= width + 1,
            "Suggestion dropdown fits the viewport",
          );
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
            "No horizontal page overflow",
          );
          if (width === 375 && process.env["PARTNER_ADDRESS_SCREENSHOT"]) {
            await page.screenshot({
              path: process.env["PARTNER_ADDRESS_SCREENSHOT"],
              fullPage: true,
            });
          }
          const option = page.getByRole("option", {
            name: suggestions[1].label,
            exact: true,
          });
          if (width === 375) await option.tap();
          else await option.click();
          await expect(input).toHaveValue(suggestions[1].address.line1);
          await expect(page.getByLabel("City", { exact: true })).toHaveValue(
            "Smyrna",
          );
          await expect(page.getByLabel("State", { exact: true })).toHaveValue(
            "GA",
          );
          await expect(
            page.getByLabel("ZIP code", { exact: true }),
          ).toHaveValue("30080");
          await expect(
            page.getByLabel(/Suite, unit, building, or floor/),
          ).toHaveValue("Suite 5");
          await page.waitForTimeout(450);
          await expect(page.getByRole("listbox")).toHaveCount(0);
          assert.equal(
            locations.length,
            0,
            "Selecting an address does not save the form",
          );

          await page.getByLabel("City", { exact: true }).fill("Custom city");
          await input.fill("101 Edited Street");
          await expect(page.getByLabel("City", { exact: true })).toHaveValue(
            "Custom city",
          );
          await expect(page.getByLabel("State", { exact: true })).toHaveValue(
            "",
          );
          await expect(
            page.getByLabel("ZIP code", { exact: true }),
          ).toHaveValue("");
          await expect(
            page.getByLabel(/Suite, unit, building, or floor/),
          ).toHaveValue("Suite 5");
          // Keep every required field valid so a missing Enter guard would submit.
          await page.getByLabel("State", { exact: true }).fill("GA");
          await page.getByLabel("ZIP code", { exact: true }).fill("30301");

          await input.fill("100");
          await expect(page.getByRole("option")).toHaveCount(2);
          await input.press("ArrowDown");
          const firstActive = await input.getAttribute("aria-activedescendant");
          assert.ok(firstActive);
          await expect(page.getByRole("option", { selected: true })).toHaveText(
            suggestions[0].label,
          );
          await input.press("ArrowDown");
          assert.notEqual(
            await input.getAttribute("aria-activedescendant"),
            firstActive,
          );
          await input.press("ArrowUp");
          await expect(input).toHaveAttribute(
            "aria-activedescendant",
            firstActive,
          );
          await input.press("Enter");
          await expect(page.getByLabel("City", { exact: true })).toHaveValue(
            "Marietta",
          );
          await expect(
            page.getByLabel("ZIP code", { exact: true }),
          ).toHaveValue("30060");
          assert.equal(
            await page.evaluate(() => (window as HarnessWindow).submittedForms),
            0,
            "Enter selects an address without submitting the valid form",
          );
          await input.fill("100");
          await expect(page.getByLabel("City", { exact: true })).toHaveValue(
            "",
          );
          await expect(page.getByLabel("State", { exact: true })).toHaveValue(
            "",
          );
          await expect(
            page.getByLabel("ZIP code", { exact: true }),
          ).toHaveValue("");
          await expect(page.getByRole("listbox")).toBeVisible();
          await input.press("Escape");
          await expect(page.getByRole("listbox")).toHaveCount(0);
          await expect(input).toHaveValue("100");

          for (const [street, message, city, postalCode] of [
            ["999 Manual Lane", emptyMessage, "Athens", "30601"],
            ["700 Offline Avenue", unavailableMessage, "Decatur", "30030"],
          ]) {
            if (locations.length) await openForm(page);
            await input.fill(street);
            await expect(
              page.getByText(message, { exact: false }),
            ).toBeVisible();
            if (street === "700 Offline Avenue") {
              await expect(
                page.getByText(message, { exact: false }),
              ).toContainText(/Support reference: portal_[a-z0-9]+/u);
            }
            await expect(input).toHaveValue(street);
            await page.getByLabel("City", { exact: true }).fill(city);
            await page.getByLabel("State", { exact: true }).fill("GA");
            await page.getByLabel("ZIP code", { exact: true }).fill(postalCode);
            const expectedCount = locations.length + 1;
            await page
              .getByRole("button", {
                name: "Save and use this location",
                exact: true,
              })
              .click();
            await expect.poll(() => locations.length).toBe(expectedCount);
            await expect
              .poll(() =>
                page.evaluate(() => (window as HarnessWindow).createdLocations),
              )
              .toBe(expectedCount);
            assert.deepEqual(locations.at(-1)?.address, {
              line1: street,
              line2: "Suite 5",
              city,
              state: "GA",
              postalCode,
            });
          }

          await openForm(page);
          const submissionsBeforeLookup = await page.evaluate(
            () => (window as HarnessWindow).submittedForms,
          );
          await input.fill("Old search");
          await input.press("Enter");
          assert.equal(
            await page.evaluate(() => (window as HarnessWindow).submittedForms),
            submissionsBeforeLookup,
            "Enter during the debounce does not submit",
          );
          await oldRequestStarted;
          await input.press("Enter");
          assert.equal(
            await page.evaluate(() => (window as HarnessWindow).submittedForms),
            submissionsBeforeLookup,
            "Enter during a held lookup does not submit",
          );
          assert.equal(locations.length, 2);
          await input.fill("New search");
          await expect(
            page.getByRole("option", {
              name: newSuggestion.label,
              exact: true,
            }),
          ).toBeVisible();
          const oldResponse = page.waitForResponse(
            (response) =>
              response.url().endsWith("/address-suggestions") &&
              (response.request().postDataJSON() as { query?: string })
                .query === "Old search",
          );
          releaseOld?.();
          await oldResponse;
          await page.evaluate(() => new Promise(requestAnimationFrame));
          await expect(
            page.getByRole("option", {
              name: oldSuggestion.label,
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("option", {
              name: newSuggestion.label,
              exact: true,
            }),
          ).toBeVisible();
          await expect(input).toHaveValue("New search");
          await expect(page.getByLabel("City", { exact: true })).toHaveValue(
            "Original city",
          );
          assert.deepEqual(
            pageErrors,
            [],
            "The real form has no client rendering errors",
          );
        } finally {
          releaseOld?.();
          await browser.close();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  }
}
