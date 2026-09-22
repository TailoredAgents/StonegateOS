import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { completeTestPartnerRateCard } from "../apps/api/src/__tests__/fixtures/partner-service-rates";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const card = completeTestPartnerRateCard();
card.rates = card.rates.filter(
  (rate) => !["painting", "drywall-repair-paint"].includes(rate.serviceKey),
);
const initial = {
  accountId: "11111111-1111-4111-8111-111111111111",
  accountName: "Local quote setup",
  revision: "1",
  draft: card,
  portalVisible: true,
  setupStatus: "rates_required",
  published: null,
};
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{PartnerServiceRatesEditor}from'./src/app/team/components/PartnerServiceRatesEditor';import{PartnerServiceRates}from'./src/app/partners/components/PartnerServiceRates';
function App(){const[ready,setReady]=React.useState(false);return <main><PartnerServiceRatesEditor accountId='${initial.accountId}' canManage onPublished={setReady}/><p>{ready?'Ready to activate':'Pricing setup incomplete'}</p><aside aria-label='Partner preview'><PartnerServiceRates serviceKey='painting' card={{versionId:'saved',currency:'USD',visitMinimum:null,rates:[],quoteRequiredServiceKeys:['painting']}} status='published'/></aside></main>};createRoot(document.getElementById('root')).render(<App/>);`;
let bundle: Promise<Uint8Array> | null = null;
function compile() {
  return (bundle ??= build({
    stdin: { contents: entry, loader: "tsx", resolveDir: `${repo}/apps/site` },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
    plugins: [
      {
        name: "local-actions",
        setup(b: any) {
          b.onResolve({ filter: /actions\/partner-service-rates$/ }, () => ({
            path: "actions",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            resolveDir: repo,
            contents: `import{getPartnerRateCompleteness}from'./packages/pricing/src/partner-services';
    window.__saves=[];const load=()=>JSON.parse(localStorage.getItem('quoteSetup')||'null')||${JSON.stringify(initial)};
    export async function loadPartnerServiceRates(){return{ok:true,data:load()}};
    export async function savePartnerServiceRates(input){window.__saves.push(input);const data=load();data.revision=String(Number(data.revision)+1);data.draft=input.change.card;
    if(input.change.action==='publish'){const card=input.change.card;const keys=card.quoteRequiredServiceKeys||[];const rates=card.rates.filter(r=>r.unitAmount.trim()&&!keys.includes(r.serviceKey));data.published={...card,rates,source:'structured',legacyItems:[],quoteRequiredServiceKeys:keys,...getPartnerRateCompleteness(rates,keys)};}
    localStorage.setItem('quoteSetup',JSON.stringify(data));return{ok:true,revision:data.revision};}`,
          }));
        },
      },
    ],
  }).then((result: any) => result.outputFiles[0].contents));
}
for (const engine of [chromium, webkit])
  for (const width of [1440, 375])
    test(
      `${engine.name()} ${width}: quote-required services save, restore and complete partner setup`,
      { timeout: 60000 },
      async () => {
        const script = await compile();
        const server = createServer((request, response) => {
          if (request.url === "/client.js") {
            response.setHeader("content-type", "text/javascript");
            response.end(script);
            return;
          }
          response.setHeader("content-type", "text/html");
          response.end(
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:16px}main{max-width:900px;margin:auto}input,select,textarea{max-width:100%;box-sizing:border-box}summary,button,select{min-height:44px}label{display:block;margin:10px 0}details{border-top:1px solid #ddd;padding:8px}aside{padding:16px;background:#eee}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
          );
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const browser = await engine.launch();
        try {
          const page = await browser.newPage({
            viewport: { width, height: 950 },
          });
          page.setDefaultTimeout(7000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${address.port}`);
          const editor = page.getByRole("region", { name: "Service rates" });
          const paint = editor
            .locator("details")
            .filter({
              has: page.getByLabel("Pricing for Painting", { exact: true }),
            });
          const patch = editor
            .locator("details")
            .filter({
              has: page.getByLabel("Pricing for Drywall repair and painting", {
                exact: true,
              }),
            });
          await paint.locator("summary").click();
          await page
            .getByLabel("Pricing for Painting", { exact: true })
            .selectOption("quote_required");
          await expect(
            paint.getByText("Partners can request this service.", {
              exact: false,
            }),
          ).toBeVisible();
          await expect(
            paint.getByLabel("Rate (USD)", { exact: true }),
          ).toHaveCount(0);
          await patch.locator("summary").click();
          await page
            .getByLabel("Pricing for Drywall repair and painting", {
              exact: true,
            })
            .selectOption("quote_required");
          await editor
            .getByRole("button", { name: "Save draft", exact: true })
            .click();
          await expect(
            page.getByText(
              "Draft saved. The partner's published rates are unchanged.",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(
            page.getByText("Pricing setup incomplete", { exact: true }),
          ).toBeVisible();
          await page.reload();
          await expect(paint.locator("summary")).toContainText(
            "Quote required",
          );
          await expect(patch.locator("summary")).toContainText(
            "Quote required",
          );
          await paint.locator("summary").click();
          await page
            .getByLabel("Pricing for Painting", { exact: true })
            .selectOption("agreed_rates");
          await expect(
            paint.getByLabel("Rate (USD)", { exact: true }).first(),
          ).toHaveValue("");
          await page
            .getByLabel("Pricing for Painting", { exact: true })
            .selectOption("quote_required");
          await editor
            .getByRole("button", { name: "Publish rates", exact: true })
            .click();
          await expect(
            page.getByText("Ready to activate", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("complementary", { name: "Partner preview" }),
          ).toContainText("Quote required");
          await expect(
            page.getByRole("complementary", { name: "Partner preview" }),
          ).not.toContainText("Rate not set");
          const saved = await page.evaluate(() =>
            JSON.parse(localStorage.getItem("quoteSetup")!),
          );
          assert.deepEqual(saved.published.quoteRequiredServiceKeys.sort(), [
            "drywall-repair-paint",
            "painting",
          ]);
          assert.equal(
            saved.published.rates.some((r: any) =>
              ["painting", "drywall-repair-paint"].includes(r.serviceKey),
            ),
            false,
          );
          assert.equal(
            saved.published.rates.every((r: any) => Number(r.unitAmount) > 0),
            true,
          );
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
