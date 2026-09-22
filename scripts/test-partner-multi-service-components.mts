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
const require = createRequire(`${repo}/package.json`);
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteTheme = (
  "default" in tailwindConfig ? tailwindConfig.default : tailwindConfig
) as typeof tailwindConfig;
const draftId = "11111111-1111-4111-8111-111111111115";
const initialDraft = {
  id: draftId,
  state: "draft",
  etag: '"draft-1"',
  revision: 1,
  modelVersion: 2,
  serviceLines: [],
  rescheduleFromJobId: null,
  additionalServiceFromJobId: null,
  locationId: "facility-address",
  serviceKey: null,
  tierKey: null,
  selectedAddOns: [],
  scope: {},
  description: null,
  crewInstructions: null,
  accessDetails: "Use the east gate.",
  onSiteContact: {
    name: "Morgan Lee",
    phone: "+14045550100",
    email: "facilities@example.test",
  },
  proofRequirements: { before: 1, after: 1, package: false },
  commercial: {},
  preferredWindows: [
    {
      localDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
      timeOfDay: "afternoon",
      timezone: "America/New_York",
    },
  ],
  scheduleAssistancePreference: "none",
  reviewReasons: [],
  validation: {},
  expiresAt: null,
  submittedAt: null,
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:00:00Z",
};
const services = PARTNER_SERVICE_DEFINITIONS.map((service) => ({
  key: service.key,
  label: service.label,
  bookable: true,
  priceState: "quote_required",
  pricingStatus: "review_required",
  agreement: null,
  inclusions: [],
  exclusions: [],
  quoteRule: null,
  baseOptions: [],
  addOns: [],
}));
const card = {
  versionId: "22222222-2222-4222-8222-222222222222",
  currency: "USD",
  visitMinimum: "150",
  rates: [
    {
      key: "pressure-standard",
      serviceKey: "pressure-washing",
      variantKey: "standard",
      label: "Hard surfaces",
      unit: "sq_ft",
      unitAmount: "0.175",
      measurement: "Actual surface washed, not property floor area",
      inclusions: ["Standard wash"],
      exclusions: ["Repairs"],
      materials: null,
      coats: null,
      fullLoadCubicYards: null,
    },
  ],
  legacyItems: [],
};
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{PartnerBookingWizard}from'./src/app/partners/components/PartnerBookingWizard';
import{PartnerMultiServiceRequestDetails}from'./src/app/partners/components/PartnerMultiServiceRequestDetails';
const draft=JSON.parse(sessionStorage.getItem('saved-v2')||'null')||${JSON.stringify(initialDraft)};
const params=new URLSearchParams(location.search);const hidden=params.has('hidden');
const detail={modelVersion:2,version:1,pricingVersion:1,quotedTotalCents:null,finalTotalCents:null,serviceLines:draft.serviceLines.map((line,index)=>({...line,label:${JSON.stringify(services)}.find(s=>s.key===line.serviceKey).label,status:index===0?'completed':'pending',rateSnapshot:null,pricingSnapshot:null,quotedAmountCents:null,priceDescription:null})),visits:params.has('scheduled')?[{id:'33333333-3333-4333-8333-333333333333',appointmentId:'44444444-4444-4444-8444-444444444444',status:params.has('change')?'scheduled':'completed',serviceLineIds:[draft.serviceLines[0].id],startAt:'2026-10-12T12:00:00Z',endAt:'2026-10-12T14:00:00Z',arrivalStartAt:'2026-10-12T12:00:00Z',arrivalEndAt:'2026-10-12T14:00:00Z',timezone:'America/New_York',version:1,minimumAmountCents:null}]:[]};

createRoot(document.getElementById('root')).render(<main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">{params.has('detail')?<PartnerMultiServiceRequestDetails request={detail} jobId="saved-job" etag={'"job-1"'} canChangeVisits={params.has('change')}/>:<PartnerBookingWizard initialDraft={params.has('new')?null:draft} defaultLocationId="facility-address" defaultServiceKey={params.has('new')?'painting':undefined} locations={[{id:'facility-address',name:'Northside facility',address:'100 Facility Drive, Atlanta, GA 30301',timezone:'America/New_York'}]} requesterContact={{name:'Morgan Lee',phone:'+14045550100',email:'facilities@example.test'}} services={${JSON.stringify(services)}} multiServiceRequestsEnabled={!params.has('gate-off')} structuredRates={hidden?null:${JSON.stringify(card)}} structuredRatesStatus={hidden?'hidden':'published'} canUploadPhotos={true} canManageLocations={false} persona="commercial_client" cancellationPolicy={{minimumNoticeMinutes:0,directCancellationEnabled:false,lateCancellationDisposition:'staff_review',automaticFeeMinor:null,source:'unconfigured',revision:null}} supportPhoneE164="+14045550100" supportPhoneDisplay="404-555-0100"/>}</main>);`;
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
  for (const width of [1440, 320]) {
    void test(
      `${engine.name()} ${width}px: one request preserves eight service scopes, shared details and rates-only review`,
      { timeout: 90_000 },
      async () => {
        const built = await assets();
        const server = createServer((request, response) => {
          if (request.url === "/client.js") {
            response.setHeader("Content-Type", "text/javascript");
            response.end(built.script);
          } else if (request.url === "/styles.css") {
            response.setHeader("Content-Type", "text/css");
            response.end(built.css);
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
            isMobile: width === 320,
            hasTouch: width === 320,
          });
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.addInitScript(
            (id) => sessionStorage.setItem(`partner-request-step:${id}`, "1"),
            draftId,
          );
          let saved: Record<string, any> = structuredClone(initialDraft);
          const patches: Record<string, any>[] = [];
          const submits: Record<string, any>[] = [];
          const visitChanges: Record<string, any>[] = [];
          let remoteErrors: Record<string, string> = {};
          let creations = 0;
          let photoRemoved = false;
          await page.route("**/api/partners/portal/**", async (route) => {
            const request = route.request(),
              path = new URL(request.url()).pathname;
            if (path.endsWith("/events"))
              return route.fulfill({ json: { ok: true } });
            if (
              path.endsWith(
                `/booking-drafts/${draftId}/media/66666666-6666-4666-8666-666666666666`,
              ) &&
              request.method() === "DELETE"
            ) {
              photoRemoved = true;
              return route.fulfill({ json: { ok: true } });
            }
            if (path.endsWith(`/booking-drafts/${draftId}/media`))
              return route.fulfill({
                json: {
                  ok: true,
                  media: photoRemoved
                    ? []
                    : [
                        {
                          id: "66666666-6666-4666-8666-666666666666",
                          category: "intake",
                          caption: null,
                          sortOrder: 0,
                          status: "ready",
                          filename: "reference.png",
                          contentType: "image/png",
                          byteSize: 100,
                          width: 1,
                          height: 1,
                          sha256: null,
                          createdAt: initialDraft.createdAt,
                          readyAt: initialDraft.createdAt,
                          error: null,
                          downloadIntent: null,
                        },
                      ],
                },
              });
            if (path.endsWith(`/booking-drafts/${draftId}/validate`))
              return route.fulfill({
                json: {
                  ok: true,
                  draft: saved,
                  validation: {
                    valid: !Object.keys(remoteErrors).length,
                    ready: !Object.keys(remoteErrors).length,
                    fieldErrors: remoteErrors,
                  },
                },
              });
            if (path.endsWith(`/booking-drafts/${draftId}/availability`))
              return route.fulfill({
                json: {
                  ok: true,
                  availability: {
                    draft: saved,
                    timezone: "America/New_York",
                    calendar: { state: "current" },
                    reviewReasons: ["manual_review_required"],
                    instantConfirmationEligible: false,
                    pricing: {
                      status: "review_required",
                      currency: "USD",
                      baseAmount: null,
                      addOnTotal: null,
                      total: null,
                      addOns: [],
                    },
                    windows: [],
                    rankedAlternatives: [],
                  },
                },
              });
            if (path.endsWith(`/booking-drafts/${draftId}/submit`)) {
              submits.push({
                body: request.postDataJSON(),
                key: request.headers()["idempotency-key"],
              });
              return route.fulfill({
                json: {
                  ok: true,
                  booking: {
                    id: "saved-job",
                    publicStatus: "requested",
                    confirmationMode: "review",
                  },
                },
              });
            }
            if (
              path.endsWith(`/booking-drafts/${draftId}`) &&
              request.method() === "PATCH"
            ) {
              const body = request.postDataJSON();
              patches.push(body);
              saved = {
                ...saved,
                ...body,
                revision: saved.revision + 1,
                etag: `"draft-${saved.revision + 1}"`,
              };
              await route.fulfill({ json: { ok: true, draft: saved } });
              await page.evaluate(
                (value) =>
                  sessionStorage.setItem("saved-v2", JSON.stringify(value)),
                saved,
              );
              return;
            }
            if (
              path.endsWith("/booking-drafts") &&
              request.method() === "POST"
            ) {
              creations++;
              saved = {
                ...structuredClone(initialDraft),
                ...request.postDataJSON(),
              };
              return route.fulfill({ json: { ok: true, draft: saved } });
            }
            if (path.endsWith("/booking-drafts"))
              return route.fulfill({
                json: { ok: true, drafts: [], page: { nextCursor: null } },
              });
            if (
              path.endsWith(
                "/jobs/saved-job/visits/33333333-3333-4333-8333-333333333333/reschedule",
              )
            ) {
              visitChanges.push({
                body: request.postDataJSON(),
                key: request.headers()["idempotency-key"],
                etag: request.headers()["if-match"],
              });
              return route.fulfill(
                visitChanges.length === 1
                  ? {
                      status: 503,
                      json: {
                        ok: false,
                        error: "service_unavailable",
                        message: "Try again with the same date.",
                      },
                    }
                  : {
                      json: {
                        ok: true,
                        reschedule: {
                          mode: "review",
                          jobId: "saved-job",
                          visitId: "33333333-3333-4333-8333-333333333333",
                          requestId: "requested-change",
                          consequence: { existingScheduleRemainsInPlace: true },
                        },
                      },
                    },
              );
            }
            throw Error(`Unexpected ${request.method()} ${path}`);
          });
          await page.goto(`http://127.0.0.1:${address.port}/`);
          const choices = page.getByRole("group", {
            name: "Services for this request",
          });
          await expect(choices.getByRole("checkbox")).toHaveCount(8);
          await expect(
            page.getByLabel("Service type", { exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByLabel("Base service option", { exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByText("Item count", { exact: true }),
          ).toHaveCount(0);
          await page
            .getByRole("button", { name: "Continue to scheduling" })
            .click();
          await expect(
            page.getByRole("link", { name: "Choose at least one service." }),
          ).toBeVisible();
          for (const definition of PARTNER_SERVICE_DEFINITIONS) {
            await choices
              .getByRole("checkbox", { name: definition.label, exact: true })
              .check();
            const editor = page.getByRole("region", {
              name: `${definition.label} details`,
            });
            await expect(editor).toBeVisible();
            await expect(
              page.getByRole("textbox", { name: "What needs to be done?" }),
            ).toHaveCount(1);
            await editor
              .getByRole("textbox", { name: "What needs to be done?" })
              .fill(`Saved ${definition.label} work`);
            for (const field of definition.scopeFields) {
              const control = editor.locator(`[id$="-${field.key}"]`);
              if (field.options)
                await control.selectOption(field.options[0]!.value);
              else await control.fill("Not sure");
            }
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth + 1,
              ),
              false,
              `${definition.key} fits viewport`,
            );
          }
          const directory = process.env["PARTNER_MULTI_SERVICE_PREVIEW_DIR"];
          if (directory) {
            await expect(
              page.getByText("Saving…", { exact: true }),
            ).toHaveCount(0);
            mkdirSync(directory, { recursive: true });
            await page.screenshot({
              path: `${directory}/portal-${engine.name()}-${width}-eight-services.png`,
              fullPage: true,
            });
          }
          await page
            .getByRole("button", {
              name: "Edit Pressure washing details",
              exact: true,
            })
            .click();
          await expect(
            page.getByText("$0.175 / square foot", { exact: true }),
          ).toBeVisible();
          await expect(page.getByText(/Actual surface washed/)).toBeVisible();
          await expect(page.getByText(/Visit minimum: \$150.00/)).toBeVisible();
          await page
            .getByRole("button", { name: "Edit Painting details", exact: true })
            .click();
          await expect(page.getByText(/Rate not set yet/)).toBeVisible();
          await choices
            .getByRole("checkbox", { name: "Painting", exact: true })
            .uncheck();
          await choices
            .getByRole("checkbox", { name: "Painting", exact: true })
            .check();
          await expect(
            page.getByRole("textbox", { name: "What needs to be done?" }),
          ).toHaveValue("Saved Painting work");
          await expect(page.locator('[id$="-surfaces"]')).toHaveValue(
            "Not sure",
          );
          await page
            .getByText("For services (optional)", { exact: true })
            .click();
          const photoServices = page.getByRole("group", {
            name: "Services shown in reference.png",
            exact: true,
          });
          await photoServices
            .getByRole("checkbox", { name: "Painting", exact: true })
            .check();
          await choices
            .getByRole("checkbox", { name: "Painting", exact: true })
            .uncheck();
          await choices
            .getByRole("checkbox", { name: "Painting", exact: true })
            .check();
          await expect(
            photoServices.getByRole("checkbox", {
              name: "Painting",
              exact: true,
            }),
          ).not.toBeChecked();
          await photoServices
            .getByRole("checkbox", { name: "Junk removal", exact: true })
            .check();

          await page
            .getByRole("button", { name: "Continue to scheduling" })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Scheduling",
              exact: true,
            }),
          ).toBeVisible();
          assert.equal(saved.modelVersion, 2);
          assert.equal(saved.serviceKey, null);
          assert.equal(saved.tierKey, null);
          assert.deepEqual(saved.selectedAddOns, []);
          assert.equal(saved.serviceLines.length, 8);
          assert.equal(
            new Set(saved.serviceLines.map((line: any) => line.id)).size,
            8,
          );
          assert.ok(
            saved.serviceLines.every(
              (line: any) => Object.keys(line.proofRequirements).length === 0,
            ),
          );
          assert.equal(saved.proofRequirements.before, 1);
          const preserved = structuredClone(saved.serviceLines);
          assert.deepEqual(saved.scope.photoServiceAssociations, {
            "66666666-6666-4666-8666-666666666666": [
              saved.serviceLines.find(
                (line: any) => line.serviceKey === "junk-removal",
              ).id,
            ],
          });

          await page.getByRole("button", { name: "Back", exact: true }).click();
          await expect(
            choices.getByRole("checkbox", { checked: true }),
          ).toHaveCount(8);
          assert.deepEqual(saved.serviceLines, preserved);
          await page
            .getByRole("button", { name: "Remove", exact: true })
            .click();
          await expect.poll(() => photoRemoved).toBe(true);
          await expect
            .poll(
              () =>
                Object.keys(saved.scope.photoServiceAssociations ?? {}).length,
            )
            .toBe(0);
          // A server error for a collapsed service must reopen and focus its input.
          remoteErrors = {
            "serviceLines.0.scope.approximateAmount": "Check the junk amount.",
          };
          await page
            .getByRole("button", { name: "Continue to scheduling" })
            .click();
          await page
            .getByRole("link", { name: "Check the junk amount." })
            .click();
          await expect(
            page.locator('[id$="-approximateAmount"]'),
          ).toBeFocused();
          remoteErrors = {};
          await page
            .getByRole("button", { name: "Continue to scheduling" })
            .click();
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Review and submit",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText("Requested services", { exact: true }),
          ).toBeVisible();
          await expect(page.getByText("Saving…", { exact: true })).toHaveCount(
            0,
          );
          if (directory)
            await page.screenshot({
              path: `${directory}/portal-${engine.name()}-${width}-review.png`,
              fullPage: true,
            });
          for (const definition of PARTNER_SERVICE_DEFINITIONS)
            await expect(
              page.getByRole("heading", {
                name: definition.label,
                exact: true,
              }),
            ).toBeVisible();
          await expect(page.getByText("Total", { exact: true })).toHaveCount(0);
          await expect(page.getByText(/estimate/i)).toHaveCount(0);
          await expect(
            page.getByText(
              "Stonegate will confirm the date and time of each visit.",
              {
                exact: true,
              },
            ),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Send service request", exact: true })
            .click();
          await expect.poll(() => submits.length).toBe(1);
          assert.deepEqual(submits[0]!.body, { submissionMode: "review" });
          assert.ok(submits[0]!.key);
          // An existing v2 draft remains editable when the creation gate is disabled.
          await page.goto(`http://127.0.0.1:${address.port}/?gate-off&hidden`);
          await expect(
            choices.getByRole("checkbox", { checked: true }),
          ).toHaveCount(8);
          await page
            .getByRole("button", {
              name: "Edit Pressure washing details",
              exact: true,
            })
            .click();
          await expect(
            page.getByText(/Account rates are available to authorized/),
          ).toBeVisible();
          await expect(
            page.getByText("$0.175 / square foot", { exact: true }),
          ).toHaveCount(0);
          assert.deepEqual(saved.serviceLines, preserved);
          assert.equal(creations, 0);
          assert.ok(patches.length > 0);
          assert.deepEqual(errors, []);
          await page.goto(`http://127.0.0.1:${address.port}/?detail`);
          await expect(
            page.getByText(/No visits are scheduled yet/),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", {
              name: "Requested services",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText("Awaiting scheduling", { exact: true }),
          ).toHaveCount(7);
          await page.goto(`http://127.0.0.1:${address.port}/?detail&scheduled`);
          await expect(
            page.getByRole("heading", { name: "Visit 1", exact: true }),
          ).toBeVisible();
          await expect(page.getByText(/Arrival: Oct 12, 2026/)).toBeVisible();
          await expect(
            page.getByText("Awaiting scheduling", { exact: true }),
          ).toHaveCount(7);
          await expect(page.getByText("Total", { exact: true })).toHaveCount(0);
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth + 1,
            ),
            false,
          );
          await page.goto(
            `http://127.0.0.1:${address.port}/?detail&scheduled&change`,
          );
          await page
            .getByText("Request a different date", { exact: true })
            .click();
          await page
            .getByLabel("Preferred date", { exact: true })
            .fill("2026-10-20");
          await page
            .getByLabel("Preferred time", { exact: true })
            .selectOption("afternoon");
          await page
            .getByRole("button", { name: "Request date change", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "Try again with the same date.",
          );
          await page
            .getByRole("button", { name: "Request date change", exact: true })
            .click();
          await expect(page.getByRole("status")).toContainText(
            "confirmed schedule stays in place",
          );
          assert.equal(visitChanges.length, 2);
          assert.deepEqual(
            visitChanges[0],
            visitChanges[1],
            "An uncertain result retries the same visit, revision, payload and operation key",
          );
          assert.equal(visitChanges[0].etag, '"job-1"');
          assert.deepEqual(visitChanges[0].body, {
            preferredWindows: [
              {
                localDate: "2026-10-20",
                timeOfDay: "afternoon",
                timezone: "America/New_York",
              },
            ],
          });
          await expect(
            page.getByRole("button", {
              name: "Request date change",
              exact: true,
            }),
          ).toHaveCount(0);
          await page.goto(`http://127.0.0.1:${address.port}/?new`);
          await expect.poll(() => creations).toBe(1);
          assert.equal(saved.modelVersion, 2);
          assert.equal(saved.serviceLines.length, 1);
          assert.equal(saved.serviceLines[0].serviceKey, "painting");
          assert.equal(saved.serviceKey, null);
          assert.deepEqual(saved.selectedAddOns, []);
          assert.deepEqual(errors, []);
          await page.close();
        } finally {
          await browser.close();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  }
