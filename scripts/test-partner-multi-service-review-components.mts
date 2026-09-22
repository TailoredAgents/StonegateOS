import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { PARTNER_SERVICE_DEFINITIONS } from "../packages/pricing/src/partner-services";
import tailwindConfig from "../apps/site/tailwind.config";
const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`),
  siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteTheme = (
  "default" in tailwindConfig ? tailwindConfig.default : tailwindConfig
) as typeof tailwindConfig;
const lines = PARTNER_SERVICE_DEFINITIONS.map((service, index) => {
  const rate = {
    key: `${service.key}-rate`,
    serviceKey: service.key,
    variantKey: service.variants[0]!.key,
    label: service.label,
    unit: "job",
    unitAmount: "100",
    measurement: "Agreed synthetic job scope",
    inclusions: [],
    exclusions: [],
    materials: ["painting", "drywall-repair-paint"].includes(service.key)
      ? "stonegate"
      : null,
    coats: ["painting", "drywall-repair-paint"].includes(service.key)
      ? 2
      : null,
    fullLoadCubicYards: null,
  };
  const snapshot = {
    versionId: "44444444-4444-4444-8444-444444444444",
    currency: "USD",
    visitMinimum: "150",
    rates: [rate],
    status: "published",
  };
  return {
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    serviceKey: service.key,
    label: service.label,
    description: `Saved ${service.label} scope`,
    scope: {},
    selectedAddOns: [],
    proofRequirements: {},
    status: "pending",
    rateSnapshot: snapshot,
    currentRateSnapshot: snapshot,
    pricingSnapshot: null,
    quotedAmountCents: null,
    priceDescription: null,
  };
});
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{PartnerMultiServiceReview}from'./src/app/team/components/PartnerMultiServiceReview';import{PartnerRescheduleReviews}from'./src/app/team/components/PartnerRescheduleReviews';
window.__saves=[];window.__previews=[];window.__holdPreviews=false;window.__throwSave=false;window.__changed=0;window.__decisions=[];window.__requestAccepted=false;
const priced=new URLSearchParams(location.search).has('priced');const data={modelVersion:2,version:1,pricingVersion:1,quotedTotalCents:priced?80000:null,finalTotalCents:null,serviceLines:${JSON.stringify(lines)}.map(line=>({...line,quotedAmountCents:priced?10000:null,...(new URLSearchParams(location.search).has('quote-required')&&['painting','drywall-repair-paint'].includes(line.serviceKey)?{rateSnapshot:{...line.rateSnapshot,rates:[],status:'quote_required'},currentRateSnapshot:{...line.currentRateSnapshot,rates:[],status:'quote_required'}}:{})})),visits:new URLSearchParams(location.search).has('visit')?[{id:'66666666-6666-4666-8666-666666666666',appointmentId:'77777777-7777-4777-8777-777777777777',status:'scheduled',serviceLineIds:['11111111-1111-4111-8111-000000000001'],startAt:'2026-10-12T13:00:00Z',endAt:'2026-10-12T15:00:00Z',arrivalStartAt:'2026-10-12T13:00:00Z',arrivalEndAt:'2026-10-12T15:00:00Z',timezone:'America/New_York',version:1,minimumAmountCents:null}]:[]};
createRoot(document.getElementById('root')).render(<main className="mx-auto max-w-xl px-4 py-5">{new URLSearchParams(location.search).has('request')?<PartnerRescheduleReviews embedded canDecide accountId="22222222-2222-4222-8222-222222222222" requestId="88888888-8888-4888-8888-888888888888"/>:<PartnerMultiServiceReview accountId="22222222-2222-4222-8222-222222222222" bookingId="33333333-3333-4333-8333-333333333333" data={data} preferredWindows={[{localDate:'2026-10-12',timeOfDay:'morning'}]} canEdit onChanged={()=>{window.__changed++}}/>}</main>);`;
let compiled: Promise<{ script: Uint8Array; css: string }> | undefined;
function assets() {
  return (compiled ??= (async () => {
    const [bundle, styles] = await Promise.all([
      build({
        stdin: {
          contents: entry,
          loader: "tsx",
          resolveDir: `${repo}/apps/site`,
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
                {
                  filter:
                    /actions\/partner-(multi-service|service-reviews|reschedule-reviews)$/,
                },
                (args: any) => ({ path: args.path, namespace: "actions" }),
              );
              builder.onLoad({ filter: /.*/, namespace: "actions" }, () => ({
                loader: "js",
                contents: `
export async function loadPartnerRescheduleReviews(){return{ok:true,items:[],nextCursor:null,detail:{request:{id:'88888888-8888-4888-8888-888888888888',accountId:'22222222-2222-4222-8222-222222222222',jobId:'33333333-3333-4333-8333-333333333333',visitId:'66666666-6666-4666-8666-666666666666',appointmentId:'77777777-7777-4777-8777-777777777777',state:window.__requestAccepted?'accepted':'pending',updatedAt:'2026-09-21T12:00:00Z',createdAt:'2026-09-21T12:00:00Z',preferredWindows:[{localDate:'2026-10-14',timeOfDay:'morning'}],previousArrivalStartAt:'2026-10-12T13:00:00Z',previousArrivalEndAt:'2026-10-12T15:00:00Z',timezone:'America/New_York',siteName:'Local facility'},candidates:[],warning:null}}}
export async function decidePartnerRescheduleReview(input){window.__decisions.push(input);if(window.__throwSave){window.__throwSave=false;throw Error('synthetic transport')}window.__requestAccepted=true;return{ok:true,message:'Replacement schedule confirmed.'}}
export async function changePartnerServiceRequest(input){window.__saves.push(input);if(window.__throwSave){window.__throwSave=false;throw Error('synthetic transport failure')}return{ok:true,data:{bookingId:input.bookingId,version:input.version+1}}}
export async function loadPartnerVisitResources(){return{ok:true,resources:[{id:'55555555-5555-4555-8555-555555555555',label:'Local crew',kind:'crew'}]}}
export function previewPartnerServiceArrival(input){const result={ok:true,startAt:input.preferredDate+'T'+input.startTime+':00-04:00',arrivalStartAt:input.preferredDate+'T'+input.startTime+':00-04:00',arrivalEndAt:input.preferredDate+'T11:00:00-04:00',timezone:'America/New_York'};return new Promise(resolve=>{if(window.__holdPreviews)window.__previews.push({input,finish:()=>resolve(result)});else resolve(result)})}
`,
              }));
              builder.onResolve(
                {
                  filter:
                    /components\/StaffScheduleResourcePicker$|^\.\/StaffScheduleResourcePicker$/,
                },
                (args: any) => ({ path: args.path, namespace: "picker" }),
              );
              builder.onLoad({ filter: /.*/, namespace: "picker" }, () => ({
                loader: "js",
                contents:
                  "export function StaffScheduleResourcePicker(){return null}",
              }));
              builder.onResolve(
                { filter: /^next\/(link|navigation)$/ },
                (args: any) => ({ path: args.path, namespace: "fixture" }),
              );
              builder.onLoad(
                { filter: /.*/, namespace: "fixture" },
                (args: any) => ({
                  loader: "js",
                  resolveDir: `${repo}/apps/site`,
                  contents:
                    args.path === "next/link"
                      ? "import React from'react';export default function Link({href,children,...props}){return React.createElement('a',{...props,href},children)}"
                      : "export const useRouter=()=>({refresh(){},push(path){window.__navigation=path}});export const usePathname=()=>location.pathname;",
                }),
              );
            },
          },
        ],
      }),
      siteRequire("postcss")([
        siteRequire("tailwindcss")({
          ...siteTheme,
          content: [
            `${repo}/apps/site/src/app/partners/**/*.tsx`,
            `${repo}/apps/site/src/app/team/**/*.tsx`,
            `${repo}/packages/ui/src/**/*.tsx`,
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

for (const engine of [chromium, webkit])
  for (const width of [1440, 320])
    void test(
      `${engine.name()} ${width}px: CRM one-service price editor, current arrival preview and safe retry`,
      { timeout: 60000 },
      async () => {
        const built = await assets();
        const server = createServer((req, res) => {
          if (req.url === "/client.js") {
            res.setHeader("Content-Type", "text/javascript");
            res.end(built.script);
          } else if (req.url === "/styles.css") {
            res.setHeader("Content-Type", "text/css");
            res.end(built.css);
          } else {
            res.setHeader("Content-Type", "text/html");
            res.end(
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
          page.setDefaultTimeout(8000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${address.port}/?quote-required`);
          const pricing = page.getByRole("region", { name: "Request pricing" });
          await expect(pricing.locator("details[open]")).toHaveCount(1);
          for (const line of lines) {
            const details = pricing
              .locator("details")
              .filter({
                has: page
                  .locator(":scope > summary")
                  .filter({ hasText: line.label }),
              })
              .first();
            if (
              !(await details.evaluate((el) => (el as HTMLDetailsElement).open))
            )
              await details.locator("summary").click();
            await expect(pricing.locator("details[open]")).toHaveCount(1);
            if (
              ["painting", "drywall-repair-paint"].includes(line.serviceKey)
            ) {
              await expect(details).toContainText("Quote required");
              await expect(
                details.getByRole("link", { name: "Set company rates" }),
              ).toHaveCount(0);
              await expect(
                details.getByLabel("Agreed rate", { exact: true }),
              ).toHaveCount(0);
            }
            await details
              .getByLabel("Service total ($)", { exact: true })
              .fill("100");
          }
          await pricing
            .getByLabel("Price review note", { exact: true })
            .fill("Synthetic reviewed job scope, no real charge.");
          const directory = process.env["PARTNER_MULTI_SERVICE_PREVIEW_DIR"];
          if (directory) {
            mkdirSync(directory, { recursive: true });
            await page.screenshot({
              path: `${directory}/crm-${engine.name()}-${width}-pricing.png`,
              fullPage: true,
            });
          }
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth + 1,
            ),
            false,
          );
          await page.evaluate(() => {
            (window as any).__throwSave = true;
          });
          await page
            .getByRole("button", { name: "Confirm price", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "could not be confirmed",
          );
          await expect(
            page.getByRole("button", { name: "Confirm price", exact: true }),
          ).toBeEnabled();
          await page
            .getByRole("button", { name: "Confirm price", exact: true })
            .click();
          await expect(page.getByRole("status")).toContainText("Saved.");
          const prices = await page.evaluate(() => (window as any).__saves);
          assert.equal(prices.length, 2);
          assert.equal(prices[0].key, prices[1].key);
          assert.equal(prices[1].body.linePrices.length, 8);
          await expect(
            page.getByRole("button", { name: "Confirm price", exact: true }),
          ).toHaveCount(0);
          await page.goto(`http://127.0.0.1:${address.port}/?priced`);
          await page
            .getByRole("button", { name: "Schedule a visit", exact: true })
            .click();
          await page.evaluate(() => {
            (window as any).__holdPreviews = true;
          });
          await page
            .getByLabel("Visit date", { exact: true })
            .fill("2026-10-12");
          await expect
            .poll(() => page.evaluate(() => (window as any).__previews.length))
            .toBe(1);
          await page
            .getByLabel("Visit date", { exact: true })
            .fill("2026-10-13");
          await expect
            .poll(() => page.evaluate(() => (window as any).__previews.length))
            .toBe(2);
          await page.evaluate(() => {
            (window as any).__previews[0].finish();
          });
          await expect(
            page.getByRole("button", { name: "Confirm service", exact: true }),
          ).toBeDisabled();
          await page.evaluate(() => {
            (window as any).__previews[1].finish();
          });
          await expect(
            page.getByText("Confirm this arrival window", { exact: true }),
          ).toBeVisible();
          await page
            .getByLabel("Work duration (minutes)", { exact: true })
            .fill("120");
          await page
            .getByText("Crew, truck and equipment", { exact: true })
            .click();
          await page
            .getByRole("checkbox", { name: "Local crew · crew", exact: true })
            .check();
          if (directory)
            await page.screenshot({
              path: `${directory}/crm-${engine.name()}-${width}-schedule.png`,
              fullPage: true,
            });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth + 1,
            ),
            false,
          );
          await page.evaluate(() => {
            (window as any).__throwSave = true;
          });
          await page
            .getByRole("button", { name: "Confirm service", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "could not be confirmed",
          );
          await page
            .getByRole("button", { name: "Confirm service", exact: true })
            .click();
          await expect(page.getByRole("status")).toContainText("Saved.");
          const saves = await page.evaluate(() => (window as any).__saves);
          assert.equal(saves.length, 2);
          assert.equal(saves[0].key, saves[1].key);
          assert.equal(saves[1].body.date, "2026-10-13");
          assert.equal(saves[1].body.serviceLineIds.length, 8);
          assert.deepEqual(errors, []);
          await page.goto(`http://127.0.0.1:${address.port}/?priced&visit`);
          await page.getByText("Update this visit", { exact: true }).click();
          await page
            .getByRole("button", { name: "Change date or time", exact: true })
            .click();
          await expect(
            page.getByLabel("Visit date", { exact: true }),
          ).toHaveValue("2026-10-12");
          await expect(
            page.getByLabel("Work duration (minutes)", { exact: true }),
          ).toHaveValue("120");
          await page
            .getByLabel("Visit date", { exact: true })
            .fill("2026-10-14");
          await page
            .getByRole("button", { name: "Confirm new schedule", exact: true })
            .click();
          await expect(page.getByRole("status")).toContainText("Saved.");
          const moved = await page.evaluate(() => (window as any).__saves);
          assert.equal(moved.length, 1);
          assert.equal(moved[0].action, "visit-reschedule");
          assert.equal(
            moved[0].visitId,
            "66666666-6666-4666-8666-666666666666",
          );
          assert.equal(moved[0].body.date, "2026-10-14");
          assert.deepEqual(moved[0].body.serviceLineIds, [
            "11111111-1111-4111-8111-000000000001",
          ]);
          await page.goto(`http://127.0.0.1:${address.port}/?request`);
          const accept = page.getByRole("button", {
            name: "Accept replacement",
            exact: true,
          });
          await expect(accept).toBeDisabled();
          await page
            .getByRole("button", { name: /Use requested date/ })
            .click();
          await expect(accept).toBeEnabled();
          await page.evaluate(() => {
            (window as any).__holdPreviews = true;
          });
          await page
            .getByLabel("Replacement date", { exact: true })
            .fill("2026-10-15");
          await expect(accept).toBeDisabled();
          await expect
            .poll(() => page.evaluate(() => (window as any).__previews.length))
            .toBe(1);
          await page
            .getByLabel("Replacement date", { exact: true })
            .fill("2026-10-16");
          await expect
            .poll(() => page.evaluate(() => (window as any).__previews.length))
            .toBe(2);
          await page.evaluate(() => (window as any).__previews[0].finish());
          await expect(accept).toBeDisabled();
          await page.evaluate(() => (window as any).__previews[1].finish());
          await expect(accept).toBeEnabled();
          await page
            .getByLabel("Decision reason", { exact: true })
            .fill("Agreed replacement date for this visit only.");
          await page.evaluate(() => {
            (window as any).__throwSave = true;
          });
          await accept.click();
          await expect(
            page
              .getByRole("status")
              .filter({ hasText: "could not be confirmed" }),
          ).toBeVisible();
          await accept.click();
          await expect(
            page.getByText("This request is accepted.", { exact: true }),
          ).toBeVisible();
          const decisions = await page.evaluate(
            () => (window as any).__decisions,
          );
          assert.equal(decisions.length, 2);
          assert.deepEqual(decisions[0], decisions[1]);
          assert.equal(decisions[1].startAt, "2026-10-16T09:00:00-04:00");
          assert.deepEqual(
            decisions[1].selectedResourceIds,
            [],
            "No replacement selection preserves the current assigned resources",
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth + 1,
            ),
            false,
          );
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
